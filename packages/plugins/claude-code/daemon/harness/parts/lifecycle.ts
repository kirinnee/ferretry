import type {
  HarnessInstall,
  HarnessMissing,
  LaunchSpec,
  Runner,
  RunnerHandle,
  Started,
  StartRefusal,
  UpdateResult,
} from '@ferretry/core-ferrets/contract';
import type { ChildEnvironment, FerretId } from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import { isConversationId } from '../../lib/harness/claude-path.ts';
import { API_KEY_SEED_SHELL } from '../../lib/harness/api-key-seed.ts';
import { channelsOn, HOME_FILES, launchCommand, settingsFlags } from '../../lib/harness/launch.ts';
import { HarnessUpdateRefusal } from '../../lib/update/service.ts';
import { type ClaudeCore, claudeHome, fenced, type Serves } from './core.ts';
import { prepareHomeFrom, requirePrivateChain } from './home.ts';
import { launchInputs, recordLaunchSettings } from './launch-settings.ts';

export const lifecyclePart = (core: ClaudeCore): Serves<'discover' | 'resume' | 'start' | 'stop' | 'update'> => {
  async function discover(): Promise<HarnessInstall | HarnessMissing> {
    const location = await core.deps.location.locate();
    if (location.outcome === 'absent')
      return { found: false, reason: `claude was not found (looked in: ${location.searched.join(', ')})` };
    if (location.outcome === 'override-absent')
      return { found: false, reason: `${location.declaredBy} names ${location.path}, but ${location.reason}` };
    const version = await core.deps.probe.version(location.path);
    if (version.state !== 'ok') return { found: false, reason: `claude at ${location.path}: ${version.reason}` };
    return { found: true, binary: location.path, version: version.version };
  }

  async function launch(
    spec: LaunchSpec,
    runner: Runner,
    env: ChildEnvironment,
    conversation: { readonly kind: 'new' | 'resume'; readonly id: string },
  ): Promise<Result<Started, StartRefusal>> {
    if (!isConversationId(conversation.id)) throw new Error('the conversation id must be one plain name (S45)');
    const found = await discover();
    if (!found.found) return err('unavailable');
    // ONE read of the configuration per launch: the home, the argv and the record all describe the same settings, so a
    // reload between them cannot leave a record that differs from what the process runs on.
    const inputs = await launchInputs(core, spec.runtime);
    await prepareHomeFrom(core, spec, inputs, found.version);
    const channels = channelsOn(inputs.channels, spec.parts);
    const command = launchCommand({
      binary: found.binary,
      flags: settingsFlags(inputs.settings),
      home: spec.home,
      permissionMode: inputs.permissionMode,
      model: spec.model,
      hasMcp: spec.parts.some(part => part.kind === 'mcp'),
      channels,
      dangerousRmWaiver: inputs.dangerousRmWaiver,
      conversation,
      readable: spec.readable,
    });
    // What the pane runs as it execs on: `env`, the seed shell, then Claude (a first turn is typed only into that chain).
    const execChain = [API_KEY_SEED_SHELL, found.binary].map(path => path.slice(path.lastIndexOf('/') + 1));
    const spec2 = { ferret: spec.ferret, command, cwd: spec.folder, env, execChain: ['env', ...execChain] };
    await recordLaunchSettings(core, spec.ferret, inputs);
    // Persist only the identity and cwd we chose, so a fresh daemon reads the same exact transcript.
    const home = claudeHome(core, spec.ferret);
    await home.writeText(
      fenced(home.resolve(HOME_FILES.conversation)),
      `${JSON.stringify({ format: 1, id: conversation.id, cwd: spec.folder })}\n`,
    );
    // Checked again immediately before the runner is asked: a folder made writable since the write is seen here.
    await requirePrivateChain(home);
    const started = await runner.start(spec2);
    if (!started.ok) return started;
    core.deps.panes.remember(spec.ferret, started.value.handle);
    // Loading Ferretry's channel makes Claude Code ask "Loading development channels" on EVERY launch. Only a first turn's
    // delivery answered it, so a ferret started with no prompt (the app's New ferret) sat at that confirm and every
    // message sent to it was held behind it. It is answered here, before the start is reported, and nothing else is: any
    // other dialog is left for a person. A pane that never shows it, or a runner that cannot look, changes nothing.
    if (channels) await runner.answerDevChannels?.(started.value.handle, spec.ferret).catch(() => undefined);
    return ok({ running: started.value, harnessConversation: conversation.id });
  }

  return {
    discover,

    async update(): Promise<UpdateResult> {
      try {
        await core.deps.update.start({});
        await core.deps.update.settled();
      } catch (error) {
        if (error instanceof HarnessUpdateRefusal) return { updated: false, sentence: error.message };
        throw error;
      }
      const job = (await core.deps.update.view()).job;
      if (job?.state !== 'finished') return { updated: false, sentence: 'The update did not finish.' };
      const report = job.report;
      return {
        updated: report.outcome === 'succeeded',
        ...(report.to === undefined ? {} : { version: report.to }),
        sentence: report.message,
      };
    },

    async start(spec: LaunchSpec, runner: Runner, env: ChildEnvironment): Promise<Result<Started, StartRefusal>> {
      return await launch(spec, runner, env, { kind: 'new', id: core.deps.newConversationId() });
    },

    async resume(
      spec: LaunchSpec,
      runner: Runner,
      env: ChildEnvironment,
      harnessConversation: string,
    ): Promise<Result<Started, StartRefusal>> {
      return await launch(spec, runner, env, { kind: 'resume', id: harnessConversation });
    },

    async stop(ferret: FerretId, handle: RunnerHandle, runner: Runner, how: 'polite' | 'now'): Promise<void> {
      core.deps.panes.remember(ferret, handle);
      // The handle is a pane id, which names another ferret's pane once the server has restarted: stop only THIS ferret's.
      try {
        await runner.stop(handle, how, ferret);
      } finally {
        // A stop that throws must not leave a stale record of this ferret's pane behind.
        core.deps.panes.forget(ferret);
      }
    },
  };
};
