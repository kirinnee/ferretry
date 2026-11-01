import type {
  AccountList,
  AgendaId,
  CopyMeta,
  CopyName,
  CopyOrigin,
  InputActor,
  InputAuditDetail,
  InputAuditEvent,
  InputEvent,
  InputFieldElement,
  InputQuarantineEvent,
  InputShot,
  InputTarget,
  InputTargetFacts,
  LoginEntryId,
  LoginFieldRole,
} from '@ferretry/protocol';

/**
 * THE SEAMS THE INPUT-REQUEST SERVICE STANDS ON (docs/input-requests.md).
 *
 * Nothing here has a place to put a value except the `text` {@link InputTargetPort.type} is handed, which is
 * the one write; every other port is told ids, names, states and flags.
 */

/**
 * Whether a process runs a code program (`CODE_PROGRAMS`) from an executable this account cannot replace: decided from
 * the real file, never from the name `ps` shows (adapters/system/executable-code-programs.ts).
 */
export interface CodeProgramPort {
  codeProgram(pid: number): Promise<boolean>;
}

/** The program one process runs, as the kernel PROVES it (adapters/system/kernel-program-proof.ts). */
export interface ProvenProgram {
  /**
   * Its name: the entry in a root-controlled bin folder its executable is reached from, or, for a process running
   * setuid root, a getpass name it runs under. That second name is NOT proof of which setuid program it is: whoever
   * starts it picks it (a link's name on Linux, argv[0] on macOS). Only that root placed the program is proved.
   */
  readonly name: string;
  /** It runs setuid root right now: effective uid 0 while its real uid is not. A ferret cannot make one. */
  readonly setuidRoot: boolean;
}

/**
 * WHO CAN READ A TERMINAL. Every process of the TTY's foreground process group can read what is typed, and so can a
 * process of ANOTHER session that opened the TTY by its path (the pty belongs to this account). The name `ps` shows
 * is no proof of either: any process can rewrite its own (`printf sudo > /proc/$$/comm`).
 */
export interface ProgramProofPort {
  /** What the kernel proves about the program `pid` runs; `undefined` when anything is unproven or unreadable. */
  prove(pid: number): Promise<ProvenProgram | undefined>;
  /**
   * Whether a process whose controlling terminal is NOT `ttyPath` holds it open, so it could read from it outside job
   * control. `false` only when that was looked for and none was found; `undefined` when it cannot be told.
   */
  heldElsewhere(ttyPath: string): Promise<boolean | undefined>;
  /**
   * The program `pid` runs, proved ONLY through the owner's own Nix profile: `~/.nix-profile/bin/<name>` walks, through
   * the profile's own links and the store, to the very store file it runs. Any process running as the owner can swap
   * that program, so this proof earns nothing but what the owner allowed (secure-copy `allowProfileTargets`).
   */
  proveProfile?(pid: number): Promise<ProfileProgram | undefined>;
}

/** A program proved through the owner's own profile: its name and the store file it runs. */
export interface ProfileProgram {
  readonly name: string;
  readonly path: string;
}

export type ObserveResult =
  | {
      readonly ok: true;
      readonly facts: InputTargetFacts;
      /** Every name the surface is known by (its key and its id), so a quarantine holds whichever a reader uses. */
      readonly names?: readonly string[];
      /**
       * The terminal's foreground runs a code program (`CODE_PROGRAMS`) from an executable this account cannot
       * replace: the only way an echo-off prompt may stay a one-time code. The daemon's own, never on the wire.
       */
      readonly codeProgram?: true;
      /**
       * A program every process of the foreground group runs, proved ONLY through the owner's own Nix profile, and
       * one no root-controlled folder holds and no password or code program. The daemon's own, never on the wire:
       * only a secure-copy rule the owner allowed for it reads it (`allowProfileTargets`).
       */
      readonly profileProgram?: ProfileProgram;
    }
  | { readonly ok: false; readonly reason: 'target_gone' | 'unsupported' };

/**
 * What came of the one write. `target_gone` and `target_changed` mean NOTHING was written. `uncertain` means the
 * write was attempted and did not complete cleanly: the value may be in the terminal, so the request ends and
 * is never retried.
 */
export type TypeResult = 'typed' | 'target_gone' | 'target_changed' | 'uncertain';

/** A field as the target needs it to find where a value goes: its id and, on a page, the element the agent named. */
export interface InputTargetField {
  readonly id: string;
  readonly element?: InputFieldElement;
}

/** One value to type, by the field it goes into. The only place a value crosses a port. */
export interface InputFieldValue {
  readonly field: string;
  readonly text: string;
}

/**
 * Looks at, and types into, the surface a request names. The daemon observes; the agent never states a fact.
 * A reusable seam: anything that must put a value the owner supplied into a terminal or a page field goes
 * through it, so the binding check below runs for every such write.
 */
export interface InputTargetPort {
  /**
   * What is at the target right now, for these fields. A terminal answers pane proof, foreground program, echo
   * and the cursor row; a page answers its origin and, per field, the element the browser resolved.
   */
  observe(sessionId: string, target: InputTarget, fields: readonly InputTargetField[]): Promise<ObserveResult>;
  /**
   * The target the card showed (`expected`), found AGAIN after it changed under the card: a page whose field was
   * re-rendered as a new node, a terminal that redrew its prompt. A page looks for the same field (the agent's
   * pointer, else the one visible look-alike); a terminal is simply looked at again. It never types, and whether
   * what it found may take the card's place is the service's decision (`input-requests/rebind.ts`). Absent: a
   * changed target is only ever a failed check.
   */
  refind?(
    sessionId: string,
    target: InputTarget,
    fields: readonly InputTargetField[],
    expected: InputTargetFacts,
  ): Promise<ObserveResult>;
  /**
   * The values, each into its own field in order, with Enter after the last when `submit`. `expected` is what
   * the card showed: an adapter that finds anything about the target different (the pane, the foreground
   * program, echo, the prompt, the page's document, a field's element) writes nothing and answers
   * `target_changed`, or `target_gone` when it cannot find it.
   */
  type(
    sessionId: string,
    target: InputTarget,
    values: readonly InputFieldValue[],
    submit: boolean,
    expected: InputTargetFacts,
    /** The card kept a code visible only because a code program was proved: the write proves it again, or refuses. */
    options?: TypeOptions,
  ): Promise<TypeResult>;
  /** A picture of where the values go, for the owner's card, taken before anything is typed; nothing when none can be had. */
  shoot?(sessionId: string, target: InputTarget, facts: InputTargetFacts): Promise<InputShot | undefined>;
  /** The document a session's page shows now (a page target only), or nothing when it cannot be told. */
  document?(sessionId: string, key: string): Promise<string | undefined>;
  /**
   * The dummy probe (a page target only; lock.ts): types a throwaway value into the named password fields, looks for
   * it in every read of the page and empties them again. `aborted` for anything but a clean run. Never a terminal.
   */
  probe?(
    sessionId: string,
    target: InputTarget,
    facts: InputTargetFacts,
    fieldIds: readonly string[],
  ): Promise<'hidden' | 'shown' | 'aborted'>;
}

/**
 * A terminal's own adapter: one prompt, so one value, in ONE write of `text` with Enter appended when
 * `submit`, in a single command. The router ({@link InputTargetRouter}) adapts it to {@link InputTargetPort}.
 */
export interface TerminalInputTargetPort {
  observe(sessionId: string, target: InputTarget): Promise<ObserveResult>;
  type(
    sessionId: string,
    target: InputTarget,
    text: string,
    submit: boolean,
    expected: InputTargetFacts,
    options?: TypeOptions,
  ): Promise<TypeResult>;
}

/** What a write must prove again, beyond the facts the card was drawn from. */
export interface TypeOptions {
  /** A code program (`ObserveResult.codeProgram`) must still hold the terminal, or nothing is typed. */
  readonly codeProgram?: boolean;
  /**
   * A rule pasted into this profile program (`ObserveResult.profileProgram`): the same name AND the same store file
   * must still hold the terminal, so the file the log names is the one typed into.
   */
  readonly profileProgram?: ProfileProgram;
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

/** A typed value kept in a saved login from a card: the KEPT record `fy secret set` writes, by name only. */
export interface InputSaveAuditEntry {
  readonly sessionId: string;
  readonly requestId: string;
  readonly actor: InputActor;
  readonly entry: LoginEntryId;
  readonly field: Exclude<LoginFieldRole, 'totp'>;
}

export interface InputAudit {
  record(entry: InputAuditEntry): Promise<void>;
  /** The owner saved a typed value to a saved login: kept, like every change to the secret store. */
  saved(entry: InputSaveAuditEntry): Promise<void>;
  /** A secure copy was pasted into the secret store under `name`: kept, like `fy secret set`. */
  stored(entry: InputStoreAuditEntry): Promise<void>;
}

export interface InputStoreAuditEntry {
  readonly sessionId: string;
  readonly requestId: string;
  readonly actor: InputActor;
  readonly name: string;
  /** The name held a value before: the paste replaced it. */
  readonly replaced: boolean;
  /** The write was cut off: the store may or may not hold the copy now. */
  readonly uncertain?: true;
}

/**
 * SAVED LOGINS, as the input service needs them. `fill` is the USE BOUNDARY: the value it answers is typed
 * into the request's target and goes nowhere else — not into a request, an event, an audit entry, a result
 * or an error. Every other method answers names, labels and flags.
 */
export interface InputLoginPort {
  /**
   * Every account and every sign-in, as the owner's listing shows them (names, places, methods, which fields exist and
   * the facts the daemon saw; never a value). Rejects when the store cannot tell.
   */
  listing(): Promise<Pick<AccountList, 'accounts' | 'signIns'>>;
  /** The value an entry's field types: the username, the password, or the 2FA code for `nowMs`. Rejects for a missing one. */
  fill(id: LoginEntryId, role: LoginFieldRole, nowMs: number): Promise<string>;
  /**
   * Keeps typed values in an entry in ONE change: a new entry labelled `label` matching `match`, or the
   * existing one (its label kept, `match` added). The username and password of one card go together. The
   * whole read-merge-write runs under the store-wide lock, so concurrent saves and edits never lose one.
   */
  save(
    id: LoginEntryId,
    label: string,
    match: string | undefined,
    fields: { readonly username?: string; readonly password?: string },
  ): Promise<void>;
}

export interface InputClock {
  now(): number;
}

export interface InputIds {
  requestId(): string;
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

/**
 * Secure copies (docs/secure-copy.md), as a paste needs them. `open` is the second place a value leaves this
 * port set, beside {@link InputTargetPort.type}'s `text`: it is called once per write, after every check that
 * can refuse without typing, and its answer goes only to `type`.
 */
export interface InputSealedPort {
  /** What the daemon recorded about a live copy of this session, or nothing: never the value. */
  describe(sessionId: string, name: CopyName): CopyMeta | undefined;
  /** The live copy's value for the one write; nothing once it was discarded or expired. */
  open(sessionId: string, name: CopyName): string | undefined;
  /** A paste of it was typed. */
  used(sessionId: string, name: CopyName): void;
}

/**
 * The owner's pre-approval rules, as a paste asks them: the rule that allows this paste is RESERVED (its count
 * taken) synchronously, so two pastes can never both spend a rule's last use. Matched on what the daemon saw.
 */
export interface InputPasteRules {
  /** `profile`: the name of a program proved only through the owner's profile (`ObserveResult.profileProgram`). */
  reserve(sessionId: string, from: CopyOrigin, facts: InputTargetFacts, profile?: string): string | undefined;
  /** The paste a rule was reserved for was not typed: its use is given back. */
  release(ruleId: string): void;
  /** It was typed. */
  spent(ruleId: string): void;
}
