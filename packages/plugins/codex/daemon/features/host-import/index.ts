/**
 * Codex's own write of an imported settings component (`ProfileComponentSource.put`, Runtimes' setup import).
 *
 * Runtimes never writes another plugin's file, so each imported Codex `settings` component comes here and lands as this
 * plugin's own `config/codex/settings/<name>.yaml` through the kernel's config service: the schema check, the refusal of a
 * raw secret and the hold on a loosening (a launch flag that sets the approval policy or sandbox) all still apply.
 *
 * Create only: the file is written with `ifMatch: 'absent'`, so an import never replaces an item it did not make (a name
 * taken, even a moment ago, is refused in a sentence). The sentence names rules and keys, never a value.
 */
import type { ConfigCollectionDef, ConfigPort, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import type { ComponentPutResult } from '@ferretry/plugin-runtimes/contract';
import { CODEX_SETTINGS, type SettingsItem } from '../../../contract/index.ts';
import { settingsItemFromImport } from './settings-item.ts';

/** The one write of the person's apply (`writeAsCaller`) and the only read of what exists, both over Codex's own def. */
export type HostImportConfig = Pick<ConfigPort, 'writeAsCaller' | 'collection'>;

const sentenceOf = (outcome: ConfigWriteOutcome, name: string): ComponentPutResult => {
  switch (outcome.kind) {
    case 'written':
      return { ok: true };
    case 'held':
      return { ok: true, held: true };
    case 'conflict':
      return { ok: false, reason: `a Codex settings item named "${name}" already exists` };
    case 'refused': {
      const why = outcome.issues.map(issue => issue.message).filter(message => message !== '');
      return {
        ok: false,
        reason: `Codex did not accept the settings (${outcome.reason.replaceAll('_', ' ')}${why.length === 0 ? '' : `: ${why.join('; ')}`})`,
      };
    }
  }
};

export function codexSettingsPut(
  config: HostImportConfig,
): (name: string, documentText: string) => Promise<ComponentPutResult> {
  return async (name, documentText) => {
    const made = settingsItemFromImport(documentText);
    if (!made.ok) return made;
    const taken = config.collection(CODEX_SETTINGS as ConfigCollectionDef<SettingsItem>);
    if (taken.has(name)) return { ok: false, reason: `a Codex settings item named "${name}" already exists` };
    const written = await config.writeAsCaller(CODEX_SETTINGS, name, JSON.stringify(made.item, null, 2), {
      ifMatch: 'absent',
    });
    return sentenceOf(written, name);
  };
}
