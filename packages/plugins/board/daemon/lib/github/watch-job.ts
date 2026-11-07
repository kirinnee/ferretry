/**
 * THE BOARD'S GITHUB WATCH, AS ONE JOB (folded from the c50 `board-github` module; board-design.md §3.1).
 *
 * The watcher runs the host's own `gh`, links the PRs a card's work opened, and nudges through the board's nudge path. It
 * serves no route, so it contributes nothing to the mounted surface: it owns the alert path every board nudge passes
 * through ({@link BoardAlerts}) and the Unfiled board's refile ({@link UnfiledRefiler}). One job, armed after listen.
 *
 * WHAT `build()` MUST WIRE (the plugin's `daemon/index.ts`, in the adapters+routes half; this file is pure and builds
 * from ports alone):
 *
 * - `kernel.jobs.add(job)` with the {@link GithubWatch.job} this returns. Its schedule is `{ every: WATCH_TICK_MS }`, and
 *   its first run is the kernel's, after listen; the old jitter between ticks is dropped (the kernel coalesces a run
 *   that is still going, and each repository's own poll delay stays jittered in `plan.ts`).
 * - `kernel.events` / the Board service's `afterWrite` is NOT involved: the watcher writes cards through
 *   {@link WatchedBoard.act} (the Board service, as `{ kind: 'daemon' }`), so every write goes through the one section.
 * - `ports.gh` = a `GhRunner` over `kernel.spawn` (`gh` with the host's own login; never a token of ours);
 *   `ports.copies` = `WorkingCopies` over `kernel.spawn` (`git` in a card's working copy).
 * - `ports.transcripts` = the Conversation contract's transcript tail (`ConversationApi`) mapped to {@link FerretTranscriptTail};
 *   `ports.ferretFolders.cwdOf` = `FerretsApi.get(ferret)` folder; `ports.projects` = `ProjectsApi` (folders and ids).
 * - `alerts.mode` = the ferret's send mode (Conversation's queue); `alerts.send` = `ConversationApi.send` with a fresh
 *   send id; `alerts.withheld` = the journal of a withheld alert on that ferret (Conversation).
 * - `roster` = the Ferrets contract's live roster as {@link FerretRoster}; `helpers` = {@link HelperDirectory}.
 * - `refiler.sessions` (`FerretBoards`) = the project a ferret's folder belongs to, registering its repository by
 *   `ProjectAdoption`'s rules; `refiler.lanes.propose` = the inferred lane proposal as the card's ferret.
 * - `clock` = `kernel.clock` (`now()` as an instant string, `random()` for jitter); `diagnostics.warn` = the log.
 */
import { milliseconds } from '@ferretry/std';
import type { JobSpec } from '@ferretry/kernel/contract';
import {
  AlertSurface,
  type AlertSurfacePorts,
  alertFallback,
  type BoardAlertPorts,
  BoardAlerts,
  type BoardDiagnostics,
  type FerretRoster,
  type HelperDirectory,
  noticeRecipient,
  nudgeTarget,
} from '../board/index.ts';
import { WATCH_TICK_MS } from './plan.ts';
import { GitHubWatcher, type GitHubWatcherPorts } from './watcher.ts';
import { UnfiledRefiler, type UnfiledRefilerPorts } from './unfiled.ts';

/** What the watch is built from: every port, already shaped for this lib. */
export interface GithubWatchNeeds {
  /** The ordinary send path and the journal of what was held back. */
  readonly alerts: Omit<BoardAlertPorts, 'surface'>;
  /** Where a withheld alert about a private card is noted. */
  readonly surface: AlertSurfacePorts;
  /** The live ferrets, so a nudge is routed to the card's assignee, else the nearest live lead, else the owner. */
  readonly roster: () => Promise<FerretRoster>;
  readonly helpers: HelperDirectory;
  readonly refiler: UnfiledRefilerPorts;
  readonly watcher: Omit<GitHubWatcherPorts, 'unfiled' | 'nudges' | 'diagnostics' | 'clock'>;
  readonly clock: GitHubWatcherPorts['clock'];
  readonly diagnostics: BoardDiagnostics;
}

/** What the watch provides: the alert path every board nudge passes, the Unfiled refile, the watcher, and its one job. */
export interface GithubWatch {
  /** Every board alert — stale, red CI, closed unmerged — passes here, whoever it was routed to. */
  readonly alerts: BoardAlerts;
  /** The Unfiled board's refile: ONE instance, so the watcher's tick and the boot run never overlap. */
  readonly unfiled: UnfiledRefiler;
  readonly watcher: GitHubWatcher;
  /** The job to add to the kernel: one tick every {@link WATCH_TICK_MS}, a failure reported, never thrown. */
  readonly job: JobSpec;
}

export const GITHUB_WATCH_JOB_ID = 'board-github-watch';

/** Builds the watch from its ports. Pure: no timer is started here; the kernel runs {@link GithubWatch.job}. */
export const githubWatchJob = (needs: GithubWatchNeeds): GithubWatch => {
  const surface = new AlertSurface(needs.surface);
  const alerts = new BoardAlerts({
    ...needs.alerts,
    surface: async (card, message) => {
      await surface.surface(card, message).catch((error: unknown) => {
        needs.diagnostics.warn(`could not surface a withheld alert on ${card}'s board: ${String(error)}`);
      });
    },
  });
  const unfiled = new UnfiledRefiler(needs.refiler);
  const watcher = new GitHubWatcher({
    ...needs.watcher,
    clock: needs.clock,
    diagnostics: needs.diagnostics,
    unfiled,
    // The board's nudge path: the message as it is, from "Ferretry · Board" as metadata. It goes to the card's assignee,
    // else the nearest live lead above it, else the owner (notice-route.ts). With nobody alive it falls back to who the
    // alert went to before routing, via nudgeTarget (a helper's lead).
    nudges: {
      send: async (card, message, reason) => {
        const recipient = noticeRecipient(await needs.roster(), card);
        const ferret = recipient?.ferret ?? (await nudgeTarget(needs.helpers, alertFallback(card, reason)));
        await alerts.send(ferret, message, card.id);
      },
    },
  });
  return {
    alerts,
    unfiled,
    watcher,
    job: {
      id: GITHUB_WATCH_JOB_ID,
      schedule: { every: milliseconds(WATCH_TICK_MS) },
      run: async signal => {
        await watcher.run(signal);
      },
    },
  };
};
