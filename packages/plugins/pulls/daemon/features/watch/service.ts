import type { Log } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import type { GitAccount, GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import {
  PULLS_CODES,
  settingsOf,
  WATCH_EVENTS,
  type PullsConfig,
  type WatchedRepo,
  type WatchOverview,
  type WatchProjectView,
  type WatchSnapshot,
} from '../../../contract/index.ts';
import type { GithubClient, ReadFailure } from '../../adapters/github/client.ts';
import { intervalFor, isViewed } from './cadence.ts';
import { eventsOf, type WatchEventLine } from './events.ts';
import { observeRepo, type Observation } from './observe.ts';
import { hasReader, reposOf, type WatchedRepoRef } from './repos.ts';
import type { WatchStore } from './store.ts';
import { buzzOf, summaryBuzzOf, type PullBuzz } from './words.ts';

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
  /** In [0, 1): the jitter of a backoff, so projects that failed together do not all come back together. */
  readonly random: () => number;
  readonly log: Log;
}

/** At most this many projects are looked at in one pass; the rest are due next tick, so a long list is paced, not a burst. */
const MAX_LOOKS_PER_PASS = 3;
/** After a 5xx from GitHub an account is left alone for 30 s, doubling per failure in a row up to 15 min, jittered down to half. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 900_000;
/** More than this many alerts of one kind in one repository, in one pass, become ONE alert that counts them. */
const SUMMARY_ABOVE = 3;

interface Hold {
  readonly code: string;
  readonly untilMs: number;
}

const samePulls = (a: readonly WatchedRepo[], b: readonly WatchedRepo[]): boolean =>
  JSON.stringify(a.map(({ checkedAt: _at, ...rest }) => rest)) ===
  JSON.stringify(b.map(({ checkedAt: _at, ...rest }) => rest));

const accountIdsOf = (refs: readonly WatchedRepoRef[]): string[] =>
  refs.flatMap(ref => (ref.account === undefined ? [] : [ref.account.id]));

/** The repositories a project reads and the account each is read as: two looks agree when this text does. */
const linksOf = (refs: readonly WatchedRepoRef[]): string =>
  refs.map(ref => `${ref.repo.owner}/${ref.repo.name}@${ref.account?.id ?? ''}`).join(',');

/** Each (event, repository) group over {@link SUMMARY_ABOVE} becomes one alert that counts them; the rest go as they are. */
function coalesce(project: string, lines: readonly WatchEventLine[]): readonly PullBuzz[] {
  const groups = new Map<string, WatchEventLine[]>();
  for (const line of lines) {
    const key = `${line.event}|${line.pull.repo.owner}/${line.pull.repo.name}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [...groups.values()].flatMap(group =>
    group.length > SUMMARY_ABOVE ? [summaryBuzzOf(project, group)] : group.map(line => buzzOf(project, line)),
  );
}

/**
 * The watch: for each project with watch ON, look at its GitHub repositories on a cadence, keep what was seen, tell open
 * screens when it changed and the phone when something worth a buzz happened.
 *
 * - Nothing is asked of GitHub for a project with watch off (or for a project with no GitHub repository).
 * - One look at a time (a slow GitHub never piles ticks up).
 * - A repository whose read failed keeps what it last showed and tells nobody anything.
 * - The first look at a repository is a silent baseline.
 * - An account is one budget for every project: GitHub's `Retry-After`, a secondary limit, a 429 and a run of 5xx each make
 *   it wait (backoff capped and jittered), and until then no project reading as it asks anything.
 * - A look that lands after its project, its link or its account is gone writes nothing and sends nothing, and the link is
 *   read again right before each GitHub read, so a link removed mid-pass means no read at all.
 */
export class WatchService {
  readonly #lastLook = new Map<string, number>();
  readonly #seen = new Map<string, WatchSnapshot>();
  /** Bumped when a project (by id) or an account (by id) goes: a look that began before the bump is stale. */
  readonly #generation = new Map<string, number>();
  readonly #backoff = new Map<string, { fails: number; untilMs: number }>();
  #lastRead: number | undefined;
  #running: Promise<void> | undefined;
  /** Writes and removals of snapshots, one at a time, so a stale look can never land after a removal. */
  #chain: Promise<unknown> = Promise.resolve();

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
      const [projects, accounts] = await Promise.all([this.deps.projects(), this.deps.accounts()]);
      const watched = projects.filter(project => settingsOf(config, project.id, hasReader(project, accounts)).watch);
      if (watched.length === 0) return;
      const due: ProjectInfo[] = [];
      for (const project of watched) {
        const snapshot = await this.#snapshot(project.id);
        const wait = intervalFor(snapshot?.repos ?? [], viewed);
        const last = this.#lastLook.get(project.id);
        if (last !== undefined && now - last < wait) continue;
        if (this.#waiting(project, accounts)) continue;
        due.push(project);
      }
      // The longest-waiting first, and only a few: the rest are due again on the next tick.
      due.sort((a, b) => (this.#lastLook.get(a.id) ?? -1) - (this.#lastLook.get(b.id) ?? -1));
      for (const project of due.slice(0, MAX_LOOKS_PER_PASS)) {
        // An earlier look in this pass may have made the account wait: this one is not asked, and is still due after.
        if (this.#waiting(project, accounts)) continue;
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

  /** Every account the project reads as is waiting (paused, or backing off), so a look would ask nothing. */
  #waiting(project: ProjectInfo, accounts: readonly GitAccount[]): boolean {
    const readers = accountIdsOf(reposOf(project, accounts));
    const now = this.deps.nowMs();
    return readers.length > 0 && readers.every(id => this.#holdOf(id, now) !== undefined);
  }

  /** Why this account is not asked right now (its budget is paused, or GitHub is failing it), or `undefined`. */
  #holdOf(account: string, now: number): Hold | undefined {
    const paused = this.deps.github.budget.pausedUntil(account as GitAccountId, 'rest');
    if (paused !== undefined) return { code: PULLS_CODES.paused, untilMs: paused };
    const backoff = this.#backoff.get(account);
    return backoff !== undefined && backoff.untilMs > now
      ? { code: PULLS_CODES.github, untilMs: backoff.untilMs }
      : undefined;
  }

  /** What a read taught about the account: an answer ends its backoff, a 5xx lengthens it, anything else changes nothing. */
  #learn(account: string, seen: Result<Observation, ReadFailure>): void {
    if (seen.ok) {
      this.#backoff.delete(account);
      return;
    }
    const status = seen.error.status;
    if (status === undefined || status < 500) return;
    const fails = (this.#backoff.get(account)?.fails ?? 0) + 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (fails - 1));
    this.#backoff.set(account, { fails, untilMs: this.deps.nowMs() + delay * (0.5 + this.deps.random() * 0.5) });
  }

  #bump(key: string): void {
    this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1);
  }

  /** Names the state of a project and the accounts it reads as; it differs once any of them has been removed. */
  #epoch(project: string, accounts: readonly string[]): string {
    return [project, ...accounts].map(key => this.#generation.get(key) ?? 0).join('.');
  }

  /** Runs `work` after every earlier one, whether or not that one failed. */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(work);
    // Settled either way, so one failed piece of work never stops the ones queued after it.
    this.#chain = Promise.allSettled([run]);
    return run;
  }

  async #look(project: ProjectInfo, accounts: readonly GitAccount[], config: PullsConfig | undefined): Promise<void> {
    const before = await this.#snapshot(project.id);
    const refs = reposOf(project, accounts);
    const epoch = this.#epoch(project.id, accountIdsOf(refs));
    const repos: WatchedRepo[] = [];
    const lines: WatchEventLine[] = [];
    const now = new Date(this.deps.nowMs()).toISOString();
    for (const { repo, account } of refs) {
      if (account === undefined) continue;
      const earlier = before?.repos.find(
        each => each.account === account.id && each.repo.owner === repo.owner && each.repo.name === repo.name,
      );
      // The links are read AGAIN right before each read: an earlier read in this pass can take a while, and a project that was
      // unlinked (or removed) meanwhile must not be asked about with its former account.
      if (!(await this.#stillLinked(project, refs))) return;
      const target = { project: project.id, repo, account: account.id as GitAccountId, login: account.login };
      let gone = false;
      // Every read inside the observation asks this again, so a link removed between two of its reads stops the next one.
      const linked = async (): Promise<boolean> => {
        const still = await this.#stillLinked(project, refs);
        if (!still) gone = true;
        return still;
      };
      const seen = await observeRepo(this.deps.github, target, earlier?.pulls ?? [], linked);
      if (gone) return;
      this.#learn(account.id, seen);
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
    const moved = before === undefined || !samePulls(before.repos, repos);
    const kept = await this.#exclusive(async () => {
      // The project, its link or its account went while GitHub was being read: nothing of this look is kept or told.
      if (this.#epoch(project.id, accountIdsOf(refs)) !== epoch || !(await this.#stillLinked(project, refs)))
        return false;
      // Written BEFORE anything is sent: a crash in between loses a buzz, never repeats one. A write that fails leaves the
      // last valid snapshot in place and tells nothing, so the next look compares against it again.
      if (moved) {
        try {
          await this.deps.store.write(project.id, after);
        } catch (error) {
          this.deps.log.warn('a watch snapshot could not be written', {
            reason: error instanceof Error ? error.name : 'error',
          });
          return false;
        }
      }
      this.#seen.set(project.id, after);
      return true;
    });
    if (!kept) return;
    if (moved) this.deps.changed(project.id);
    await this.#tell(project.id, lines, settingsOf(config, project.id, hasReader(project, accounts)).notify);
  }

  /** Whether the project still reads these repositories as these accounts, as it is now. */
  async #stillLinked(project: ProjectInfo, refs: readonly WatchedRepoRef[]): Promise<boolean> {
    const [projects, accounts] = await Promise.all([this.deps.projects(), this.deps.accounts()]);
    const now = projects.find(each => each.id === project.id);
    return now !== undefined && linksOf(reposOf(now, accounts)) === linksOf(refs);
  }

  async #tell(
    project: string,
    lines: readonly WatchEventLine[],
    notify: Readonly<Record<string, boolean>>,
  ): Promise<void> {
    const send = this.deps.buzz();
    if (send === undefined) return;
    const wanted = lines.filter(line => WATCH_EVENTS.includes(line.event) && notify[line.event] === true);
    for (const buzz of coalesce(project, wanted)) {
      try {
        await send(buzz);
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
      const settings = settingsOf(config, project.id, hasReader(project, accounts));
      const snapshot = await this.#snapshot(project.id);
      const refs = reposOf(project, accounts);
      const known = new Set(accounts.map(account => account.id));
      // The accounts it reads as, not only those with something kept: a first read that was refused still shows why.
      const paused = accountIdsOf(refs)
        .map(id => this.deps.github.budget.pausedUntil(id as GitAccountId, 'rest'))
        .filter((until): until is number => until !== undefined);
      out.push({
        project: project.id,
        watch: settings.watch,
        watchedBy: settings.watchedBy,
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
    this.#bump(project);
    await this.#exclusive(async () => {
      this.#seen.delete(project);
      this.#lastLook.delete(project);
      await this.deps.store.remove(project);
    });
  }

  /** An account is gone: what it read is dropped from every project, at once. */
  async forgetAccount(account: string): Promise<void> {
    this.#bump(account);
    this.#backoff.delete(account);
    await this.#exclusive(async () => {
      for (const project of await this.deps.store.projects()) {
        const snapshot = await this.#snapshot(project);
        if (snapshot === undefined || !snapshot.repos.some(repo => repo.account === account)) continue;
        const next: WatchSnapshot = { repos: snapshot.repos.filter(repo => repo.account !== account) };
        this.#seen.set(project, next);
        await this.deps.store.write(project, next);
        this.deps.changed(project);
      }
    });
  }
}
