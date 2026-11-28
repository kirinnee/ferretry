import type { RunnerHandle } from '@ferretry/core-ferrets/contract';
import { isTmuxServerAbsent } from '../../lib/tmux/server-absent.ts';
import { killSessionArguments } from '../../lib/tmux/commands.ts';
import { DEFAULT_TREE_END_TIMES, type DoomedProcess, endDoomed, nameDoomed } from './session-tree-end.ts';
import { scopeBelongsTo } from './pane-process-host.ts';
import {
  ferretTmuxSession,
  isFerretSession,
  isServerEmpty,
  type PaneFacts,
  type TmuxRunnerOptions,
} from './tmux-runner.ts';

/** The stop owns launch identities independently of the life of tmux's panes and sessions. */
export class SessionStop {
  readonly #scopes = new Map<string, string>();
  readonly #byHandle = new Map<RunnerHandle, string>();
  constructor(
    private readonly options: TmuxRunnerOptions,
    private readonly readFacts: (handle: RunnerHandle) => Promise<PaneFacts | undefined>,
  ) {}

  async recordScope(ferret: string, scope: string | undefined): Promise<void> {
    const session = ferretTmuxSession(ferret);
    await this.options.scopes?.recordScope(session, scope);
    if (scope === undefined) this.#scopes.delete(session);
    else this.#scopes.set(session, scope);
  }

  rememberPane(ferret: string, handle: RunnerHandle): void {
    this.#byHandle.set(handle, ferret);
  }

  async stop(handle: RunnerHandle, how: 'polite' | 'now', ferret?: string): Promise<void> {
    const facts = await this.readFacts(handle);
    ferret ??= this.#byHandle.get(handle);
    // Nothing, or ANOTHER ferret's pane (or a person's shell), behind this handle: the pane id says nothing about this
    // ferret, so nothing is pressed or killed through it. Its own session is stopped by its exact name, as v4 did.
    if (facts === undefined || !(ferret === undefined || facts.session === ferretTmuxSession(ferret))) {
      if (ferret !== undefined) await this.stopByName(ferret, how);
      return;
    }
    // Only a ferret's session is ever ended through a handle: a pane id of a person's shell is not ours to end.
    const ours = isFerretSession(facts.session);
    // Every process under the session's panes is NAMED before anything is signalled: afterwards they are children of init.
    let doomed = ours ? await this.nameSession(facts.session, facts.pid) : [];
    if (how === 'polite' && !facts.dead) {
      // The harness's own interrupt first, then a bounded wait for the session to end by itself. A refusal is thrown:
      // a polite stop that reached nothing is never taken for one that did. A session still there after the grace is
      // ended as a `now` stop ends it: a stop is only reported once the ferret is really gone.
      const pressed = await this.options.tmux.execute(['send-keys', '-t', handle, 'C-c']);
      if (pressed.code !== 0)
        throw new Error(
          `could not interrupt ${facts.session}: ${pressed.stderr.trim() || `tmux exited ${String(pressed.code)}`}`,
        );
      if (!ours) return;
      doomed = await this.untilSessionEnds(facts.session, doomed);
    }
    if (ours) {
      const killed = await this.options.tmux.execute(killSessionArguments(facts.session));
      // A session that went away between the read and the kill is the stop already made; any other refusal is not.
      if (killed.code !== 0 && !/can't find session/iu.test(killed.stderr) && !isTmuxServerAbsent(killed.stderr))
        throw new Error(
          `could not stop ${facts.session}: ${killed.stderr.trim() || `tmux exited ${String(killed.code)}`}`,
        );
      await this.endProcesses(facts.session, doomed);
    }
  }

  /**
   * Stops `ferret`'s own session by its EXACT name (`=fy-<id>`: a bare name is a prefix match that could name another
   * ferret's), for a handle that does not lead to it. Polite sends the harness's interrupt to a session that still has a live
   * pane and otherwise (every pane dead, or `now`) kills the session. Its recorded scope is ended even without a session.
   */
  private async stopByName(ferret: string, how: 'polite' | 'now'): Promise<void> {
    let session: string;
    try {
      session = ferretTmuxSession(ferret);
    } catch {
      return;
    }
    const exact = `=${session}`;
    // Only an ANSWER that the session is not there stops nothing. A has-session that throws, or fails any other way, proves
    // nothing about the session, and returning quietly would let the caller settle a possibly live ferret `stopped`.
    const present = await this.options.tmux.execute(['has-session', '-t', exact]).catch((error: unknown) => {
      throw new Error(
        `could not check whether ${session} is running (${error instanceof Error ? error.message : String(error)}), so it was not stopped; it may still be running`,
      );
    });
    if (present.code !== 0) {
      if (
        /can't find session/iu.test(present.stderr) ||
        isServerEmpty(present.stderr) ||
        isTmuxServerAbsent(present.stderr)
      ) {
        await this.endProcesses(session, await this.nameSession(session));
        return;
      }
      const why = present.stderr.trim() || `tmux exited ${String(present.code)}`;
      this.options.log?.warn(`Could not check whether ${session} is running, so it was not stopped: ${why}`, {
        session,
      });
      throw new Error(
        `could not check whether ${session} is running (${why}), so it was not stopped; it may still be running`,
      );
    }
    let doomed = await this.nameSession(session);
    if (how === 'polite') {
      const panes = await this.options.tmux
        .execute(['list-panes', '-s', '-t', exact, '-F', '#{pane_dead}'])
        .catch((error: unknown) => ({
          code: 1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        }));
      // A failed read is not proof that no pane is live: it says nothing, and the answer to nothing is not a kill.
      // `can't find session` IS an answer (the session ended between the check and the read: already stopped).
      if (panes.code !== 0) {
        if (/can't find session/iu.test(panes.stderr) || isTmuxServerAbsent(panes.stderr)) {
          await this.endProcesses(session, doomed);
          return;
        }
        const why = panes.stderr.trim() || `tmux exited ${String(panes.code)}`;
        this.options.log?.warn(`Could not read the panes of ${session}, so it was not stopped: ${why}`, { session });
        throw new Error(
          `could not read the panes of ${session} (${why}), so it was not stopped; it may still be running`,
        );
      }
      const live = panes.stdout.split('\n').some(line => line.trim() === '0');
      if (live) {
        // `send-keys` wants a PANE target: `=fy-<id>` alone is parsed as a pane name and tmux answers "can't find pane",
        // while `=fy-<id>:` is the exact session's active pane. A refusal is thrown, so a polite stop that reached
        // nothing is never taken for one that did (the caller would settle the ferret `stopped` over a running session).
        const pressed = await this.options.tmux.execute(['send-keys', '-t', `${exact}:`, 'C-c']);
        if (pressed.code !== 0)
          throw new Error(`could not interrupt ${session}: ${pressed.stderr.trim() || `tmux exited ${pressed.code}`}`);
        doomed = await this.untilSessionEnds(session, doomed);
      }
    }
    const killed = await this.options.tmux.execute(['kill-session', '-t', exact]);
    // A session that went away between the check and the kill is the stop already made; any other refusal is not.
    if (killed.code !== 0 && !/can't find session/iu.test(killed.stderr) && !isTmuxServerAbsent(killed.stderr))
      throw new Error(`could not stop ${session}: ${killed.stderr.trim() || `tmux exited ${killed.code}`}`);
    await this.endProcesses(session, doomed);
  }

  private async sleepFor(ms: number): Promise<void> {
    await this.options.sleep?.(ms);
  }

  /**
   * Every process under `session`'s panes (its pane roots, `first` among them, and their descendants), named now. Nothing
   * without a process host: a fixture that cannot read processes cannot prove them gone either.
   */
  private async nameSession(session: string, first?: number): Promise<readonly DoomedProcess[]> {
    const host = this.options.processes;
    if (host === undefined) return [];
    const listed = await this.options.tmux
      .execute(['list-panes', '-s', '-t', `=${session}`, '-F', '#{pane_pid}'])
      .catch(() => undefined);
    const roots = [
      ...(first === undefined ? [] : [first]),
      ...(listed === undefined || listed.code !== 0
        ? []
        : listed.stdout
            .split('\n')
            .map(line => Number(line.trim()))
            .filter(pid => Number.isSafeInteger(pid) && pid > 1)),
    ];
    const recorded = this.#scopes.get(session) ?? (await this.options.scopes?.scopeOf(session));
    const scope = recorded !== undefined && scopeBelongsTo(recorded, session.slice(3)) ? recorded : undefined;
    return await nameDoomed(host, [...new Set(roots)], scope, session.slice(3));
  }

  /**
   * After a polite stop's interrupt: waits up to the grace for the session to end by itself and answers what was named
   * (the processes named again, so one that started meanwhile is not missed). A session that is still there is the
   * caller's to end.
   */
  private async untilSessionEnds(session: string, named: readonly DoomedProcess[]): Promise<readonly DoomedProcess[]> {
    const grace = this.options.politeGraceMs ?? 5_000;
    const poll = this.options.treeEnd?.pollMs ?? DEFAULT_TREE_END_TIMES.pollMs;
    for (let waited = 0; waited < grace; waited += poll) {
      const present = await this.options.tmux.execute(['has-session', '-t', `=${session}`]).catch(() => undefined);
      if (present !== undefined && present.code !== 0) break;
      await this.sleepFor(poll);
    }
    const again = await this.nameSession(session);
    const seen = new Set(named.map(process => `${process.pid}:${process.start}`));
    return [...named, ...again.filter(process => !seen.has(`${process.pid}:${process.start}`))];
  }

  /** Once the session is killed: ends every process that was named under it, or throws that one could not be ended. */
  private async endProcesses(session: string, doomed: readonly DoomedProcess[]): Promise<void> {
    const host = this.options.processes;
    if (host === undefined || doomed.length === 0) return;
    await endDoomed(host, doomed, session, ms => this.sleepFor(ms), this.options.treeEnd ?? DEFAULT_TREE_END_TIMES);
  }
}
