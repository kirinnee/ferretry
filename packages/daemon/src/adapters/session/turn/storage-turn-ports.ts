import { stat } from 'node:fs/promises';
import { SessionStateSchema } from '@ferretry/protocol';
import {
  type ClockPort,
  isTurnStatus,
  type PaneState,
  paneBlockingPrompt,
  paneShowsActiveWork,
  paneShowsPermissionPrompt,
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

/** A terminal read for one tmux session, as `TmuxController.state` answers it. */
export interface TurnPaneReader {
  state(tmuxSession: string): Promise<PaneState>;
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
 * parse. The pane read is the same capture the send path makes before it types.
 */
export class StorageTurnPorts implements SessionTurnPorts {
  private readonly tails = new Map<SessionId, CachedTail>();

  constructor(
    private readonly storage: DaemonStorage,
    private readonly tail: SessionTranscriptTail,
    /** The transcript file proved to be this session's, or `undefined` before one is. */
    private readonly transcriptFile: (id: SessionId) => Promise<string | undefined>,
    private readonly panes: TurnPaneReader,
    readonly clock: ClockPort,
  ) {}

  async sessions(): Promise<readonly TurnWatchSession[]> {
    const sessions = await Promise.all(
      this.storage.listSessions().map(async ({ id }) => {
        const state = SessionStateSchema.safeParse(await this.storage.readState(id).catch(() => undefined));
        return state.success ? ({ id, state: state.data } satisfies TurnWatchSession) : undefined;
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
    const pane = await this.panes.state(tmuxSession).catch(() => undefined);
    return pane === undefined || !pane.alive || pane.dead ? undefined : pane;
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
    });
    if (change.to === undefined) this.tails.delete(id);
    return true;
  }
}
