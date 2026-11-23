import type { FerretId } from '@ferretry/kernel/contract';
import {
  compactionExtrasOf,
  type LaunchSpec,
  type Runner,
  type RunnerHandle,
  type RunSpec,
  type Started,
  type StartRefusal,
} from '@ferretry/core-ferrets/contract';
import { err, ok, type Result } from '@ferretry/std';
import { buildCodexLaunchArgv, codexCompactPrompt } from '../../lib/index.ts';
import { settingsFlags } from '../../lib/settings.ts';
import { CODEX_LAUNCH_SETTINGS, type HarnessConfig } from '../../../contract/index.ts';
import { CODEX_QUESTIONS_OFF, codexFixedArguments, codexPermissionArguments } from '../../lib/fixed-layer.ts';
import { codexLaunchSettingsRecord } from '../../lib/launch-settings.ts';
import { codexCorrelationArguments } from '../../lib/transcript/rollout.ts';
import type { HarnessPart } from './context.ts';

/** The Vault-resolved environment a launch passes on unopened. */
type ChildEnvironment = RunSpec['env'];

/** Starting, resuming and stopping a ferret through whichever runner Ferrets hands over. */
export const lifecyclePart: HarnessPart<'start' | 'resume' | 'stop'> = ({
  kernel,
  locate,
  permissionModeNow,
  settingsNow,
  hooksNow,
  rollouts,
  ensureHome,
  poolHistory,
  options,
}) => {
  /**
   * `CODEX_HOME` (and, for a pooled ferret, `CODEX_SQLITE_HOME`) is set by an `env` prefix: the Vault's environment is an
   * opaque handle this code cannot add to.
   */
  const command = async (
    spec: LaunchSpec,
    executable: string,
    permissionMode: HarnessConfig['permissionMode'],
    sqliteHome: string | undefined,
    resume?: string,
  ): Promise<readonly string[]> => {
    const items = await settingsNow(spec.runtime);
    // Priority is the paid tier: it goes on the argv only for a model the held catalog says has it. `false` (the default
    // tier) costs nothing extra, so it is passed as asked.
    const fast =
      spec.options?.fast === true && !(await options.fastVerified?.(spec.model)) ? undefined : spec.options?.fast;
    return [
      'env',
      `CODEX_HOME=${spec.home}`,
      ...(sqliteHome === undefined ? [] : [`CODEX_SQLITE_HOME=${sqliteHome}`]),
      ...buildCodexLaunchArgv({
        executable,
        settingsFlags: settingsFlags(items),
        compactPrompt: codexCompactPrompt(spec.ferret, compactionExtrasOf(spec.parts)),
        harnessFlags: [
          ...codexPermissionArguments(permissionMode),
          ...codexFixedArguments(permissionMode, spec.folder),
          ...codexCorrelationArguments(spec.home),
          ...CODEX_QUESTIONS_OFF,
        ],
        ...(resume === undefined ? {} : { resume }),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.effort === undefined ? {} : { effort: spec.effort }),
        // The recorded start's fast mode, on every launch (a start, a resume, a revive all rebuild the spec from the
        // ferret's details). Unset (or priority nobody verified) passes nothing, so Codex's own tier stays in charge.
        ...(fast === undefined ? {} : { fast }),
      }),
    ];
  };

  const launch = async (
    spec: LaunchSpec,
    runner: Runner,
    env: ChildEnvironment,
    harnessConversation?: string,
  ): Promise<Result<Started, StartRefusal>> => {
    // ONE read of the permission mode per launch: the argv and the record describe the same setting.
    const permissionMode = permissionModeNow();
    const location = await locate();
    if (location.outcome !== 'located') return err('unavailable');
    await ensureHome(spec);
    const sqliteHome = await poolHistory(spec.ferret);
    const argv = await command(spec, location.path, permissionMode, sqliteHome, harnessConversation);
    await rollouts.launched(spec, harnessConversation);
    await recordLaunchSettings(spec.ferret, permissionMode, spec.runtime);
    const running =
      harnessConversation === undefined
        ? await runner.start({ ferret: spec.ferret, command: argv, cwd: spec.folder, env })
        : await runner.resume({ ferret: spec.ferret, command: argv, cwd: spec.folder, env }, harnessConversation);
    if (!running.ok) return running;
    // Codex mints its own conversation id after launch; Conversation finds it, so none is claimed here.
    return ok({ running: running.value, ...(harnessConversation === undefined ? {} : { harnessConversation }) });
  };

  /**
   * Records what this launch runs under, before the process starts (W2-c). A launch never fails over it: when the record
   * cannot be written, the one an earlier launch left is removed, so the answer for this process is `unknown` and never
   * an older launch's.
   */
  const recordLaunchSettings = async (
    ferret: FerretId,
    permissionMode: HarnessConfig['permissionMode'],
    runtime: string | undefined,
  ): Promise<void> => {
    const record = codexLaunchSettingsRecord(
      permissionMode,
      await settingsNow(runtime),
      await hooksNow(runtime),
      runtime,
    );
    try {
      await kernel.state.write(CODEX_LAUNCH_SETTINGS, record, ferret);
    } catch {
      try {
        await kernel.state.remove(CODEX_LAUNCH_SETTINGS, ferret);
        // A damaged record fails the write above (the kernel guard refuses to write over it) and the remove clears it:
        // write once more, so this launch is recorded and the answer is current now, not unknown until the next launch.
        await kernel.state.write(CODEX_LAUNCH_SETTINGS, record, ferret).catch(() => undefined);
      } catch {
        // Nothing more can be done: the read then finds whatever is left, and a damaged record reads as unknown.
      }
    }
  };

  return {
    start: async (spec, runner, env) => await launch(spec, runner, env),
    resume: async (spec, runner, env, harnessConversation) => await launch(spec, runner, env, harnessConversation),

    async stop(ferret: FerretId, handle: RunnerHandle, runner: Runner, how: 'polite' | 'now'): Promise<void> {
      try {
        // The handle is a pane id, which names another ferret's pane once the server has restarted: stop only THIS ferret's.
        await runner.stop(handle, how, ferret);
      } finally {
        // What was proved about this ferret's rollout is only a cache: a stopped ferret keeps none, and a read that
        // comes later proves it afresh.
        rollouts.forget(ferret);
      }
    },
  };
};
