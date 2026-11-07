import type {
  AttachRefusal,
  DeliveryOutcome,
  Runner,
  RunnerDelivery,
  RunnerHandle,
  RunningFerret,
  RunSpec,
  StartRefusal,
} from '@ferretry/core-ferrets/contract';
import type { RunnerKey } from '@ferretry/core-ferrets/contract';
import { type ActRunner, REFUSAL_SENTENCES, type SpawnPort } from '@ferretry/kernel/contract';
import { targetRef } from '@ferretry/core-vault/contract';
import { err, type Instant, ok, type Result } from '@ferretry/std';
import { sessionTarget } from '../../lib/tmux/address.ts';
import { killSessionArguments, remainOnExitArguments } from '../../lib/tmux/commands.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../lib/tmux/contracts.ts';
import { TmuxController } from '../../lib/tmux/controller.ts';
import { scriptLine } from '../../lib/tmux/script.ts';
import { TERMINAL_TMUX_PREFIX } from '../../lib/terminal/runtime-policy.ts';
import { TMUX_PROGRAM } from './kernel-tmux-process.ts';
import type { DeliverySleep } from './composer-fill.ts';
import { PaneDeliveryError, PaneNotReadyError, TmuxPaneDelivery } from './pane-delivery.ts';

/**
 * The `runners:tmux` provider (§2.3): a ferret's harness runs in its own tmux session, `fy-<ferret>`, on Terminals'
 * tmux server, and its HANDLE IS THE PANE ID (`%12`).
 *
 * WHY THE PANE ID: tmux never reuses one while its server lives, and Ferrets persists the handle in `ferret.json`, so a
 * restarted daemon finds the pane again by asking tmux about exactly that id (`attach`) — never by a name a person or
 * a second launch could have taken meanwhile. A v4→v5 switch hands v5 the pane ids of the panes already running, and
 * `attach` adopts each WITHOUT restarting it (spine D15).
 *
 * THE ENVIRONMENT NEVER PASSES THROUGH THIS PLUGIN. `spec.env` is the Vault's opaque handle: the kernel's spawn adapter
 * opens it for the ONE tmux client that runs the launch, and tmux copies exactly the variables the handle names
 * (`update-environment`, set for this launch and put back in the same script) from that client into the new
 * session. The names are not secret (`ChildEnvironment.names` is "for the launch record"); the values exist only in
 * that client's environment and the pane's. The server is started first, from a client WITHOUT the handle, so a
 * server this launch starts can never inherit a ferret's values into its global environment.
 */

/** tmux session names for ferrets (today's `tmuxSessionPrefix` and `maxTmuxSessionNameLength`). */
export const FERRET_TMUX_PREFIX = 'fy-';
const MAX_TMUX_SESSION_NAME_LENGTH = 80;

/** A pane id as tmux prints one. */
const PANE_ID = /^%(?:0|[1-9][0-9]*)$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** What tmux is asked about a pane: id, process, dead, the session holding it, and when that session began. */
const PANE_FACTS = '#{pane_id}|#{pane_pid}|#{pane_dead}|#{session_name}|#{session_created}';

export function ferretTmuxSession(ferret: string): string {
  return sessionTarget(`${FERRET_TMUX_PREFIX}${ferret}`.slice(0, MAX_TMUX_SESSION_NAME_LENGTH));
}

interface PaneFacts {
  readonly paneId: string;
  readonly pid: number;
  readonly dead: boolean;
  readonly session: string;
  readonly created: number;
}

export function parsePaneFacts(line: string): PaneFacts | undefined {
  const [paneId = '', pid = '', dead = '', session = '', created = ''] = line.trim().split('|');
  if (!PANE_ID.test(paneId) || session === '') return undefined;
  const process = Number(pid);
  const began = Number(created);
  return {
    paneId,
    pid: Number.isInteger(process) && process > 0 ? process : 0,
    dead: dead === '1',
    session,
    created: Number.isInteger(began) && began > 0 ? began : 0,
  };
}

/** Whether a tmux session is a ferret's: `fy-…`, and not one of Terminals' own shells (`fy-webterm-…`). */
export function isFerretSession(session: string): boolean {
  return session.startsWith(FERRET_TMUX_PREFIX) && !session.startsWith(TERMINAL_TMUX_PREFIX);
}

export interface TmuxRunnerOptions {
  readonly tmux: TmuxCommandPort;
  readonly spawn: SpawnPort;
  readonly socketPath: string;
  readonly instantOf: (epochSeconds: number) => Instant;
  readonly now: () => Instant;
  /** The argv the pane execs: the harness's command inside the ferret's limits (docs/ferret-limits.md). */
  readonly wrap?: (ferret: string, command: readonly string[]) => Promise<readonly string[]>;
  /** Told of every pane this runner started or adopted, with the ferret it runs (the processes and attach proof). */
  readonly remember?: (ferret: string, running: RunningFerret) => Promise<void>;
  /** The kernel guards every delivery write; sleeps use its clock. Absent: delivery refuses before any keys. */
  readonly delivery?: { readonly act: ActRunner; readonly sleep: DeliverySleep };
}

export class TmuxRunner implements Runner {
  readonly key = 'tmux' as RunnerKey;
  /** One launch at a time: `update-environment` is a server-wide option, set and put back inside one launch. */
  #launching: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TmuxRunnerOptions) {}

  async start(spec: RunSpec): Promise<Result<RunningFerret, StartRefusal>> {
    const launch = this.#launching.then(async () => await this.launch(spec));
    this.#launching = launch.catch(() => undefined);
    return await launch;
  }

  async resume(spec: RunSpec, _harnessConversationId: string): Promise<Result<RunningFerret, StartRefusal>> {
    // The harness plugin built `spec.command` to resume its conversation; the runner starts it like any other.
    return await this.start(spec);
  }

  async attach(handle: RunnerHandle): Promise<Result<RunningFerret, AttachRefusal>> {
    if (!PANE_ID.test(handle)) return err('unsupported');
    const facts = await this.facts(handle);
    if (facts === undefined || facts.dead) return err('gone');
    if (!isFerretSession(facts.session)) return err('not-a-ferret');
    // Adopted as it is: nothing is sent to the pane, nothing restarted.
    const running: RunningFerret = {
      handle,
      ...(facts.pid > 0 ? { pid: facts.pid } : {}),
      startedAt: facts.created > 0 ? this.options.instantOf(facts.created) : this.options.now(),
    };
    await this.options.remember?.(facts.session.slice(FERRET_TMUX_PREFIX.length), running);
    return ok(running);
  }

  async alive(handle: RunnerHandle): Promise<boolean> {
    if (!PANE_ID.test(handle)) return false;
    const facts = await this.facts(handle);
    return facts !== undefined && !facts.dead;
  }

  async deliver(handle: RunnerHandle, delivery: RunnerDelivery): Promise<DeliveryOutcome> {
    const gone = (): PaneNotReadyError => new PaneNotReadyError('the ferret pane is no longer live', 'exited');
    if (!PANE_ID.test(handle)) throw gone();
    const original = await this.facts(handle);
    if (original === undefined || original.dead || !isFerretSession(original.session)) throw gone();
    const guard = this.options.delivery;
    if (guard === undefined) throw new PaneDeliveryError('terminal delivery is not configured');
    // Reuse today's delivery unchanged. Its commands use a validated session name, but every target is rebound to
    // this exact live handle, so a changed active pane or a replacement session cannot receive the message.
    const bound: TmuxCommandPort = {
      execute: async (args, stdin) => {
        const run = async (): Promise<TmuxCommandResult> => {
          // Cleanup must still work after a disappearing pane or a refused paste.
          if (args[0] === 'delete-buffer') return await this.options.tmux.execute(args, stdin);
          const current = await this.facts(handle);
          if (
            current === undefined ||
            current.dead ||
            current.session !== original.session ||
            current.pid !== original.pid ||
            current.created !== original.created
          )
            return { code: 1, stdout: '', stderr: 'the ferret pane is no longer live' };
          if (args[0] === 'has-session') return { code: 0, stdout: '', stderr: '' };
          return await this.options.tmux.execute(
            args.map((arg, i) => (args[i - 1] === '-t' ? handle : arg)),
            stdin,
          );
        };
        if (!['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0] ?? '')) return await run();
        let result: TmuxCommandResult | undefined;
        const acted = await guard.act(targetRef('terminal', handle), 'keys', async () => {
          result = await run();
          return { status: 'done' };
        });
        if (!acted.ok) return { code: 1, stdout: '', stderr: REFUSAL_SENTENCES[acted.error.refused] };
        if (result === undefined) throw new PaneDeliveryError('terminal delivery did not run');
        return result;
      },
    };
    // In particular, ComposerUnconfirmedError and PaneStrandedError propagate without a retry: typed is not lost.
    return await new TmuxPaneDelivery(new TmuxController(bound), guard.sleep).deliver(
      original.session,
      delivery.text,
      { resumeMenuChoice: delivery.resumeMenuChoice },
      delivery.beforeWrite,
    );
  }

  async stop(handle: RunnerHandle, how: 'polite' | 'now'): Promise<void> {
    if (!PANE_ID.test(handle)) return;
    const facts = await this.facts(handle);
    if (facts === undefined) return;
    if (how === 'polite' && !facts.dead) {
      // The harness's own interrupt first; the session goes once the pane is dead or the caller asks again `now`.
      await this.options.tmux.execute(['send-keys', '-t', handle, 'C-c']);
      return;
    }
    // Only a ferret's session is ever killed through a handle: a pane id of a person's shell is not ours to end.
    if (isFerretSession(facts.session)) await this.options.tmux.execute(killSessionArguments(facts.session));
  }

  async signal(handle: RunnerHandle, signal: 'interrupt' | 'terminate'): Promise<void> {
    if (!PANE_ID.test(handle)) return;
    const facts = await this.facts(handle);
    if (facts === undefined || facts.dead || !isFerretSession(facts.session)) return;
    if (signal === 'interrupt') await this.options.tmux.execute(['send-keys', '-t', handle, 'C-c']);
    else await this.options.tmux.execute(killSessionArguments(facts.session));
  }

  private async facts(paneId: string): Promise<PaneFacts | undefined> {
    const result = await this.options.tmux.execute(['display-message', '-p', '-t', paneId, PANE_FACTS]);
    if (result.code !== 0) return undefined;
    const facts = parsePaneFacts(result.stdout);
    // tmux answers `-t %n` for a pane that is gone with the CURRENT pane; only the exact id is an answer.
    return facts?.paneId === paneId ? facts : undefined;
  }

  private async launch(spec: RunSpec): Promise<Result<RunningFerret, StartRefusal>> {
    const command = this.options.wrap === undefined ? spec.command : await this.options.wrap(spec.ferret, spec.command);
    const [program, ...args] = command;
    if (program === undefined) return err('failed');
    const names = spec.env.names.filter(name => ENVIRONMENT_NAME.test(name));
    if (names.length !== spec.env.names.length) return err('failed');
    const session = ferretTmuxSession(spec.ferret);
    if ((await this.options.tmux.execute(['has-session', '-t', session])).code === 0) return err('failed');
    // Started without the handle, so the server never holds a ferret's values in its own environment.
    if ((await this.options.tmux.execute(['start-server'])).code !== 0) return err('unavailable');
    const before = await this.options.tmux.execute(['show-options', '-gv', 'update-environment']);
    if (before.code !== 0) return err('unavailable');
    const kept = before.stdout
      .split(/\s+/u)
      .map(name => name.trim())
      .filter(name => name !== '');
    const script = [
      scriptLine(['set-option', '-g', 'update-environment', [...kept, ...names].join(' ')]),
      scriptLine([
        'new-session',
        '-d',
        '-P',
        '-F',
        '#{pane_id}|#{pane_pid}',
        '-s',
        session,
        '-c',
        spec.cwd,
        '--',
        program,
        ...args,
      ]),
      scriptLine(['set-option', '-g', 'update-environment', kept.join(' ')]),
    ].join('');
    const created = await this.options.spawn.run(
      TMUX_PROGRAM,
      ['-u', '-S', this.options.socketPath, 'source-file', '-'],
      { stdin: script, env: spec.env, cwd: spec.cwd, forFerret: spec.ferret },
    );
    const [paneId = '', pid = ''] = created.stdout.trim().split('|');
    if (created.exitCode !== 0 || !PANE_ID.test(paneId)) {
      // Whatever the script did, the option is put back from a client that holds no values.
      await this.options.tmux.execute(['set-option', '-g', 'update-environment', kept.join(' ')]);
      return err('failed');
    }
    await this.options.tmux.execute(remainOnExitArguments(session));
    const process = Number(pid);
    const running: RunningFerret = {
      handle: paneId as RunnerHandle,
      ...(Number.isInteger(process) && process > 0 ? { pid: process } : {}),
      startedAt: this.options.now(),
    };
    await this.options.remember?.(spec.ferret, running);
    return ok(running);
  }
}
