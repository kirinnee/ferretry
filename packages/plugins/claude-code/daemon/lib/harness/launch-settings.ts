import { createHash } from 'node:crypto';
import {
  HARNESS_LAUNCH_SECTIONS,
  type HarnessLaunchSection,
  type HarnessLaunchSettings,
} from '@ferretry/core-ferrets/contract';
import { canonicalJson } from '@ferretry/std';
import type { HarnessConfig, HooksItem, LaunchSettingsRecord, SettingsItem } from '../../../contract/index.ts';
import { fixedLayer } from './fixed-layer.ts';
import { settingsDocument } from './launch.ts';

/**
 * WHAT A CLAUDE CODE LAUNCH RAN UNDER, AS FINGERPRINTS (W2-c; today's `FileLaunchSettingsDigest`, `fyd.ts:8020`).
 *
 * Today hashed the login's wrapper and its fixed `--settings` file. In 5.0 neither exists: every launch writes the
 * ferret's home from THIS plugin's configuration (the permission mode, the fixed layer, the settings and hooks items),
 * so a fingerprint of each of those, taken at the launch and again now, says whether a relaunch would run on something
 * else. Pure.
 *
 * What is NOT a launch setting, and so is left out: the effort (a run property, as today's comparison left out the
 * model and effort), the instructions and parts (Ferrets' `LaunchSpec`), and the ferret's folder — the fixed layer
 * names it only to trust it, so its SHAPE is fingerprinted over a stand-in folder and no path is hashed or kept.
 */

const FOLDER_STAND_IN = '/ferret-folder';

export interface LaunchSettingsInputs {
  readonly permissionMode: HarnessConfig['permissionMode'];
  readonly settings: ReadonlyMap<string, SettingsItem>;
  readonly hooks: ReadonlyMap<string, HooksItem>;
  /** The runtime the launch ran as: kept in the record so a later comparison selects the same components. */
  readonly runtime?: string;
}

/** A SHA-256 of the value's one canonical spelling. Throws a fixed sentence: the canonical refusal may name a key. */
function fingerprint(value: unknown): string {
  const spelled = canonicalJson(value);
  if (!spelled.ok) throw new Error('a launch setting has no canonical spelling');
  return createHash('sha256').update(spelled.text, 'utf8').digest('hex');
}

/** One fingerprint per section of what a launch would run under with these inputs. */
export function launchSettingsRecord(inputs: LaunchSettingsInputs): LaunchSettingsRecord {
  const fixed = fixedLayer(inputs.permissionMode, FOLDER_STAND_IN);
  const none = new Map<string, never>();
  return {
    format: 1,
    ...(inputs.runtime === undefined ? {} : { runtime: inputs.runtime }),
    sections: {
      'permission-mode': fingerprint(inputs.permissionMode),
      'fixed-layer': fingerprint({ settings: fixed.settings, overlay: fixed.overlay }),
      settings: fingerprint(settingsDocument({ settings: inputs.settings, hooks: none })),
      hooks: fingerprint(settingsDocument({ settings: none, hooks: inputs.hooks }).hooks ?? {}),
    },
  };
}

/** The sections whose fingerprints differ, by name and in the contract's order; nothing else leaves. */
export function compareLaunchSettings(
  recorded: LaunchSettingsRecord,
  now: LaunchSettingsRecord,
): HarnessLaunchSettings {
  const drifted: HarnessLaunchSection[] = HARNESS_LAUNCH_SECTIONS.filter(
    section => recorded.sections[section] !== now.sections[section],
  );
  return drifted.length === 0 ? { kind: 'current' } : { kind: 'drifted', sections: drifted };
}
