/**
 * Claude Code's door for an imported settings component (r9 A6): the owner side of Runtimes' `ProfileComponentSource.put`.
 *
 * It writes `config/claude-code/settings/<name>.yaml` through the kernel's config service (`ConfigPort.write`), so the
 * schema check, the refusal of a raw secret and the hold on a loosening (a launch flag that loosens the permission mode)
 * all still apply. It never replaces an item it did not make: the write is create-only (`ifMatch: 'absent'`). The ONE
 * exception is an update the person accepted (`options.replace`): the item is replaced, pinned to its current etag, but
 * only while its file still has the etag the import left (`options.etags`); one made again by hand is left as it is.
 *
 * The answer is a sentence naming files, keys and rules; never a value.
 */
import type { ComponentPutResult, ProfileComponentSource } from '@ferretry/plugin-runtimes/contract';
import type { ConfigCollectionDef, ConfigPort } from '@ferretry/kernel/contract';
import type { SettingsItem } from '../../../contract/index.ts';
import { importedSettings } from './settings-document.ts';

export interface HostImportPorts {
  readonly def: ConfigCollectionDef<SettingsItem>;
  readonly config: Pick<ConfigPort, 'collection' | 'write' | 'etag'>;
}

const refused = (reason: string): ComponentPutResult => ({ ok: false, reason });

export function claudeSettingsPut(ports: HostImportPorts): NonNullable<ProfileComponentSource['put']> {
  return async (name, documentText, _files, options) => {
    const made = importedSettings(documentText);
    if (!made.ok) return refused(made.reason);
    const taken = ports.config.collection(ports.def).has(name);
    const current = options?.replace === true && taken ? await ports.config.etag(ports.def, name) : '';
    if (taken && (current === '' || options?.etags?.[name] !== current)) {
      return refused(
        'a Claude Code settings item by that name already exists and is not as an import left it, so it was left as it is',
      );
    }
    const outcome = await ports.config.write(ports.def, name, JSON.stringify(made.item, null, 2), {
      ifMatch: taken ? current : 'absent',
    });
    switch (outcome.kind) {
      case 'written':
      case 'held':
        // What was kept out rides back as warnings (keys and reasons, never a value): the apply answer says them.
        return {
          ok: true,
          ...(outcome.kind === 'held' ? { held: true as const } : {}),
          etags: { [name]: outcome.etag },
          ...(made.dropped.length === 0 ? {} : { warnings: made.dropped }),
        };
      case 'conflict':
        return refused('a Claude Code settings item by that name already exists; an import never replaces one');
      case 'refused':
        return refused(
          outcome.reason === 'raw_secret'
            ? 'it holds a value that looks like a secret; a secret must be a ${secret:NAME} reference'
            : `Claude Code settings did not accept it (${outcome.reason}${outcome.issues.length === 0 ? '' : `: ${outcome.issues.map(issue => `${issue.path} ${issue.message}`).join(', ')}`})`,
        );
    }
  };
}
