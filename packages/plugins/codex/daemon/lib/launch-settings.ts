import { createHash } from 'node:crypto';
import {
  HARNESS_LAUNCH_SECTIONS,
  type HarnessLaunchSection,
  type HarnessLaunchSettings,
} from '@ferretry/core-ferrets/contract';
import { canonicalJson } from '@ferretry/std';
import type { CodexLaunchSettingsRecord, HarnessConfig, HooksItem, SettingsItem } from '../../contract/index.ts';
import { codexFixedArguments } from './fixed-layer.ts';
import { settingsDocument, settingsFlags } from './settings.ts';

/**
 * WHAT A CODEX LAUNCH RAN UNDER, AS FINGERPRINTS (W2-c; today's `FileLaunchSettingsDigest`, `fyd.ts:8020`).
 *
 * Today hashed the login's wrapper, which carried the permission mode and the fixed launch arguments. In 5.0 this
 * plugin builds both into every launch from its own configuration, so a fingerprint of each, taken at the launch and
 * again now, says whether a relaunch would run on something else. Pure.
 *
 * Left out, as not launch settings: the model and effort (run properties, as today), the rollout correlation arguments
 * (they name the ferret's own home, which never changes), and the ferret's folder — the fixed arguments name it only to
 * trust it, so their SHAPE is fingerprinted over a stand-in folder and no path is hashed or kept.
 */

const FOLDER_STAND_IN = '/ferret-folder';

/** A SHA-256 of the value's one canonical spelling. Throws a fixed sentence: the canonical refusal may name a key. */
function fingerprint(value: unknown): string {
  const spelled = canonicalJson(value);
  if (!spelled.ok) throw new Error('a launch setting has no canonical spelling');
  return createHash('sha256').update(spelled.text, 'utf8').digest('hex');
}

/**
 * One fingerprint per section of what a launch would run under with this permission mode and these settings items
 * (`config/codex/settings/`, merged into every Codex home's `config.toml`, so a changed item is a relaunch for a running
 * ferret exactly as Claude Code's is). The `hooks` section is the hooks items (`config/codex/hooks/`) the runtime's
 * profile selects, IN THE ORDER it selects them (Runtimes merges their handlers into the runtime's `hooks.json` in that
 * order): a changed, added, removed or reordered one is a relaunch too. With none selected it is the digest of the empty
 * list. A record written before this section existed has none, and its hooks compare as unknown.
 */
export function codexLaunchSettingsRecord(
  permissionMode: HarnessConfig['permissionMode'],
  items: ReadonlyMap<string, SettingsItem>,
  hooks: readonly (readonly [string, HooksItem])[],
  runtime?: string,
): CodexLaunchSettingsRecord {
  const document = settingsDocument(items);
  const flags = settingsFlags(items);
  return {
    format: 1,
    ...(runtime === undefined ? {} : { runtime }),
    sections: {
      'permission-mode': fingerprint(permissionMode),
      'fixed-layer': fingerprint(codexFixedArguments(permissionMode, FOLDER_STAND_IN)),
      // The flags are part of what the item runs the launch under; a document with none keeps the digest it always had.
      settings: fingerprint(flags.length === 0 ? document : { document, flags }),
      // An ordered list, not a name-keyed object: the order is the merge order, and a reorder changes the hooks.json.
      hooks: fingerprint(hooks.map(([name, item]) => [name, item.hooks])),
    },
  };
}

/** The sections whose fingerprints differ, by name and in the contract's order; nothing else leaves. */
export function compareCodexLaunchSettings(
  recorded: CodexLaunchSettingsRecord,
  now: CodexLaunchSettingsRecord,
): HarnessLaunchSettings {
  const drifted: HarnessLaunchSection[] = HARNESS_LAUNCH_SECTIONS.filter(
    (section): section is keyof CodexLaunchSettingsRecord['sections'] => section in now.sections,
  ).filter(section => {
    const before = recorded.sections[section];
    // A section the record never had (hooks, before this change) is unknown, not drifted, until the next launch writes it.
    return before !== undefined && before !== now.sections[section];
  });
  return drifted.length === 0 ? { kind: 'current' } : { kind: 'drifted', sections: drifted };
}
