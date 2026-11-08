import { createHash } from 'node:crypto';
import {
  HARNESS_LAUNCH_SECTIONS,
  type HarnessLaunchSection,
  type HarnessLaunchSettings,
} from '@ferretry/core-ferrets/contract';
import { canonicalJson } from '@ferretry/std';
import type { CodexLaunchSettingsRecord, HarnessConfig } from '../../contract/index.ts';
import { codexFixedArguments } from './fixed-layer.ts';

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

/** One fingerprint per section of what a launch would run under with this permission mode. */
export function codexLaunchSettingsRecord(permissionMode: HarnessConfig['permissionMode']): CodexLaunchSettingsRecord {
  return {
    format: 1,
    sections: {
      'permission-mode': fingerprint(permissionMode),
      'fixed-layer': fingerprint(codexFixedArguments(permissionMode, FOLDER_STAND_IN)),
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
  ).filter(section => recorded.sections[section] !== now.sections[section]);
  return drifted.length === 0 ? { kind: 'current' } : { kind: 'drifted', sections: drifted };
}
