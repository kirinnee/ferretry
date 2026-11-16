import type { FerretId } from '@ferretry/kernel/contract';
import type { HarnessLaunchSettings } from '@ferretry/core-ferrets/contract';
import { CODEX_LAUNCH_SETTINGS } from '../../../contract/index.ts';
import { compareCodexLaunchSettings, codexLaunchSettingsRecord } from '../../lib/launch-settings.ts';
import { PLAIN_FERRET, type HarnessPart } from './context.ts';

/** A launch record is two fingerprints (~180 bytes); one larger than this is not one, and is never read. */
const MAX_LAUNCH_RECORD_BYTES = 4 * 1024;
const UNKNOWN_LAUNCH: HarnessLaunchSettings = { kind: 'unknown' };

/** Whether a relaunch would run on other settings than the last launch did. */
export const launchSettingsPart: HarnessPart<'launchSettings'> = ({ kernel, permissionModeNow, settingsNow }) => {
  return {
    /**
     * Whether a relaunch would run this ferret on other settings of this plugin's than its last start or resume did
     * (`Harness.launchSettings`, W2-c). Names sections only. Total: no record, a record too large to be one, a damaged
     * one or any failure is `unknown`, and what failed is dropped unread.
     */
    async launchSettings(ferret: FerretId): Promise<HarnessLaunchSettings> {
      try {
        if (!PLAIN_FERRET.test(ferret)) return UNKNOWN_LAUNCH;
        const size = (await kernel.state.version(CODEX_LAUNCH_SETTINGS, ferret))?.size;
        if (size === undefined || size > MAX_LAUNCH_RECORD_BYTES) return UNKNOWN_LAUNCH;
        const recorded = await kernel.state.read(CODEX_LAUNCH_SETTINGS, ferret);
        if (!recorded.ok || recorded.value === undefined) return UNKNOWN_LAUNCH;
        return compareCodexLaunchSettings(
          recorded.value,
          codexLaunchSettingsRecord(
            permissionModeNow(),
            await settingsNow(recorded.value.runtime),
            recorded.value.runtime,
          ),
        );
      } catch {
        return UNKNOWN_LAUNCH;
      }
    },
  };
};
