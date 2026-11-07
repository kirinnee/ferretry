/**
 * THE BOARD'S GITHUB WATCH, AS ONE JOB (folded from the c50 `board-github` module; board-design.md §3.1).
 *
 * The watcher runs the host's own `gh`, links the PRs a card's work opened, and nudges through the board's nudge path. It
 * serves no route, so it contributes nothing to the mounted surface: it owns the alert path every board nudge passes
 * through ({@link BoardAlerts}) and the Unfiled board's refile ({@link UnfiledRefiler}). Two jobs, armed after listen:
 * the watch, and the refile once at start.
 *
 * WHAT `build()` MUST WIRE (the plugin's `daemon/index.ts`, in the adapters+routes half; this file is pure and builds
 * from ports alone):
 *
 * - `kernel.jobs.add` with the two jobs {@link GithubWatch.jobs} returns, given the kernel clock's `sleep`. The watch
 *   is ONE long run (`onceAfterStart`): a first tick `WATCH_FIRST_TICK_MS` (20 s) after start, then one
 *   `WATCH_TICK_MS` (30 s) after each tick FINISHES, every delay jittered by ±10% ({@link GitHubWatcher.watch}). The
 *   refile runs once, {@link BOOT_REFILE_DELAY_MS} after start, whether or not the watch is on: a card that became
 *   refilable while the daemon was down moves without waiting for the watch.
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
import { GitHubWatcher, type GitHubWatcherPorts, type WatchSleep } from './watcher.ts';
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
  /** The jobs to add to the kernel, waiting through `sleep` (the kernel clock's). */
  jobs(sleep: WatchSleep): GithubWatchJobs;
}

/** The watch's two jobs. */
export interface GithubWatchJobs {
  /** The watch: ticks until the daemon stops; a failed tick is reported, never thrown. */
  readonly watch: JobSpec;
  /** The Unfiled board's refile, once at start. */
  readonly refile: JobSpec;
}

export const GITHUB_WATCH_JOB_ID = 'board-github-watch';
export const UNFILED_REFILE_JOB_ID = 'board-unfiled-refile';
/** The refile at start waits this long, so it runs once the boot has settled. */
export const BOOT_REFILE_DELAY_MS = 1_000;

/** Builds the watch from its ports. Pure: no timer is started here; the kernel runs {@link GithubWatch.jobs}. */
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
    jobs: sleep => ({
      watch: {
        id: GITHUB_WATCH_JOB_ID,
        schedule: { onceAfterStart: true },
        run: async signal => {
          await watcher.watch(signal, sleep);
        },
      },
      refile: {
        id: UNFILED_REFILE_JOB_ID,
        schedule: { onceAfterStart: true, delay: milliseconds(BOOT_REFILE_DELAY_MS) },
        run: async () => {
          await unfiled.run();
        },
      },
    }),
  };
};
