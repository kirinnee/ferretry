import type { FerretId } from '@ferretry/kernel/contract';
import type { JsonValue } from '@ferretry/std';

/**
 * Who a turn document is from, as Ferretry recorded it BESIDE the document (`turn-NNN.by.json`, today's `QueueAuthor`):
 * the owner, a ferret (by callsign) or a part of Ferretry (by feature). Metadata only; the document never carries it.
 */
export interface FerretTurnAuthor {
  readonly kind: 'owner' | 'ferret' | 'ferretry';
  readonly name?: string;
  readonly feature?: string;
  readonly sections?: string[];
}

/** One of a ferret's turn documents (`turns/turn-NNN.md`) and, when Ferretry wrote one beside it, who it is from. */
export interface FerretTurnDocument {
  readonly turn: number;
  readonly text: string;
  readonly by?: FerretTurnAuthor;
}

/**
 * A ferret's turn documents, read back by the store that writes them (additive, U3; Conversation's `TurnDocuments`).
 * Bound to the one ferret it was opened for, so it can read no other's. A STRICT read rejects anything unreadable (a
 * document that vanished mid-read, an author record that does not parse); a best-effort one skips what it cannot read.
 */
export interface FerretTurns {
  list(options?: { readonly strict?: boolean }): Promise<readonly FerretTurnDocument[]>;
  /**
   * Additive (#45 BG-051, today's `writeTurn`): writes the NEXT numbered turn document `turns/turn-NNN.md` (`0600`,
   * through a temporary name, its author beside it as `turn-NNN.by.json`), numbered after the higher of the session
   * counter and the documents on disk, and counts it so a later revive numbers after it. Answers its number and the
   * absolute path the agent is pointed at. The same store the revive writes.
   */
  write?(request: { readonly document: string; readonly by?: FerretTurnAuthor }): Promise<FerretTurnWritten>;
  /**
   * Additive (#45 BG-053, today's `writeQueuedPayload`): writes a message too long to type into a busy pane to
   * `channel/queued-<send id>.md` (`0600`, through a temporary name; the same id rewrites the same file) and answers
   * its absolute path. Rejects for an id outside `[a-z0-9_-]{1,128}`: the caller does not substitute one, because the
   * send's row names the file.
   */
  writeQueued?(sendId: string, payload: string): Promise<string>;
  /**
   * Additive: reads back the message `writeQueued` filed under this send id (`channel/queued-<send id>.md`, bounded), for the
   * chat's hand-off view. `undefined` when there is none, the id is outside the queued-message grammar or it cannot be read.
   */
  readQueued?(sendId: string): Promise<string | undefined>;
  /**
   * Additive: the absolute path of THIS ferret's own `attachments/` folder, the one root whose files a hand-off may show as
   * stored attachments. Any file named outside it is not this ferret's, whatever the document says.
   */
  attachmentsFolder?(): Promise<string>;
  /** Additive (#45 BG-051, today's `clearMarkers`): clears the completion markers a previous turn left. */
  clearMarkers?(): Promise<void>;
}

/** A turn document Ferrets wrote: its number and the absolute file the agent is pointed at. */
export interface FerretTurnWritten {
  readonly turn: number;
  readonly file: string;
}

/**
 * What a ferret's pane is asking right now (additive, U4; today's `turnPrompt`, `permissionRequest` and
 * `harnessDialog` of its state document, `lib/protocol/session-dialog.ts` and `session-permission.ts`), for the panels
 * that show it. Every text in it was read from a masked screen and is masked again inside one `Redaction.read` on the
 * way out. Nothing here answers a dialog: no option is ever chosen.
 */
export interface FerretPrompt {
  /** The turn the observer last recorded; absent when none is recorded. */
  readonly turnState?: 'working' | 'your-turn' | 'needs-input';
  /**
   * When the observer last CHANGED `turnState` (additive): the observer's own stored instant, ISO, on the daemon's clock.
   * Never the registry's `stateAt`, which is stamped later by a separate write and cannot tell `needs-input` from
   * `your-turn`. Absent whenever `turnState` is.
   */
  readonly turnStateAt?: string;
  /** The harness dialog's words behind a `needs-input`. */
  readonly prompt?: string;
  /** The tool-permission prompt behind a `needs-input`, as data. */
  readonly permissionRequest?: JsonValue;
  /** The harness's own dialog behind a `needs-input`, as data. */
  readonly dialog?: JsonValue;
  /**
   * The usage limit this ferret's login is read as spent on (additive, R1-D): present exactly while the session
   * document says `rate_limited` AND carries the harness's own words for it (its quota's notice, or the usage-limit dialog
   * it is parked on). It is the one place a reader outside Ferrets finds a spend limit only the pane announces, which no
   * provider window shows. The notice is masked like every text here; `retryAt` is when the harness said the login is
   * usable again, epoch milliseconds, absent when it gave none.
   */
  readonly limit?: { readonly notice: string; readonly spend: boolean; readonly retryAt?: number };
}

/** A ferret's turn documents, what its pane is asking and its last screen. */
export interface TurnsApi {
  /**
   * A ferret's turn documents (additive, U3): what a start and every revive handed it, oldest first. `undefined` for a
   * ferret this daemon does not know. With `caller` (a ferret acting), only itself and its helpers are reachable, by the
   * same `mayTouch` rule as `harness`: anyone else is refused with a 403 `forbidden`, so no agent reads another's turns.
   */
  turns?(ferret: FerretId, caller?: FerretId): Promise<FerretTurns | undefined>;
  /**
   * What the ferret's pane is asking right now (additive, U4): the dialog or permission prompt the turn watch recorded,
   * masked, for Claude Code's panels. `undefined` for a ferret this daemon does not know; `{}` when nothing is asked or
   * its state could not be read. Same `mayTouch` rule as `harness`: a `caller` reaching beyond itself and its helpers
   * is refused with a 403 `forbidden`. Read only: it never answers the dialog.
   */
  prompt?(ferret: FerretId, caller?: FerretId): Promise<FerretPrompt | undefined>;
  /**
   * A stopped ferret's last screen (additive): the frame kept when it stopped, MASKED AGAIN with the Vault's values at
   * the moment of THIS read (a value added to the Vault after the capture is masked too), so the text is never the raw
   * file. Same `mayTouch` rule as `harness`: a `caller` reaching beyond itself and its helpers is refused with a 403
   * `forbidden`, before the file is read. `undefined` (never an error, never the raw text) for a ferret this daemon does
   * not know, one that kept no frame, a store that is unreadable or damaged, and a frame that could not be masked.
   * Read only.
   */
  lastSnapshot?(ferret: FerretId, caller?: FerretId): Promise<string | undefined>;
}
