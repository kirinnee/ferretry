import type { Log } from '@ferretry/kernel/contract';
import type { GitAccount, GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import {
  settingsOf,
  WATCH_EVENTS,
  type PullsConfig,
  type WatchedRepo,
  type WatchOverview,
  type WatchProjectView,
  type WatchSnapshot,
} from '../../../contract/index.ts';
import type { GithubClient } from '../../adapters/github/client.ts';
import { intervalFor, isViewed } from './cadence.ts';
import { eventsOf, type WatchEventLine } from './events.ts';
import { observeRepo } from './observe.ts';
import { reposOf } from './repos.ts';
import type { WatchStore } from './store.ts';
import { buzzOf, type PullBuzz } from './words.ts';

export interface WatchDeps {
  readonly github: Pick<GithubClient, 'get' | 'getAll'> & {
    readonly budget: Pick<GithubClient['budget'], 'pausedUntil'>;
  };
  readonly store: WatchStore;
  readonly projects: () => Promise<readonly ProjectInfo[]>;
  readonly accounts: () => Promise<readonly GitAccount[]>;
  readonly config: () => PullsConfig | undefined;
  /** Hands one push to Access. `undefined` while Access is not there: events are then recorded but not sent. */
  readonly buzz: () => ((buzz: PullBuzz) => Promise<unknown>) | undefined;
  /** Tells open screens a project's PRs or CI changed. */
  readonly changed: (project: string) => void;
  readonly nowMs: () => number;
  readonly log: Log;
}

const samePulls = (a: readonly WatchedRepo[], b: readonly WatchedRepo[]): boolean =>
  JSON.stringify(a.map(({ checkedAt: _at, ...rest }) => rest)) ===
  JSON.stringify(b.map(({ checkedAt: _at, ...rest }) => rest));

/**
 * The watch: for each project with watch ON, look at its GitHub repositories on a cadence, keep what was seen, tell open
 * screens when it changed and the phone when something worth a buzz happened.
 *
 * - Nothing is asked of GitHub for a project with watch off (or for a project with no GitHub repository).
 * - One look at a time (a slow GitHub never piles ticks up).
 * - A repository whose read failed keeps what it last showed and tells nobody anything.
 * - The first look at a repository is a silent baseline.
 */
export class WatchService {
  readonly #lastLook = new Map<string, number>();
  readonly #seen = new Map<string, WatchSnapshot>();
  #lastRead: number | undefined;
  #running: Promise<void> | undefined;

  constructor(private readonly deps: WatchDeps) {}

  /** A screen asked for the status: while it keeps asking, the watch looks every minute. */
  markViewed(): void {
    this.#lastRead = this.deps.nowMs();
  }

  /** One pass over every project that is due. Total: a failure is logged, never thrown. */
  tick(): Promise<void> {
    this.#running ??= this.#pass().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #pass(): Promise<void> {
    try {
      const config = this.deps.config();
      const now = this.deps.nowMs();
      const viewed = isViewed(this.#lastRead, now);
      const projects = await this.deps.projects();
      const watched = projects.filter(project => settingsOf(config, project.id).watch);
      if (watched.length === 0) return;
      const accounts = await this.deps.accounts();
      for (const project of watched) {
        const snapshot = await this.#snapshot(project.id);
        const wait = intervalFor(snapshot?.repos ?? [], viewed);
        const last = this.#lastLook.get(project.id);
        if (last !== undefined && now - last < wait) continue;
        this.#lastLook.set(project.id, now);
        await this.#look(project, accounts, config);
      }
    } catch (error) {
      this.deps.log.warn('a PR watch pass failed', { reason: error instanceof Error ? error.name : 'error' });
    }
  }

  async #snapshot(project: string): Promise<WatchSnapshot | undefined> {
    const kept = this.#seen.get(project);
    if (kept !== undefined) return kept;
    const read = await this.deps.store.read(project);
    if (read !== undefined) this.#seen.set(project, read);
    return read;
  }

  async #look(project: ProjectInfo, accounts: readonly GitAccount[], config: PullsConfig | undefined): Promise<void> {
    const before = await this.#snapshot(project.id);
    const repos: WatchedRepo[] = [];
    const lines: WatchEventLine[] = [];
    const now = new Date(this.deps.nowMs()).toISOString();
    for (const { repo, account } of reposOf(project, accounts)) {
      if (account === undefined) continue;
      const earlier = before?.repos.find(
        each => each.account === account.id && each.repo.owner === repo.owner && each.repo.name === repo.name,
      );
      const target = { project: project.id, repo, account: account.id as GitAccountId, login: account.login };
      const seen = await observeRepo(this.deps.github, target, earlier?.pulls ?? []);
      if (!seen.ok) {
        // Keep the last good look and say why this one did not answer (a code of ours).
        if (earlier !== undefined) repos.push({ ...earlier, problem: seen.error.code });
        continue;
      }
      repos.push({
        repo,
        account: account.id,
        login: account.login,
        pulls: [...seen.value.pulls],
        checkedAt: now,
      });
      if (earlier !== undefined) lines.push(...eventsOf(earlier.pulls, seen.value.pulls, seen.value.ended));
    }
    const after: WatchSnapshot = { repos };
    this.#seen.set(project.id, after);
    const moved = before === undefined || !samePulls(before.repos, repos);
    // Written BEFORE anything is sent: a crash in between loses a buzz, never repeats one.
    if (moved) await this.deps.store.write(project.id, after);
    if (moved) this.deps.changed(project.id);
    await this.#tell(project.id, lines, settingsOf(config, project.id).notify);
  }

  async #tell(
    project: string,
    lines: readonly WatchEventLine[],
    notify: Readonly<Record<string, boolean>>,
  ): Promise<void> {
    const send = this.deps.buzz();
    if (send === undefined) return;
    for (const line of lines) {
      if (!WATCH_EVENTS.includes(line.event) || notify[line.event] !== true) continue;
      try {
        await send(buzzOf(project, line));
      } catch (error) {
        this.deps.log.warn('a PR push could not be sent', { reason: error instanceof Error ? error.name : 'error' });
      }
    }
  }

  /** The status every screen draws. Reading it counts as having the screen open. */
  async overview(): Promise<WatchOverview> {
    this.markViewed();
    const config = this.deps.config();
    const [projects, accounts] = await Promise.all([this.deps.projects(), this.deps.accounts()]);
    const out: WatchProjectView[] = [];
    for (const project of projects) {
      const settings = settingsOf(config, project.id);
      const snapshot = await this.#snapshot(project.id);
      const refs = reposOf(project, accounts);
      const known = new Set(accounts.map(account => account.id));
      const paused = (snapshot?.repos ?? [])
        .filter(repo => known.has(repo.account))
        .map(repo => this.deps.github.budget.pausedUntil(repo.account as GitAccountId, 'rest'))
        .filter((until): until is number => until !== undefined);
      out.push({
        project: project.id,
        watch: settings.watch,
        notify: settings.notify,
        // A snapshot of an account that is gone is not shown (its next look drops it).
        repos: (snapshot?.repos ?? []).filter(repo => known.has(repo.account)),
        needsAccount: refs.filter(ref => ref.account === undefined).map(ref => ref.repo),
        ...(paused.length === 0 ? {} : { pausedUntil: new Date(Math.max(...paused)).toISOString() }),
      });
    }
    return { projects: out };
  }

  /** A project is gone: its snapshot, its memory and its timer go with it. */
  async forgetProject(project: string): Promise<void> {
    this.#seen.delete(project);
    this.#lastLook.delete(project);
    await this.deps.store.remove(project);
  }

  /** An account is gone: what it read is dropped from every project, at once. */
  async forgetAccount(account: string): Promise<void> {
    for (const project of await this.deps.store.projects()) {
      const snapshot = await this.#snapshot(project);
      if (snapshot === undefined || !snapshot.repos.some(repo => repo.account === account)) continue;
      const next: WatchSnapshot = { repos: snapshot.repos.filter(repo => repo.account !== account) };
      this.#seen.set(project, next);
      await this.deps.store.write(project, next);
      this.deps.changed(project);
    }
  }
}
