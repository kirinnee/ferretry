import type { HarnessLaunchSettings } from '@ferretry/core-ferrets/contract';
import type { ConfigFileDef, FerretId } from '@ferretry/kernel/contract';
import {
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_LAUNCH_SETTINGS,
  CLAUDE_CODE_HOOKS,
  CLAUDE_CODE_SETTINGS,
  type HarnessConfig,
} from '../../../contract/index.ts';
import { isConversationId } from '../../lib/harness/claude-path.ts';
import {
  compareLaunchSettings,
  type LaunchSettingsInputs,
  launchSettingsRecord,
} from '../../lib/harness/launch-settings.ts';
import type { ClaudeCore, Serves } from './core.ts';

/** A launch record is four fingerprints (~330 bytes); one larger than this is not one, and is never read. */
const MAX_LAUNCH_RECORD_BYTES = 4 * 1024;
const UNKNOWN_LAUNCH: HarnessLaunchSettings = { kind: 'unknown' };

const configFile = CLAUDE_CODE_CONFIG as unknown as ConfigFileDef<HarnessConfig>;
const settingsCollection = CLAUDE_CODE_SETTINGS as never;
const hooksCollection = CLAUDE_CODE_HOOKS as never;

/** The settings a launch now runs under, from this plugin's own configuration (the effort is the launch's, not here). */
export async function launchInputs(
  core: ClaudeCore,
  runtime: string | undefined,
): Promise<
  LaunchSettingsInputs & {
    readonly dangerousRmWaiver: boolean;
    readonly channels?: boolean;
  }
> {
  const selected = await core.deps.selected(runtime);
  const only = <T>(items: ReadonlyMap<string, T>, names: ReadonlySet<string>): ReadonlyMap<string, T> =>
    new Map([...items].filter(([name]) => names.has(name)));
  const file = core.deps.config.file(configFile);
  return {
    permissionMode: file?.permissionMode ?? 'skip',
    // In the record, but only as its effect on the fixed layer (setting on AND bypass mode): see launchSettingsRecord.
    dangerousRmWaiver: file?.dangerousRmWaiver ?? false,
    // Outside the recorded launch settings too: the channel is decided per launch (setting, else the login's type).
    ...(file?.channels === undefined ? {} : { channels: file.channels }),
    settings: only(core.deps.config.collection(settingsCollection) as never, selected.settings),
    hooks: only(core.deps.config.collection(hooksCollection) as never, selected.hooks),
    ...(runtime === undefined ? {} : { runtime }),
  };
}

/**
 * Records what this launch runs under, before the process starts. A launch never fails over it: when the record
 * cannot be written, the one an earlier launch left is removed, so the answer for this process is `unknown` and
 * never an older launch's.
 */
export async function recordLaunchSettings(
  core: ClaudeCore,
  ferret: FerretId,
  inputs: LaunchSettingsInputs,
): Promise<void> {
  const record = launchSettingsRecord(inputs);
  try {
    await core.deps.state.write(CLAUDE_CODE_LAUNCH_SETTINGS, record, ferret);
  } catch {
    try {
      await core.deps.state.remove(CLAUDE_CODE_LAUNCH_SETTINGS, ferret);
      // A damaged record fails the write above (the kernel guard refuses to write over it) and the remove clears it:
      // write once more, so this launch is recorded and the answer is current now, not unknown until the next launch.
      await core.deps.state.write(CLAUDE_CODE_LAUNCH_SETTINGS, record, ferret).catch(() => undefined);
    } catch {
      // Nothing more can be done: the read then finds whatever is left, and a damaged record reads as unknown.
    }
  }
}

export const launchSettingsPart = (core: ClaudeCore): Serves<'launchSettings'> => ({
  /**
   * Whether a relaunch would run this ferret on other settings of this plugin's than its last start or resume did
   * (`Harness.launchSettings`, W2-c): the fingerprints recorded then against the ones the configuration gives now. Names
   * sections only. Total: no record, a record too large to be one, a damaged one or any failure is `unknown`, and what
   * failed is dropped unread.
   */
  async launchSettings(ferret: FerretId): Promise<HarnessLaunchSettings> {
    try {
      if (!isConversationId(ferret)) return UNKNOWN_LAUNCH;
      const size = (await core.deps.state.version(CLAUDE_CODE_LAUNCH_SETTINGS, ferret))?.size;
      if (size === undefined || size > MAX_LAUNCH_RECORD_BYTES) return UNKNOWN_LAUNCH;
      const recorded = await core.deps.state.read(CLAUDE_CODE_LAUNCH_SETTINGS, ferret);
      if (!recorded.ok || recorded.value === undefined) return UNKNOWN_LAUNCH;
      return compareLaunchSettings(
        recorded.value,
        launchSettingsRecord(await launchInputs(core, recorded.value.runtime)),
      );
    } catch {
      return UNKNOWN_LAUNCH;
    }
  },
});
