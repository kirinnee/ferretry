import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { ClientRestartGateway, ClientSessionApi } from './lib/client.ts';
import { RestartController } from './lib/restart/controller.ts';
import { SessionCompactAtController } from './lib/session/compact-at.ts';
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
import { choice, count, guarded, joined, list as listOf, on, PLAIN, text, typed, VerbIo } from './lib/verb-io.ts';
import { WorktreeController } from './lib/worktrees/controller.ts';
import { ClientWorktreeGateway } from './lib/worktrees/gateway.ts';

/** The binary's name, for sentences that name a command. */
const BINARY = 'fy';

/** Usage sentences a group verb prints when it is typed bare. */
const STOP_USAGE = [
  'stop ferrets, selected by lineage or pack:',
  `  ${BINARY} stop orphan <ferret>     stop one ferret and leave its helpers running`,
  `  ${BINARY} stop cascade <ferret>    stop a ferret and every helper under it`,
  `  ${BINARY} stop children <ferret>   stop every helper under a ferret and keep it running`,
  `  ${BINARY} stop label <pack>        stop every ferret in a pack, whatever its lineage`,
];
const SESSION_USAGE = [
  "act on a ferret's own standing with this daemon:",
  `  ${BINARY} session revoke-credential <ferret>`,
  `  ${BINARY} session pin <ferret>`,
  `  ${BINARY} session unpin <ferret>`,
  `  ${BINARY} session compact-at <ferret> [tokens|auto|inherit]`,
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
  build({ client, io: terminal }) {
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

    const revoke = verb(async (invocation, presenter) => {
      await new RevokeCredentialController(api, presenter, BINARY).execute(invocation.args[0] ?? '', json(invocation));
    });
    const pin = (how: 'pin' | 'unpin') =>
      verb(async (invocation, presenter) => {
        await new PinAgentController(api, presenter)[how](invocation.args[0] ?? '', json(invocation));
      });
    const compactAt = verb(async (invocation, presenter) => {
      await new SessionCompactAtController(api, presenter).run(
        invocation.args[0] ?? '',
        invocation.args[1],
        json(invocation),
      );
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
        'signal <kind> [message...]': signal,
        session: usage(SESSION_USAGE),
        'session revoke-credential <session>': revoke,
        'session pin <session>': pin('pin'),
        'session unpin <session>': pin('unpin'),
        'session compact-at <session> [value]': compactAt,
        worktree: worktreeList,
        worktrees: worktreeList,
        'worktree ls': worktreeList,
        'worktree list': worktreeList,
        'worktree check <path>': worktreeCheck,
        'worktree rm <path>': worktreeRemove,
        'worktree remove <path>': worktreeRemove,
        'worktree fork <branch>': worktreeFork,
        'worktree add <branch>': worktreeFork,
      },
    };
  },
});
