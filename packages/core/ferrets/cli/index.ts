import { randomUUID } from 'node:crypto';
import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { ClientRestartGateway, ClientSessionApi } from './lib/client.ts';
import { instructionsReport, renderInstructionsReport } from '../contract/instructions-report.ts';
import { moveOptions } from './lib/move/commands.ts';
import { MoveController } from './lib/move/controller.ts';
import { ClientMoveGateway } from './lib/move/gateway.ts';
import { NO_PROGRESS, PlainProgress } from './lib/progress/index.ts';
import { RestartController } from './lib/restart/controller.ts';
import { SessionCommandError } from './lib/session/errors.ts';
import { ResumeSessionController } from './lib/session/lifecycle-controllers.ts';
import { SuggestNamesController } from './lib/session/name-controller.ts';
import { PinAgentController } from './lib/session/pin-agent.ts';
import type { SessionEnvironment } from './lib/session/ports.ts';
import { SessionPresenter } from './lib/session/presenter.ts';
import { ListSessionsController } from './lib/session/ps-controller.ts';
import { RenameSessionController } from './lib/session/rename-controller.ts';
import { RevokeCredentialController } from './lib/session/revoke-credential.ts';
import { SignalSessionController } from './lib/session/signal-controller.ts';
import { StartSessionController } from './lib/session/start-controller.ts';
import { START_FLAGS_ELSEWHERE } from './lib/session/start-request.ts';
import { SessionStatusController } from './lib/session/status-controller.ts';
import { SessionSubtreeController } from './lib/session/subtree-controller.ts';
import { BulkStopController } from './lib/stop/controller.ts';
import type { BulkStopSelector } from './lib/stop/types.ts';
import { runCancellableStream, StreamController } from './lib/stream/controller.ts';
import { ClientEventStream } from './lib/stream/gateway.ts';
import { choice, count, guarded, joined, list as listOf, on, PLAIN, text, typed, VerbIo } from './lib/verb-io.ts';
import { WaitController } from './lib/wait/controller.ts';
import { WorktreeController } from './lib/worktrees/controller.ts';
import { ClientWorktreeGateway } from './lib/worktrees/gateway.ts';

/** The binary's name, for sentences that name a command. */
const BINARY = 'fy';

/**
 * Whether a failed read lost the daemon (as against the daemon answering no): the shell's transport failures carry no
 * HTTP status. A wait that loses the daemon ends with its own exit code instead of looking like a ferret that ended.
 */
function transportFailure(error: unknown): 'unavailable' | 'unresponsive' | undefined {
  if (!(error instanceof Error)) return undefined;
  const fields = error as { status?: unknown; exitCode?: unknown; timedOut?: unknown; name: string };
  if (typeof fields.status === 'number' || typeof fields.exitCode === 'number') return undefined;
  if (fields.timedOut === true) return 'unresponsive';
  return /Transport/.test(fields.name) ? 'unavailable' : undefined;
}

/** Usage sentences a group verb prints when it is typed bare. */
const STOP_USAGE = [
  'stop ferrets, selected by lineage or ownership label:',
  `  ${BINARY} stop orphan <ferret>     stop one ferret and leave its helpers running`,
  `  ${BINARY} stop cascade <ferret>    stop a ferret and every helper under it`,
  `  ${BINARY} stop children <ferret>   stop every helper under a ferret and keep it running`,
  `  ${BINARY} stop label <label>       stop every ferret with that label, whatever its lineage`,
];
const SESSION_USAGE = [
  "act on a ferret's own standing with this daemon:",
  `  ${BINARY} session revoke-credential <ferret>`,
  `  ${BINARY} session pin <ferret>`,
  `  ${BINARY} session unpin <ferret>`,
];

/**
 * The flags of `fy new` that are not Ferrets' start: continuing an existing conversation (`--continue`, `--since`)
 * and where it compacts are the Conversation's, a scratch-folder override is not a field of the start, and a prompt
 * file is not this CLI half's to read. The model routing (`--model`, `--effort`, `--auto`), `--card` and
 * `--name <title>` are sent with the start.
 */
const NEW_FLAGS_ELSEWHERE = ['continue', 'since', 'allow-scratch', 'compact-at', 'prompt-file'];

/** Refuses, by name, a typed flag whose value has no field in Ferrets' routes. */
function refuseElsewhere(invocation: VerbInvocation, names: readonly string[], verb: string): void {
  const found = names.filter(name => typed(invocation, name));
  if (found.length > 0)
    throw new SessionCommandError(
      `${found.map(name => `--${name}`).join(', ')}: not taken by \`${BINARY} ${verb}\` in this version of Ferretry (another plugin decides it now)`,
    );
}

/**
 * Ferrets' `fy` verbs (§2.2): list, read, start, stop, resume, rename and signal ferrets, revoke a ferret's token,
 * pin one, restart ferrets and manage the worktrees the daemon made for them. Each verb is one controller over the
 * shell's guarded client; write positionals before options.
 *
 * The shell hands a half no environment: `--session` names the ferret a `signal` is for, and a start begins in the
 * folder `fy` was run in unless `--cwd` names another.
 */
export default implementCli(manifest, {
  build({ client, io: terminal, env, clock, sleep, exists }) {
    const api = new ClientSessionApi(client);
    const environment: SessionEnvironment = { cwd: process.cwd() };

    const verb =
      (work: (invocation: VerbInvocation, presenter: SessionPresenter, io: VerbIo) => Promise<void>) =>
      async (invocation: VerbInvocation): Promise<number> => {
        const io = new VerbIo(terminal);
        const presenter = new SessionPresenter(io);
        return await guarded(io, presenter, async () => await work(invocation, presenter, io));
      };
    const json = (invocation: VerbInvocation) => (on(invocation, 'json') ? { json: true } : {});
    const first = (invocation: VerbInvocation, what: string): string => {
      const value = invocation.args[0]?.trim();
      if (value === undefined || value === '') throw new SessionCommandError(`missing the ${what}`);
      return value;
    };

    const list = verb(async (invocation, presenter) => {
      if (typed(invocation, 'label', 'l'))
        throw new SessionCommandError(
          'ps does not filter by label in this version of Ferretry; filter by its pack with --pack <pack>',
        );
      const pack = text(invocation, 'pack');
      await new ListSessionsController(api, presenter, PLAIN).execute({
        ...(on(invocation, 'all', 'a') ? { all: true } : {}),
        ...(pack === undefined ? {} : { pack }),
        ...json(invocation),
      });
    });

    const status = verb(async (invocation, presenter) => {
      const [id] = invocation.args;
      if (on(invocation, 'subtree'))
        return await new SessionSubtreeController(api, presenter, environment).execute(id, json(invocation));
      if (id === undefined)
        throw new SessionCommandError('missing the ferret id: status <id>, or status --subtree <id>');
      await new SessionStatusController(api, presenter).execute(id, json(invocation));
    });

    const start = (role: 'start' | 'new') =>
      verb(async (invocation, presenter) => {
        refuseElsewhere(invocation, role === 'start' ? START_FLAGS_ELSEWHERE : NEW_FLAGS_ELSEWHERE, role);
        const mode = text(invocation, 'mode') ?? 'auto';
        if (mode !== 'auto' && mode !== 'interactive') throw new SessionCommandError('--mode is auto or interactive');
        const agent = text(invocation, 'agent', 'a', 'runtime');
        const teammate = text(invocation, 'teammate');
        const parent = role === 'start' ? text(invocation, 'parent') : undefined;
        const harness = text(invocation, 'harness');
        const login = text(invocation, 'login');
        const pack = text(invocation, 'pack');
        const cwd = text(invocation, 'cwd');
        const prompt = joined(invocation.args);
        const auto = role === 'new' && on(invocation, 'auto');
        // Today's `fy new` refinement: a sub-ferret names its runtime, or lets Ferretry pick one.
        if (role === 'new' && auto && agent !== undefined)
          throw new SessionCommandError('--auto picks the runtime; do not name one');
        if (role === 'new' && !auto && agent === undefined)
          throw new SessionCommandError('name a --runtime, or pass --auto');
        const title = text(invocation, 'name');
        const label = text(invocation, 'label');
        const card = text(invocation, 'card');
        const model = text(invocation, 'model');
        const effort = text(invocation, 'effort');
        const fast = choice(invocation, 'fast');
        const remoteControl = choice(invocation, 'rc');
        const harnessFlags = listOf(invocation, 'harness-flag');
        const numbers = {
          interval: count(invocation, 'interval'),
          turnTimeout: count(invocation, 'turn-timeout'),
          nudgeAfter: count(invocation, 'nudge-after'),
          stallKillAfter: count(invocation, 'stall-kill-after'),
          directMax: count(invocation, 'direct-max'),
          maxSnapshots: count(invocation, 'max-snapshots'),
        };
        await new StartSessionController(api, presenter, environment, BINARY).execute({
          mode,
          ...(on(invocation, 'teammate-fallback') ? { teammateFallback: true } : {}),
          ...(title === undefined ? {} : { title }),
          ...(label === undefined ? {} : { label }),
          ...(card === undefined ? {} : { card }),
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
          ...(fast === undefined ? {} : { fast }),
          ...(remoteControl === undefined ? {} : { remoteControl }),
          ...(harnessFlags.length === 0 ? {} : { harnessFlags }),
          ...(auto ? { auto: true } : {}),
          ...Object.fromEntries(Object.entries(numbers).filter(([, value]) => value !== undefined)),
          ...(agent === undefined ? {} : { agent }),
          ...(teammate === undefined ? {} : { teammate }),
          ...(parent === undefined ? {} : { parent }),
          ...(harness === undefined ? {} : { harness }),
          ...(login === undefined ? {} : { login }),
          ...(pack === undefined ? {} : { pack }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(prompt === undefined ? {} : { prompt }),
          ...json(invocation),
        });
      });

    const stopBy = (kind: BulkStopSelector['kind']) =>
      verb(async (invocation, _presenter, io) => {
        const reason = text(invocation, 'reason', 'r');
        const value = first(invocation, kind === 'label' ? 'pack' : 'ferret');
        const selector: BulkStopSelector = kind === 'label' ? { kind, label: value } : { kind, rootId: value };
        const includeCaller = on(invocation, 'include-caller');
        await new BulkStopController(api, io, { ask: async () => '' }, { interactive: false, binaryName: BINARY }).run(
          selector,
          {
            ...(reason === undefined ? {} : { reason }),
            ...(on(invocation, 'dry-run', 'n') ? { dryRun: true } : {}),
            ...(on(invocation, 'yes', 'y') ? { yes: true } : {}),
            ...(includeCaller ? { includeCaller: true } : {}),
          },
        );
      });

    const usage = (lines: readonly string[]) =>
      verb(async (_invocation, presenter, io) => {
        presenter.report(lines);
        io.setExitCode(2);
      });

    const rename = verb(async (invocation, presenter) => {
      const title = text(invocation, 'title');
      await new RenameSessionController(api, presenter).execute(first(invocation, 'ferret'), invocation.args[1], {
        ...(title === undefined ? {} : { title }),
        ...json(invocation),
      });
    });

    const names = verb(async (invocation, presenter) => {
      const raw = text(invocation, 'count', 'n');
      await new SuggestNamesController(api, presenter).execute({
        ...(raw === undefined ? {} : { count: Number(raw) }),
        ...json(invocation),
      });
    });

    const resume = verb(async (invocation, presenter) => {
      const message = joined(invocation.args.slice(1));
      await new ResumeSessionController(api, presenter).execute(first(invocation, 'ferret id'), {
        ...(message === undefined ? {} : { message }),
        ...json(invocation),
      });
    });

    const restart = verb(async (invocation, presenter) => {
      if (typed(invocation, 'request-id'))
        throw new SessionCommandError('--request-id: a restart carries no idempotency key in this version of Ferretry');
      await new RestartController(new ClientRestartGateway(client), presenter).execute(invocation.args, {
        ...(on(invocation, 'outdated') ? { outdated: true } : {}),
        ...(on(invocation, 'all') ? { all: true } : {}),
        ...(on(invocation, 'cancel') ? { cancel: true } : {}),
        ...json(invocation),
      });
    });

    const signal = verb(async (invocation, presenter) => {
      const [kind = '', ...parts] = invocation.args;
      const session = text(invocation, 'session');
      const until = text(invocation, 'until');
      const condition = text(invocation, 'on');
      const peer = text(invocation, 'peer');
      await new SignalSessionController(api, presenter, environment).execute(kind, joined(parts), {
        ...(session === undefined ? {} : { session }),
        ...(until === undefined ? {} : { until }),
        ...(condition === undefined ? {} : { on: condition }),
        ...(peer === undefined ? {} : { peer }),
        ...json(invocation),
      });
    });

    const wait = verb(async (invocation, _presenter, io) => {
      const timeout = count(invocation, 'timeout');
      const interval = count(invocation, 'interval');
      const marker = text(invocation, 'until-marker');
      // A wait needs a clock and a way to sleep, and a deliverable gate an existence check: the shell fills them in.
      if (clock === undefined || sleep === undefined)
        throw new SessionCommandError('wait needs the shell’s clock, which this fy does not give a verb yet', 1);
      if (marker !== undefined && exists === undefined)
        throw new SessionCommandError(
          '--until-marker needs the shell’s existence check, which this fy does not give a verb yet',
          1,
        );
      const controller = new WaitController(
        {
          get: async (reference, signal) => await api.get(reference, signal),
          // The deadline is the shell's cancellable sleep: its signal aborts when the time is up, and a finished wait drops it.
          startDeadline: milliseconds => {
            const timer = new AbortController();
            const passed = new AbortController();
            void sleep(milliseconds as never, timer.signal).then(
              () => passed.abort(),
              () => undefined,
            );
            return { signal: passed.signal, cancel: () => timer.abort() };
          },
          markerExists: async path => await (exists?.(path) ?? Promise.resolve(false)).catch(() => false),
          nowMs: () => clock.nowMs(),
          sleep: async milliseconds => await sleep(milliseconds as never),
          transport: transportFailure,
        },
        io,
        BINARY,
      );
      await controller.wait(first(invocation, 'ferret id'), {
        ...(on(invocation, 'json') ? { json: true } : {}),
        ...(timeout === undefined ? {} : { timeout }),
        ...(interval === undefined ? {} : { interval }),
        ...(marker === undefined ? {} : { untilMarker: marker }),
      });
    });

    // `fy stream [id]`: one ferret from `--after`, or the fleet's recent tail; ends on SIGINT/SIGTERM (today's rules).
    const stream = verb(async (invocation, _presenter, io) => {
      const raw = text(invocation, 'after');
      if (raw === undefined && typed(invocation, 'after')) throw new SessionCommandError('--after needs a sequence');
      const id = invocation.args[0]?.trim();
      await runCancellableStream(
        new StreamController(new ClientEventStream(client), io, BINARY),
        id === '' ? undefined : id,
        { ...(raw === undefined ? {} : { after: Number(raw) }), ...(on(invocation, 'json') ? { json: true } : {}) },
        process,
      );
    });

    const instructions = verb(async (invocation, presenter) => {
      const report = instructionsReport(env ?? {});
      if (on(invocation, 'json')) presenter.json(report);
      else presenter.lines([renderInstructionsReport(report, BINARY)]);
    });

    const revoke = verb(async (invocation, presenter) => {
      await new RevokeCredentialController(api, presenter, BINARY).execute(invocation.args[0] ?? '', json(invocation));
    });
    const pin = (how: 'pin' | 'unpin') =>
      verb(async (invocation, presenter) => {
        await new PinAgentController(api, presenter)[how](invocation.args[0] ?? '', json(invocation));
      });

    const worktrees = (io: VerbIo) =>
      new WorktreeController(
        new ClientWorktreeGateway(client),
        io,
        { ask: async () => '' },
        false,
        environment.cwd ?? '/',
      );
    const worktreeList = verb(async (invocation, _presenter, io) => {
      await worktrees(io).list(json(invocation));
    });
    const worktreeCheck = verb(async (invocation, _presenter, io) => {
      await worktrees(io).check(first(invocation, 'worktree path'), json(invocation));
    });
    const worktreeRemove = verb(async (invocation, _presenter, io) => {
      await worktrees(io).remove(first(invocation, 'worktree path'), {
        ...(on(invocation, 'discard-changes') ? { discardChanges: true } : {}),
        ...(on(invocation, 'accept-unpushed') ? { acceptUnpushed: true } : {}),
        ...(on(invocation, 'delete-unmerged') ? { deleteUnmerged: true } : {}),
        ...(on(invocation, 'delete-branch') ? { deleteBranch: true } : {}),
        ...(on(invocation, 'delete-preexisting') ? { deletePreexisting: true } : {}),
        ...(on(invocation, 'yes', 'y') ? { yes: true } : {}),
        ...json(invocation),
      });
    });
    const worktreeFork = verb(async (invocation, _presenter, io) => {
      const base = text(invocation, 'base');
      const from = text(invocation, 'from');
      const session = text(invocation, 'session');
      await worktrees(io).fork(first(invocation, 'branch'), {
        ...(base === undefined ? {} : { base }),
        ...(on(invocation, 'from-default') ? { fromDefault: true } : {}),
        ...(on(invocation, 'from-head') ? { fromHead: true } : {}),
        ...(from === undefined ? {} : { from }),
        ...(session === undefined ? {} : { session }),
        ...json(invocation),
      });
    });

    // `fy ferret move <id>` (today's `fy migrate`, §1.4): one destructive call under a logical request id.
    const move = verb(async (invocation, presenter, io) => {
      const id = first(invocation, 'ferret id or callsign');
      const progress = on(invocation, 'json') ? NO_PROGRESS : new PlainProgress(line => io.diagnostic(line));
      await new MoveController(new ClientMoveGateway(client, () => randomUUID()), presenter, progress).execute(
        id,
        moveOptions(invocation),
      );
    });

    return {
      verbs: {
        ps: list,
        'status [id]': status,
        'start [prompt...]': start('start'),
        'new [words...]': start('new'),
        stop: usage(STOP_USAGE),
        'stop orphan <session>': stopBy('orphan'),
        'stop cascade <session>': stopBy('cascade'),
        'stop children <session>': stopBy('children'),
        'stop label <label>': stopBy('label'),
        'rename <session> [name]': rename,
        name: names,
        'resume <id> [message...]': resume,
        'restart [ids...]': restart,
        'stream [id]': stream,
        'wait <id>': wait,
        instructions,
        'signal <kind> [message...]': signal,
        session: usage(SESSION_USAGE),
        'session revoke-credential <session>': revoke,
        'session pin <session>': pin('pin'),
        'session unpin <session>': pin('unpin'),
        worktree: worktreeList,
        worktrees: worktreeList,
        'worktree ls': worktreeList,
        'worktree list': worktreeList,
        'worktree check <path>': worktreeCheck,
        'worktree rm <path>': worktreeRemove,
        'worktree remove <path>': worktreeRemove,
        'worktree fork <branch>': worktreeFork,
        'worktree add <branch>': worktreeFork,
        'ferret move <id>': move,
      },
    };
  },
});
