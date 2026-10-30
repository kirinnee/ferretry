/**
 * THE GITHUB WATCHER (`board-design.md` §3.1 items 4 and 7): polls GitHub for the PRs on the board, links
 * the ones a card's work opened, and moves cards on the facts — opened, ready, checks, merged, released,
 * and running on this machine.
 *
 * The daemon has no public endpoint, so GitHub cannot call it; the watcher asks instead, through the host's
 * own `gh` (see `ports.ts`). One tick:
 *
 *   1. reads the board as stored, and the repository each registered project's `origin` names;
 *   2. gathers, per repository, the linked PRs GitHub can still change and the branches a card's work is on
 *      (the card's `links.branch`, and the branch its assignee's folder has checked out);
 *   3. polls each repository that is DUE — one GraphQL query for all of it — and schedules its next poll a
 *      minute out while it has an open PR, ten minutes out when it has none;
 *   4. looks for the first release containing each merge (`releases.ts`), at a bounded number of compares;
 *   5. writes each card that changed through `BoardService.recordPullRequests`, as the daemon, and queues
 *      the nudges that write handed back;
 *   6. refiles Unfiled cards whose PR's repository a project owns.
 *
 * Auto-link from a session (its branch, its own `gh pr create`) applies only when that session is the
 * assignee of exactly ONE card still before shipping: a lead assigned to forty cards opens PRs for all of
 * them, and which card a PR belongs to is then not the watcher's to guess.
 *
 * `gh` missing or signed out: every card's PR state simply stays where it is (`unknown` for a new link),
 * the board's diagnostics hear it ONCE, and the watcher looks again at the idle pace. It never throws out
 * of a tick; a failure is reported and the next tick runs.
 */
import { type BoardTask, formatTaskRef, ProtocolVersionSchema, prUrlParts, type ReleasedIn } from '@ferretry/protocol';
import {
  applyPrUpdate,
  type BoardDiagnostics,
  BoardIndex,
  effectiveAssignee,
  type LaneSets,
  type PrObservation,
  type PrUpdate,
} from '../board/index.ts';
import type { SessionTranscriptTail } from '../session/reads/service.ts';
import {
  cardCategory,
  isLinkable,
  isWatched,
  jittered,
  MAX_COMPARES_PER_TICK,
  MAX_REPOSITORIES_PER_TICK,
  needsPoll,
  PROJECT_REMOTES_TTL_MS,
  pollDelay,
  prKey,
  refileTargets,
  repoKey,
  SHARED_BRANCHES,
  WATCH_FIRST_TICK_MS,
  WATCH_TICK_MS,
} from './plan.ts';
import type {
  GhOutcome,
  GhRunner,
  PrNudgeSender,
  ProjectFolders,
  SessionFolders,
  WatchedBoard,
  WatcherClock,
  WatcherTimers,
  WorkingCopies,
} from './ports.ts';
import { parseRepositoryAnswer, pollArguments, type RepositoryAnswer, type RepositoryPoll } from './query.ts';
import { compareArguments, MAX_COMPARES_PER_PR, releaseCandidates, releasedIn, tagContains } from './releases.ts';
import { createdPrUrls, TRANSCRIPT_EVENTS_SCANNED } from './transcript.ts';

export interface GitHubWatcherPorts {
  readonly board: WatchedBoard;
  readonly gh: GhRunner;
  readonly copies: WorkingCopies;
  readonly sessions: SessionFolders;
  readonly projects: ProjectFolders;
  readonly transcripts: SessionTranscriptTail;
  readonly nudges: PrNudgeSender;
  readonly timers: WatcherTimers;
  readonly clock: WatcherClock;
  readonly diagnostics: BoardDiagnostics;
  /** This daemon's own version: a card enters its `release.running` lane once this runs its release. */
  readonly version: string;
}

/** What one tick did, for tests and for an operator who asks. */
export interface WatchReport {
  /** The repositories polled, as `owner/name`. */
  readonly polled: readonly string[];
  /** The cards written. */
  readonly written: readonly string[];
  /** The cards refiled. */
  readonly refiled: readonly string[];
  /** Whether GitHub could be reached at all this tick. */
  readonly reachable: boolean;
}

/** A branch a card's work is on, in one repository, and how the watcher knows. */
interface BranchCandidate {
  readonly repo: string;
  readonly branch: string;
  readonly because: string;
}

interface CardCandidates {
  readonly branches: readonly BranchCandidate[];
  readonly createdUrls: readonly { readonly url: string; readonly because: string }[];
}

interface ProjectRemote {
  readonly id: string;
  readonly name: string;
  readonly repo: string | null;
}

export const GH_MISSING_WARNING =
  'GitHub watcher: `gh` is not installed on this host, so PR state on the board stays unknown; install the GitHub CLI (see `fy doctor`)';
export const ghSignedOutWarning = (detail: string): string =>
  `GitHub watcher: \`gh\` is not signed in (${detail}), so PR state on the board stays unknown; run \`gh auth login\``;

const NO_CANDIDATES: CardCandidates = { branches: [], createdUrls: [] };

const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class GitHubWatcher {
  /** When each repository (case-folded) is next due. Forgotten on restart, so a fresh daemon polls at once. */
  private readonly due = new Map<string, number>();
  /** PRs (`owner/name#n`, case-folded) already asked about once while their state was unknown. */
  private readonly looked = new Set<string>();
  /** Release tags already known NOT to contain a merge, keyed `repo#sha`: each pair is compared once. */
  private readonly notIn = new Map<string, Set<string>>();
  /** The keys warned about, so each problem is reported once until it clears. */
  private readonly warned = new Set<string>();
  private remotes: { readonly at: number; readonly projects: readonly ProjectRemote[] } | undefined;
  private stopped = false;

  constructor(private readonly ports: GitHubWatcherPorts) {}

  /**
   * Starts the loop: a first tick shortly after boot, then one every {@link WATCH_TICK_MS} (jittered),
   * each scheduled when the last has finished so two never overlap. Returns the stop: no tick starts after
   * it, and one already running writes nothing more.
   */
  arm(): () => void {
    this.stopped = false;
    let cancel: (() => void) | undefined;
    const schedule = (ms: number): void => {
      cancel = this.ports.timers.after(ms, async () => {
        await this.run();
        if (!this.stopped) schedule(jittered(WATCH_TICK_MS, this.ports.clock.random()));
      });
    };
    schedule(jittered(WATCH_FIRST_TICK_MS, this.ports.clock.random()));
    return () => {
      this.stopped = true;
      cancel?.();
    };
  }

  /** One tick that never rejects: a failure is reported to the board's diagnostics. */
  async run(): Promise<WatchReport | null> {
    try {
      return await this.tick();
    } catch (error) {
      this.ports.diagnostics.warn(`GitHub watcher: a tick failed: ${detail(error)}`);
      return null;
    }
  }

  /** One look at GitHub and the board (see the file header). */
  async tick(): Promise<WatchReport> {
    const { cards, laneSets } = await this.ports.board.snapshot();
    const nowMs = Date.parse(this.ports.clock.now());
    const watched = cards.filter(card => isWatched(card, laneSets));
    const projects = await this.projectRemotes(nowMs);
    const candidates = await this.candidates(watched, laneSets, projects);
    const polls = this.polls(watched, candidates);
    const fresh = this.freshRepositories(watched);
    const { answers, reachable, polled } = await this.poll(polls, nowMs, fresh);
    const claimed = new Set(cards.flatMap(card => card.links.prs.map(pr => prKey(pr.repo, pr.number))));
    const budget = { compares: MAX_COMPARES_PER_TICK };
    const written: string[] = [];
    for (const card of watched) {
      if (this.stopped) break;
      const update = await this.updateFor(card, candidates.get(card.id) ?? NO_CANDIDATES, answers, claimed, budget);
      if (!this.wouldChange(card, update, cards, laneSets)) continue;
      if (await this.record(card, update)) written.push(card.id);
    }
    const refiled = this.stopped ? [] : await this.refile(cards, laneSets, projects, nowMs);
    return { polled, written, refiled, reachable };
  }

  // -------------------------------------------------------------------------------------------------
  // Gathering
  // -------------------------------------------------------------------------------------------------

  /** Each registered project's repository, read again after {@link PROJECT_REMOTES_TTL_MS}. */
  private async projectRemotes(nowMs: number): Promise<readonly ProjectRemote[]> {
    if (this.remotes !== undefined && nowMs - this.remotes.at < PROJECT_REMOTES_TTL_MS) return this.remotes.projects;
    const listed = await this.ports.projects.projects().catch((error: unknown) => {
      this.warnOnce('projects', `GitHub watcher: could not list the projects: ${detail(error)}`);
      return [];
    });
    const projects = await Promise.all(
      listed.map(async project => ({
        id: project.id,
        name: project.name,
        repo: await this.ports.copies.repositoryOf(project.path),
      })),
    );
    this.remotes = { at: nowMs, projects };
    return projects;
  }

  /** The branches and `gh pr create` URLs each linkable card's work points at. */
  private async candidates(
    watched: readonly BoardTask[],
    laneSets: LaneSets,
    projects: readonly ProjectRemote[],
  ): Promise<ReadonlyMap<string, CardCandidates>> {
    const linkable = watched.filter(card => isLinkable(card, laneSets));
    const assigned = new Map<string, number>();
    for (const card of linkable) {
      const session = effectiveAssignee(card);
      assigned.set(session, (assigned.get(session) ?? 0) + 1);
    }
    const found = new Map<string, CardCandidates>();
    for (const card of linkable) {
      const session = effectiveAssignee(card);
      const projectRepo = projects.find(project => project.id === card.projectId)?.repo ?? null;
      const named = [projectRepo, ...card.links.prs.map(pr => pr.repo)].filter((repo): repo is string => repo !== null);
      const repos = [...new Map(named.map(repo => [repoKey(repo), repo] as const)).values()];
      const branches: BranchCandidate[] =
        card.links.branch === null || SHARED_BRANCHES.has(card.links.branch)
          ? []
          : repos.map(repo => ({
              repo,
              branch: card.links.branch as string,
              because: `its head branch ${card.links.branch as string} is the card's branch`,
            }));
      const own = assigned.get(session) === 1;
      const sessionBranch = own ? await this.sessionBranch(session) : null;
      if (sessionBranch !== null) {
        branches.push({
          ...sessionBranch,
          because: `its head branch ${sessionBranch.branch} is checked out where ${session} works`,
        });
      }
      const createdUrls = own
        ? (await this.createdBy(session)).map(url => ({ url, because: `${session} opened it with gh pr create` }))
        : [];
      if (branches.length > 0 || createdUrls.length > 0) found.set(card.id, { branches, createdUrls });
    }
    return found;
  }

  /** The repository and branch a session's folder has checked out, when it is a branch of its own. */
  private async sessionBranch(sessionId: string): Promise<{ readonly repo: string; readonly branch: string } | null> {
    const cwd = await this.ports.sessions.cwdOf(sessionId).catch(() => null);
    if (cwd === null) return null;
    const [repo, branch] = await Promise.all([this.ports.copies.repositoryOf(cwd), this.ports.copies.branchOf(cwd)]);
    return repo === null || branch === null || SHARED_BRANCHES.has(branch) ? null : { repo, branch };
  }

  /** The PRs a session opened with its own `gh pr create`, from the newest part of its transcript. */
  private async createdBy(sessionId: string): Promise<readonly string[]> {
    const tail = await this.ports.transcripts.tail(sessionId, TRANSCRIPT_EVENTS_SCANNED).catch(() => undefined);
    return tail?.kind === 'read' ? createdPrUrls(tail.events) : [];
  }

  /** What each repository will be asked: its linked PRs that can change, and the branches to look for. */
  private polls(
    watched: readonly BoardTask[],
    candidates: ReadonlyMap<string, CardCandidates>,
  ): ReadonlyMap<string, RepositoryPoll> {
    const polls = new Map<string, { repo: string; numbers: Set<number>; branches: Set<string>; releases: boolean }>();
    const entry = (repo: string) => {
      const key = repoKey(repo);
      const existing = polls.get(key);
      if (existing !== undefined) return existing;
      const created = { repo, numbers: new Set<number>(), branches: new Set<string>(), releases: false };
      polls.set(key, created);
      return created;
    };
    for (const card of watched) {
      for (const pr of card.links.prs.filter(needsPoll)) {
        const poll = entry(pr.repo);
        poll.numbers.add(pr.number);
        if (pr.state !== 'open') poll.releases = true;
      }
      for (const candidate of candidates.get(card.id)?.branches ?? [])
        entry(candidate.repo).branches.add(candidate.branch);
    }
    return new Map(
      [...polls].map(([key, poll]) => [
        key,
        { repo: poll.repo, numbers: [...poll.numbers], branches: [...poll.branches], releases: poll.releases },
      ]),
    );
  }

  // -------------------------------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------------------------------

  /**
   * The repositories with a linked PR nobody has asked GitHub about yet, and those PRs: a repository is
   * polled at once rather than when its cadence next comes round, so a PR linked after it merged moves its
   * card within one tick. Each PR gets that one early look, whatever GitHub answers.
   */
  private freshRepositories(watched: readonly BoardTask[]): ReadonlyMap<string, readonly string[]> {
    const fresh = new Map<string, string[]>();
    for (const card of watched) {
      for (const pr of card.links.prs) {
        const key = prKey(pr.repo, pr.number);
        if (pr.state !== 'unknown' || this.looked.has(key)) continue;
        fresh.set(repoKey(pr.repo), [...(fresh.get(repoKey(pr.repo)) ?? []), key]);
      }
    }
    return fresh;
  }

  /** Polls the repositories that are due, at most {@link MAX_REPOSITORIES_PER_TICK} of them, longest-waiting first. */
  private async poll(
    polls: ReadonlyMap<string, RepositoryPoll>,
    nowMs: number,
    fresh: ReadonlyMap<string, readonly string[]>,
  ): Promise<{ answers: Map<string, RepositoryAnswer>; reachable: boolean; polled: string[] }> {
    const answers = new Map<string, RepositoryAnswer>();
    const polled: string[] = [];
    // A repository name that is not `owner/name` cannot be asked about at all, so it takes no slot.
    const due = [...polls]
      .flatMap(([key, poll]) => {
        const args = pollArguments(poll);
        return args === null || ((this.due.get(key) ?? 0) > nowMs && !fresh.has(key)) ? [] : [{ key, poll, args }];
      })
      .toSorted((left, right) => (this.due.get(left.key) ?? 0) - (this.due.get(right.key) ?? 0))
      .slice(0, MAX_REPOSITORIES_PER_TICK);
    for (const { key, poll, args } of due) {
      if (this.stopped) break;
      const outcome = await this.ports.gh.run(args);
      for (const asked of fresh.get(key) ?? []) this.looked.add(asked);
      if (this.unreachable(outcome)) {
        for (const pending of polls.keys()) this.due.set(pending, nowMs + pollDelay(false, this.ports.clock.random()));
        return { answers, reachable: false, polled };
      }
      polled.push(poll.repo);
      const answer =
        outcome.kind === 'ok' || outcome.kind === 'failed' ? parseRepositoryAnswer(outcome.stdout, poll) : null;
      if (answer === null) {
        const why = outcome.kind === 'failed' ? outcome.detail : 'GitHub answered with no repository';
        this.warnOnce(`repo:${key}`, `GitHub watcher: could not poll ${poll.repo}: ${why}`);
        this.due.set(key, nowMs + pollDelay(false, this.ports.clock.random()));
        continue;
      }
      this.warned.delete(`repo:${key}`);
      answers.set(key, answer);
      const open = [...answer.prs.values(), ...[...answer.branches.values()].flat()].some(
        pr => pr.observation.state === 'open',
      );
      this.due.set(key, nowMs + pollDelay(open, this.ports.clock.random()));
    }
    return { answers, reachable: true, polled };
  }

  /** Whether an outcome says GitHub cannot be reached from this host at all; warns once if so. */
  private unreachable(outcome: GhOutcome): boolean {
    if (outcome.kind === 'missing') {
      this.warnOnce('gh', GH_MISSING_WARNING);
      return true;
    }
    if (outcome.kind === 'unauthenticated') {
      this.warnOnce('gh', ghSignedOutWarning(outcome.detail));
      return true;
    }
    this.warned.delete('gh');
    return false;
  }

  // -------------------------------------------------------------------------------------------------
  // Per card
  // -------------------------------------------------------------------------------------------------

  /** One card's update from this tick's answers: what was observed, what to link, which releases were found. */
  private async updateFor(
    card: BoardTask,
    candidates: CardCandidates,
    answers: ReadonlyMap<string, RepositoryAnswer>,
    claimed: Set<string>,
    budget: { compares: number },
  ): Promise<PrUpdate> {
    const observed: PrObservation[] = [];
    const link: { url: string; because: string }[] = [];
    for (const pr of card.links.prs) {
      const polled = answers.get(repoKey(pr.repo))?.prs.get(pr.number);
      if (polled !== undefined) observed.push({ ...polled.observation, url: pr.url });
    }
    for (const candidate of candidates.branches) {
      for (const pr of answers.get(repoKey(candidate.repo))?.branches.get(candidate.branch) ?? []) {
        const key = prKey(candidate.repo, pr.number);
        const fresh =
          pr.observation.state === 'open' ||
          (pr.observation.state === 'merged' &&
            Date.parse(pr.observation.mergedAt ?? '') >= Date.parse(card.createdAt));
        if (!fresh || claimed.has(key)) continue;
        claimed.add(key);
        link.push({ url: pr.observation.url, because: candidate.because });
        observed.push(pr.observation);
      }
    }
    for (const created of candidates.createdUrls) {
      const parts = prUrlParts(created.url);
      const key = parts === null ? undefined : prKey(parts.repo, parts.number);
      if (key === undefined || claimed.has(key)) continue;
      claimed.add(key);
      link.push(created);
    }
    const releases = await this.releasesFor(card, observed, answers, budget);
    return { link, observed, releases, runningVersion: this.runningVersion() };
  }

  /** The release each merged, unreleased PR of the card first shipped in, as far as this tick can tell. */
  private async releasesFor(
    card: BoardTask,
    observed: readonly PrObservation[],
    answers: ReadonlyMap<string, RepositoryAnswer>,
    budget: { compares: number },
  ): Promise<readonly { readonly url: string; readonly releasedIn: ReleasedIn }[]> {
    const found: { url: string; releasedIn: ReleasedIn }[] = [];
    for (const pr of card.links.prs) {
      if (pr.releasedIn !== null) continue;
      const seen = observed.find(entry => entry.url === pr.url);
      const mergedAt = seen === undefined ? pr.mergedAt : seen.mergedAt;
      const mergeSha = seen === undefined ? pr.mergeSha : seen.mergeSha;
      const releases = answers.get(repoKey(pr.repo))?.releases;
      if (mergedAt === null || mergeSha === null || releases === null || releases === undefined) continue;
      const known = this.notIn.get(`${repoKey(pr.repo)}#${mergeSha}`) ?? new Set<string>();
      this.notIn.set(`${repoKey(pr.repo)}#${mergeSha}`, known);
      const candidates = (releaseCandidates(releases, mergedAt) ?? []).filter(release => !known.has(release.tag));
      for (const release of candidates.slice(0, MAX_COMPARES_PER_PR)) {
        if (budget.compares <= 0) return found;
        budget.compares -= 1;
        const outcome = await this.ports.gh.run(compareArguments(pr.repo, mergeSha, release.tag));
        const contains = outcome.kind === 'ok' ? tagContains(outcome.stdout) : null;
        if (contains === null) break;
        if (contains) {
          found.push({ url: pr.url, releasedIn: releasedIn(release) });
          break;
        }
        known.add(release.tag);
      }
    }
    return found;
  }

  /** This daemon's version when it reads as one; a development build's label never claims a release. */
  private runningVersion(): string | null {
    return ProtocolVersionSchema.safeParse(this.ports.version).success ? this.ports.version : null;
  }

  /**
   * Whether an update would change the card, decided by the same rules the write applies, on the card as
   * this tick read it. It keeps a poll that learned nothing from costing a card write.
   */
  private wouldChange(card: BoardTask, update: PrUpdate, cards: readonly BoardTask[], laneSets: LaneSets): boolean {
    const laneSet = laneSets.get(card.projectId);
    if (laneSet === undefined || cardCategory(card, laneSets) === null) return false;
    const dry = applyPrUpdate(card, update, {
      now: this.ports.clock.now(),
      actor: { kind: 'daemon' },
      standing: 'daemon',
      laneSet,
      index: new BoardIndex(cards, ''),
      laneSets,
    });
    return dry.task !== null;
  }

  /** Writes one card's update and queues its nudges. `true` when the card was written. */
  private async record(card: BoardTask, update: PrUpdate): Promise<boolean> {
    try {
      const outcome = await this.ports.board.recordPullRequests(card.id, update);
      this.warned.delete(`card:${card.id}`);
      for (const nudge of outcome.nudges) {
        await this.ports.nudges
          .send(nudge.sessionId, nudge.message)
          .catch((error: unknown) =>
            this.ports.diagnostics.warn(
              `GitHub watcher: could not nudge ${nudge.sessionId} about ${formatTaskRef(card)}: ${detail(error)}`,
            ),
          );
      }
      return outcome.task !== null;
    } catch (error) {
      this.warnOnce(`card:${card.id}`, `GitHub watcher: could not update ${formatTaskRef(card)}: ${detail(error)}`);
      return false;
    }
  }

  /** Refiles the Unfiled cards a project's repository claims. */
  private async refile(
    cards: readonly BoardTask[],
    laneSets: LaneSets,
    projects: readonly ProjectRemote[],
    nowMs: number,
  ): Promise<readonly string[]> {
    const owners = new Map<string, { id: string; name: string }>();
    for (const project of projects) {
      if (project.repo !== null && !owners.has(repoKey(project.repo))) {
        owners.set(repoKey(project.repo), { id: project.id, name: project.name });
      }
    }
    const refiled: string[] = [];
    for (const target of refileTargets(cards, laneSets, owners, nowMs)) {
      const ref = formatTaskRef(target.card);
      try {
        await this.ports.board.act(
          target.card.id,
          { action: 'refile', projectId: target.projectId, reason: target.reason },
          { kind: 'daemon' },
        );
        this.warned.delete(`refile:${target.card.id}`);
        refiled.push(target.card.id);
      } catch (error) {
        this.warnOnce(`refile:${target.card.id}`, `GitHub watcher: could not refile ${ref}: ${detail(error)}`);
      }
    }
    return refiled;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ports.diagnostics.warn(message);
  }
}
