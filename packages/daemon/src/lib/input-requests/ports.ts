import type {
  AgendaId,
  InputActor,
  InputAuditDetail,
  InputAuditEvent,
  InputEvent,
  InputQuarantineEvent,
  InputTarget,
  InputTargetFacts,
} from '@ferretry/protocol';

/**
 * THE SEAMS THE INPUT-REQUEST SERVICE STANDS ON (docs/input-requests.md).
 *
 * Nothing here has a place to put a value except {@link InputTargetPort.type}'s `text`, which is the
 * one write; every other port is told ids, names, states and flags.
 */

export type ObserveResult =
  | {
      readonly ok: true;
      readonly facts: InputTargetFacts;
      /** Every name the surface is known by (its key and its id), so a quarantine holds whichever a reader uses. */
      readonly names?: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'target_gone' | 'unsupported' };

/**
 * What came of the one write. `target_gone` and `target_changed` mean NOTHING was written. `uncertain` means the
 * write was attempted and did not complete cleanly: the value may be in the terminal, so the request ends and
 * is never retried.
 */
export type TypeResult = 'typed' | 'target_gone' | 'target_changed' | 'uncertain';

/** Looks at, and types into, the surface a request names. The daemon observes; the agent never states a fact. */
export interface InputTargetPort {
  /** What is at the target right now. A terminal answers pane proof, foreground program, echo and the cursor row. */
  observe(sessionId: string, target: InputTarget): Promise<ObserveResult>;
  /**
   * ONE write of `text` with Enter appended when `submit`, in a single command. `expected` is what the card
   * showed: an adapter that finds anything about the target different (the pane, the foreground program, echo,
   * the prompt) writes nothing and answers `target_changed`, or `target_gone` when it cannot find it.
   */
  type(
    sessionId: string,
    target: InputTarget,
    text: string,
    submit: boolean,
    expected: InputTargetFacts,
  ): Promise<TypeResult>;
}

/** The card the owner answers. The daemon words the title and ask; the agent's prompt rides as `prompt` only. */
export interface InputCard {
  readonly requestId: string;
  readonly title: string;
  readonly ask: string;
  readonly prompt: string;
  readonly blocking: boolean;
  readonly expiresAt: string;
  readonly chain?: AgendaId;
}

export type InputCardResult =
  | { readonly ok: true; readonly id: AgendaId }
  | { readonly ok: false; readonly message: string };

/** The agenda, as the input service needs it: raise a `kind: 'input'` card, close it when the request ends. */
export interface InputAgendaPort {
  raise(sessionId: string, card: InputCard): Promise<InputCardResult>;
  /** Resolve the card as the daemon's own act; never throws for a card that is already gone. */
  close(sessionId: string, id: AgendaId, note: string): Promise<void>;
  /** The agent's prompt stored on the open card, so a restart can rebuild its request; nothing when there is no such card. */
  promptOf(sessionId: string, id: AgendaId): Promise<string | undefined>;
}

/** Tells the raising agent its request ended, in plain words with no value. Total: never rejects. */
export interface InputAgentNotifier {
  tell(sessionId: string, agendaId: AgendaId, message: string): Promise<void>;
}

/** The session journal: ids and states only (`InputEvent`). `history` is replayed on start. */
export interface InputJournal {
  publish(sessionId: string, event: InputEvent): Promise<void>;
  history(sessionId: string): Promise<readonly InputEvent[]>;
  /** A quarantine starting or ending: names and an end time, so a restart keeps it. */
  quarantine(sessionId: string, event: InputQuarantineEvent): Promise<void>;
  quarantines(sessionId: string): Promise<readonly InputQuarantineEvent[]>;
}

export interface InputAuditEntry {
  readonly event: InputAuditEvent;
  readonly sessionId: string;
  readonly actor: InputActor | { readonly kind: 'agent' } | { readonly kind: 'daemon' };
  /** Absent for an act that belongs to no request (the owner ending a quarantine). */
  readonly requestId?: string;
  readonly detail: InputAuditDetail;
}

export interface InputAudit {
  record(entry: InputAuditEntry): Promise<void>;
}

export interface InputClock {
  now(): number;
}

export interface InputIds {
  requestId(): string;
}

/**
 * Whether the owner already trusts a program that is not a recognised consumer (D3). A program is named by the
 * KEYED digest of its name, never the name: a program name can be anything a terminal reports, including a
 * value the owner typed, and what this remembers for the life of the daemon must not be readable.
 */
export interface InputTrustedPrograms {
  isTrusted(programDigest: string): boolean;
  trust(programDigest: string): void;
}

/** Sessions that exist now. */
export interface InputSessionDirectory {
  /** The session is gone or has finished (completed, failed or stopped): nothing it was given is held for it any more. */
  ended(sessionId: string): Promise<boolean>;
  /** Every session with a journal, for restore. */
  all(): Promise<readonly string[]>;
}

/** Lets a wait end early or at its limit; the daemon's wall-clock timer, a fake in tests. */
export interface InputTimers {
  after(milliseconds: number): Promise<void>;
}

/** Who is acting on a request: the raising agent, or the owner (host, or a paired device) over a named carrier. */
export type InputCaller =
  | { readonly kind: 'agent'; readonly sessionId: string }
  | {
      readonly kind: 'owner';
      readonly actor: InputActor;
      readonly carrier: 'loopback' | 'direct' | 'relay';
    };
