import type { FerretId } from '@ferretry/kernel/contract';
import type { LaunchSpec, Runner, RunnerHandle, RunSpec, Started, StartRefusal } from '@ferretry/core-ferrets/contract';
import { err, ok, type Result } from '@ferretry/std';
import { buildCodexLaunchArgv, CODEX_COMPACT_PROMPT } from '../../lib/index.ts';
import { settingsFlags } from '../../lib/settings.ts';
import { CODEX_LAUNCH_SETTINGS, type HarnessConfig } from '../../../contract/index.ts';
import { codexFixedArguments, codexPermissionArguments, codexQuestionArguments } from '../../lib/fixed-layer.ts';
import { codexLaunchSettingsRecord } from '../../lib/launch-settings.ts';
import { codexCorrelationArguments } from '../../lib/transcript/rollout.ts';
import type { HarnessPart } from './context.ts';

/** The Vault-resolved environment a launch passes on unopened. */
type ChildEnvironment = RunSpec['env'];

/** Starting, resuming and stopping a ferret through whichever runner Ferrets hands over. */
export const lifecyclePart: HarnessPart<'start' | 'resume' | 'stop'> = ({
  options,
  kernel,
  locate,
  permissionModeNow,
  settingsNow,
  hooksNow,
  rollouts,
  ensureHome,
  poolHistory,
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
    return [
      'env',
      `CODEX_HOME=${spec.home}`,
      ...(sqliteHome === undefined ? [] : [`CODEX_SQLITE_HOME=${sqliteHome}`]),
      ...buildCodexLaunchArgv({
        executable,
        settingsFlags: settingsFlags(items),
        compactPrompt: CODEX_COMPACT_PROMPT,
        harnessFlags: [
          ...codexPermissionArguments(permissionMode),
          ...codexFixedArguments(permissionMode, spec.folder),
          ...codexCorrelationArguments(spec.home),
          ...codexQuestionArguments(spec.mode, options.questionTool?.() ?? false),
        ],
        ...(resume === undefined ? {} : { resume }),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.effort === undefined ? {} : { effort: spec.effort }),
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
        await runner.stop(handle, how);
      } finally {
        // What was proved about this ferret's rollout is only a cache: a stopped ferret keeps none, and a read that
        // comes later proves it afresh.
        rollouts.forget(ferret);
      }
    },
  };
};
