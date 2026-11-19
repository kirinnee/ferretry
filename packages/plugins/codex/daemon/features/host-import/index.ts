/**
 * Codex's own write of an imported settings component (`ProfileComponentSource.put`, Runtimes' setup import).
 *
 * Runtimes never writes another plugin's file, so each imported Codex `settings` component comes here and lands as this
 * plugin's own files under `config/codex/settings/` through the kernel's config service: the schema check, the refusal of
 * a raw secret and the hold on a loosening (a launch flag that sets the approval policy or sandbox) all still apply.
 *
 * One component can become several items (`settings-item.ts`): the main settings item under the component's name, and
 * one `profile-<name>` item for each Codex profile the person chose. The answer is one result: it fails only when NOTHING
 * was written; an item that could not be written (a name taken) comes back as a warning beside the ones that were.
 *
 * Create only: every file is written with `ifMatch: 'absent'`, so an import never replaces an item it did not make (a
 * name taken, even a moment ago, is refused in a sentence). The ONE exception is an update the person accepted
 * (`options.replace`): each item an import made (the component's own item, or one `options.owned` names) is then
 * replaced, pinned to its current etag; an item that exists and was NOT brought in by an import is left exactly as it is,
 * in a sentence. The sentences name rules and keys, never a value.
 */
import type { ConfigCollectionDef, ConfigPort, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import type { ComponentPutOptions, ComponentPutResult } from '@ferretry/plugin-runtimes/contract';
import { CODEX_SETTINGS, type SettingsItem } from '../../../contract/index.ts';
import { settingsItemsFromImport } from './settings-item.ts';

/** The one write of the person's apply (`writeAsCaller`) and the only read of what exists, both over Codex's own def. */
export type HostImportConfig = Pick<ConfigPort, 'writeAsCaller' | 'collection' | 'etag'>;

type ItemAnswer = { readonly wrote: true; readonly held: boolean } | { readonly wrote: false; readonly reason: string };

const taken = (name: string): ItemAnswer => ({
  wrote: false,
  reason: `a Codex settings item named "${name}" already exists`,
});

const answerOf = (outcome: ConfigWriteOutcome, name: string): ItemAnswer => {
  switch (outcome.kind) {
    case 'written':
      return { wrote: true, held: false };
    case 'held':
      return { wrote: true, held: true };
    case 'conflict':
      return taken(name);
    case 'refused': {
      const why = outcome.issues.map(issue => issue.message).filter(message => message !== '');
      return {
        wrote: false,
        reason: `Codex did not accept the settings (${outcome.reason.replaceAll('_', ' ')}${why.length === 0 ? '' : `: ${why.join('; ')}`})`,
      };
    }
  }
};

export function codexSettingsPut(
  config: HostImportConfig,
): (name: string, documentText: string, files?: unknown, options?: ComponentPutOptions) => Promise<ComponentPutResult> {
  return async (name, documentText, _files, options) => {
    const made = settingsItemsFromImport(name, documentText);
    if (!made.ok) return made;
    const existing = config.collection(CODEX_SETTINGS as ConfigCollectionDef<SettingsItem>);
    const warnings = [...made.warnings];
    const failures: string[] = [];
    const wroteNames: string[] = [];
    const kept: string[] = [];
    let wrote = 0;
    let held = false;
    for (const { name: itemName, item } of made.items) {
      const replacing =
        options?.replace === true &&
        existing.has(itemName) &&
        (itemName === name || (options.owned ?? []).includes(itemName));
      if (options?.replace === true && existing.has(itemName) && !replacing) {
        kept.push(`${itemName} already exists and was not brought in by an import, so it was left as it is`);
        continue;
      }
      const answer =
        existing.has(itemName) && !replacing
          ? taken(itemName)
          : answerOf(
              await config.writeAsCaller(CODEX_SETTINGS, itemName, JSON.stringify(item, null, 2), {
                ifMatch: replacing ? await config.etag(CODEX_SETTINGS, itemName) : 'absent',
              }),
              itemName,
            );
      if (!answer.wrote) failures.push(answer.reason);
      else {
        wrote += 1;
        wroteNames.push(itemName);
        held ||= answer.held;
      }
    }
    if (wrote === 0) return { ok: false, reason: [...failures, ...kept].join('; ') };
    return {
      ok: true,
      ...(held ? { held: true as const } : {}),
      created: wroteNames,
      ...(failures.length + warnings.length + kept.length === 0
        ? {}
        : { warnings: [...warnings, ...kept, ...failures.map(reason => `Not imported: ${reason}`)] }),
    };
  };
}
