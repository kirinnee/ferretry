import { stat } from 'node:fs/promises';
import { type SessionState, SessionStateSchema, type SessionStatus } from '@ferretry/protocol';
import {
  type CapturedFrame,
  type ClockPort,
  capturedFrameIsCurrent,
  isTurnStatus,
  type PaneActivity,
  type PaneState,
  paneBlockingPrompt,
  paneShowsActiveWork,
  paneShowsPermissionPrompt,
  paneStateFrom,
  parseHarnessDialog,
  parsePermissionPrompt,
  type SessionId,
  type SessionTranscriptTail,
  type SessionTurnPorts,
  type TranscriptEvent,
  type TurnPaneEvidence,
  type TurnStateChange,
  type TurnWatchSession,
} from '../../../lib/index.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/** How much of a transcript's end a decision reads: the last turn boundary is always near the end. */
const TAIL_EVENTS = 80;

/** The two terminal reads a tick makes of one tmux session, as `TmuxController` answers them. */
export interface TurnPaneReader {
  /** Metadata and activity stamp in one question; `undefined` when the session is not there. */
  activity(tmuxSession: string): Promise<PaneActivity | undefined>;
  /** The visible frame; `undefined` when tmux could not capture it. */
  visible(tmuxSession: string): Promise<string | undefined>;
}

interface CachedTail {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly events: readonly TranscriptEvent[];
}

/**
 * The turn watcher's ports over this daemon's storage, its transcripts and its own tmux server.
 *
 * Every read is local. The transcript is re-parsed only when its file has CHANGED — size or
 * modification time — so a two-second tick over an idle fleet costs a `stat` per session, not a
 * parse. The pane is treated the same way: ONE question a tick asks for its metadata and activity
 * stamp, and the screen is captured again only when that stamp says it may have changed (see
 * {@link capturedFrameIsCurrent}). The scrollback is never captured here: nothing a turn is decided
 * from reads it, and on a long session it was most of every tick's bytes.
 */
/**
 * Whether a session that is not live leaves the watcher anything to decide. For such a session every
 * settle in `lib/session/turn/policy.ts` answers nothing, so the watcher writes exactly when one of these
 * four is still recorded — and once none is, it never will again until the session is live.
 */
function nothingToSettle(state: SessionState): boolean {
  return (
    state.turnState === undefined &&
    state.turnPrompt === undefined &&
    state.permissionRequest === undefined &&
    state.harnessDialog === undefined
  );
}

export class StorageTurnPorts implements SessionTurnPorts {
  private readonly tails = new Map<SessionId, CachedTail>();
  /**
   * Sessions that are not live and whose state holds no turn left to settle: the watcher would decide
   * nothing about them, so they are not read again until the index says one is live once more.
   *
   * WHY NOT SKIP EVERY ENDED SESSION. A session that has just stopped still carries the turn state it
   * stopped with, and the watcher is what clears it — so each one is read until that has happened.
   */
  private readonly settled = new Set<SessionId>();
  /** The last frame captured of each running pane, by tmux session. */
  private readonly frames = new Map<string, CapturedFrame>();

  constructor(
    private readonly storage: DaemonStorage,
    private readonly tail: SessionTranscriptTail,
    /** The transcript file proved to be this session's, or `undefined` before one is. */
    private readonly transcriptFile: (id: SessionId) => Promise<string | undefined>,
    private readonly panes: TurnPaneReader,
    readonly clock: ClockPort,
  ) {}

  async sessions(): Promise<readonly TurnWatchSession[]> {
    const listed = this.storage.listSessions();
    for (const { id, status } of listed)
      if (status !== undefined && isTurnStatus(status as SessionStatus)) this.settled.delete(id);
    const sessions = await Promise.all(
      listed
        .filter(({ id }) => !this.settled.has(id))
        .map(async ({ id }) => {
          const state = SessionStateSchema.safeParse(await this.storage.readState(id).catch(() => undefined));
          if (!state.success) return undefined;
          if (!isTurnStatus(state.data.status) && nothingToSettle(state.data)) this.settled.add(id);
          return { id, state: state.data } satisfies TurnWatchSession;
        }),
    );
    return sessions.filter(session => session !== undefined);
  }

  async transcript(id: SessionId): Promise<readonly TranscriptEvent[] | undefined> {
    const file = await this.transcriptFile(id).catch(() => undefined);
    if (file === undefined) return undefined;
    const stats = await stat(file).catch(() => undefined);
    if (stats === undefined) return undefined;
    const cached = this.tails.get(id);
    if (cached?.file === file && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.events;
    const read = await this.tail.tail(id, TAIL_EVENTS);
    if (read.kind !== 'read') return undefined;
    this.tails.set(id, { file, size: stats.size, mtimeMs: stats.mtimeMs, events: read.events });
    return read.events;
  }

  /** This session's live pane as captured now, or `undefined` when it has none or it is gone. */
  async paneState(id: SessionId): Promise<PaneState | undefined> {
    // The lifecycle half of the document names the pane; the protocol schema does not carry it.
    const raw = await this.storage.readConfig(id).catch(() => undefined);
    const tmuxSession =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as { tmuxSession?: unknown }).tmuxSession
        : undefined;
    if (typeof tmuxSession !== 'string' || tmuxSession === '') return undefined;
    const activity = await this.panes.activity(tmuxSession).catch(() => undefined);
    if (activity === undefined || activity.dead) {
      this.frames.delete(tmuxSession);
      return undefined;
    }
    const held = this.frames.get(tmuxSession);
    if (held !== undefined && capturedFrameIsCurrent(held, activity)) return paneStateFrom(activity, held.visible);
    const capturedAtSecond = Math.floor(Date.parse(this.clock.now()) / 1_000);
    const visible = await this.panes.visible(tmuxSession).catch(() => undefined);
    // A capture that failed reads as a blank live screen, as it always did — but is never held, so the
    // next tick captures again instead of trusting a frame it never had.
    if (visible === undefined) this.frames.delete(tmuxSession);
    else this.frames.set(tmuxSession, { activity, visible, capturedAtSecond });
    return paneStateFrom(activity, visible ?? '');
  }

  async pane(id: SessionId): Promise<TurnPaneEvidence | undefined> {
    const pane = await this.paneState(id);
    if (pane === undefined) return undefined;
    const request = parsePermissionPrompt(pane.visible);
    return {
      working: paneShowsActiveWork(pane.visible),
      atPrompt: pane.promptReady,
      permission: request !== undefined || paneShowsPermissionPrompt(pane.visible),
      prompt: paneBlockingPrompt(pane.visible),
      request,
      dialog: parseHarnessDialog(pane.visible),
    };
  }

  async record(id: SessionId, change: TurnStateChange, at: string): Promise<boolean> {
    let written = false;
    await this.storage.updateState(id, raw => {
      const current = SessionStateSchema.safeParse(raw);
      if (!current.success || current.data.turnState !== change.from) return raw;
      // Re-read under the lock: a stop that committed after the watcher looked has the last word.
      if (change.to !== undefined && !isTurnStatus(current.data.status)) return raw;
      const next: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
      if (change.to === undefined) {
        delete next.turnState;
        delete next.turnStateAt;
      } else if (change.to !== change.from) {
        // Only a CHANGED turn moves the boundary: a new dialog on the same `needs-input` is not one.
        next.turnState = change.to;
        next.turnStateAt = at;
      }
      if (change.prompt === undefined) delete next.turnPrompt;
      else next.turnPrompt = change.prompt;
      if (change.request === undefined) delete next.permissionRequest;
      else next.permissionRequest = change.request;
      if (change.dialog === undefined) delete next.harnessDialog;
      else next.harnessDialog = change.dialog;
      written = true;
      return next as typeof raw;
    });
    if (!written) return false;
    // Journaled, so the event stream wakes every open page at once rather than on its next poll.
    // A new dialog on the same 'needs-input' is its own event: 'turn.state' is a turn boundary, and
    // what reacts to one (the Warden, a notification) must not fire twice for the same boundary.
    await this.storage.append(id, change.to === change.from ? 'turn.prompt' : 'turn.state', {
      from: change.from ?? null,
      to: change.to ?? null,
      prompt: change.prompt ?? null,
      // The request itself rides the feed, so a page shows the approval card from the event alone.
      permissionRequest: change.request ?? null,
      harnessDialog: change.dialog ?? null,
    });
    if (change.to === undefined) this.tails.delete(id);
    return true;
  }
}
