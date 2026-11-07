import type { HarnessKind } from '../session/peers/fleet.ts';
import type { CoreAccount } from '../session/peers/core.ts';
import type { Harness } from '../protocol/session-base.ts';
import type { TranscriptProvenance } from '../protocol/session.ts';
import type { SessionId } from '../session-id.ts';

/**
 * The pieces of OTHER plugins a move leans on, as the smallest structural ports Ferrets (core) can name (§2.1: core
 * imports no plugin). Each is today's code of a plugin that is not in this tree — the transcript reader and
 * converter (Conversation and the harness plugins), the account inventory (Runtimes), the pane identity and tmux
 * argument builders (Terminals) — described by exactly the calls a move makes, with the bodies of the move unchanged.
 * The host binds each to its owner; an unbound one is a fail-closed skeleton that refuses the move before anything
 * is written (the module lists them in `SessionMoveNeeds`).
 */

// ─── the transcript the session is bound to ─────────────────────────────────────────────────────────────────────────

/**
 * The session's own transcript, which the preflight joins its open tool ids against (today's `SessionTranscriptReader`).
 *
 * Until a session recorded its transcript this was an EMPTY array and every open tool was classified `unknown`, which
 * the gate refuses on; with provenance persisted the join has real evidence, and a session with no locatable
 * transcript degrades to exactly the previous behaviour rather than to a guess.
 */
export interface MoveTranscriptTail {
  tail(request: { readonly sessionId: SessionId; readonly harness: Harness }): Promise<readonly unknown[]>;
}

/** What a start (or a fresh-conversation move) captures of the target's transcript: the home, and the evidence. */
export interface MoveTranscriptCapture {
  readonly provenance?: TranscriptProvenance;
  readonly launchArguments: readonly string[];
}

/** The target account's own transcript evidence, taken before the relaunch argv is authorized (today's `TranscriptProvenanceCapture`). */
export interface MoveTranscriptProvenance {
  /** The harness home a runtime's wrapper exports, or nothing when it declares none it can resolve. */
  home(harness: Harness, executable: string): Promise<string | undefined>;
  capture(request: {
    readonly harness: Harness;
    /** The absolute wrapper the session will be launched through. */
    readonly executable: string;
    readonly cwd: string;
    readonly correlationToken: string;
    readonly at: string;
  }): Promise<MoveTranscriptCapture>;
}

/** One Codex rollout under a home, and whether it carries the correlation token asked about. */
export interface CodexRolloutCandidate {
  readonly id: string;
  readonly file: string;
  readonly correlated: boolean;
}

/** The Codex rollout index the conversation files correlate a rollout by (today's `CodexRolloutIndex`, the one call a move makes). */
export interface MoveCodexRollouts {
  candidates(home: string, correlationToken: string): Promise<readonly CodexRolloutCandidate[]>;
}

// ─── the converter and the harness's path quirks ─────────────────────────────────────────────────────────────────────

/** Whether a Codex rollout's shape is the one the converter was validated on (today's `RolloutFormatVerdict`). */
export type RolloutFormatVerdict =
  | { readonly kind: 'same' }
  | { readonly kind: 'different'; readonly reason: string }
  /** Nobody could look: the probe run failed, so the shape is neither confirmed nor ruled out. */
  | { readonly kind: 'unchecked'; readonly reason: string };

/** What a conversion dropped rather than carried. */
export interface ConversionDroppedCounts {
  readonly reasoning: number;
  readonly sidechains: number;
  readonly internal: number;
  readonly compactions: number;
}

/** What crossed, what became text and what did not cross — the preview a person confirms (today's converter summary). */
export interface ConvertedConversationSummary {
  readonly converter: number;
  readonly source: { readonly harness: Harness; readonly version?: string; readonly conversationId?: string };
  readonly target: { readonly harness: Harness; readonly version: string; readonly conversationId: string };
  readonly turns: number;
  readonly keptTurns: number;
  readonly omittedTurns: number;
  readonly cutNewest: boolean;
  readonly messages: number;
  readonly nativeToolCalls: number;
  readonly toolCallsAsText: number;
  readonly attachments: number;
  readonly dropped: ConversionDroppedCounts;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  readonly formatNote?: string;
}

/** A file the conversion needs written before the target conversation is resumed (base64 bytes). */
export interface ConvertedFile {
  readonly name: string;
  readonly data: string;
}

export type ConversionResult =
  | {
      readonly kind: 'converted';
      /** The target transcript's whole text. */
      readonly transcript: string;
      readonly files: readonly ConvertedFile[];
      readonly summary: ConvertedConversationSummary;
      /** Texts the target CLI must send to its model, in order, when it resumes: the validation run's proof. */
      readonly sentinels: readonly string[];
      /** The native tool names the history uses, which the target CLI must declare. */
      readonly nativeTools: readonly string[];
    }
  | { readonly kind: 'refused'; readonly reason: string };

/** Hand-off documents already read, by the path the pointer named. A missing path was not readable. */
export type HandoffDocuments = ReadonlyMap<string, string>;

/** What the converter is asked (today's `ConversionRequest`). */
export interface ConversionRequest {
  readonly source: { readonly harness: Harness; readonly text: string; readonly documents: HandoffDocuments };
  readonly target: {
    readonly harness: Harness;
    readonly version: string | undefined;
    readonly conversationId: string;
    readonly cwd: string;
    readonly contextWindow: number;
    readonly model?: string;
    readonly workspaceRoots?: readonly string[];
    readonly modelProvider?: string;
    readonly nativeShell?: boolean;
    readonly format?: RolloutFormatVerdict;
  };
  /** Where an embedded attachment is saved for the target agent to open, absolute. */
  readonly attachmentDirectory: string;
  readonly at: string;
}

/**
 * The harness plugins' pure pieces of a conversation: where each harness writes a transcript, the converter itself, the version gate and the hand-off pointer rules. Today's `claude-path.ts`,
 * `codex-rollout.ts`, `transcript/convert/*` and `imports/conversation-text.ts`, none of which belong to Ferrets.
 */
export interface TranscriptToolkit {
  /** The exact file Claude writes for a session launched with this id in this directory. */
  claudeTranscriptFile(home: string, cwd: string, harnessSessionId: string): string;
  /** Claude's own project-directory encoding of a working directory. */
  claudeProjectDirectory(cwd: string): string;
  /** `<year>/<month>/<day>/rollout-…jsonl`, relative to a Codex home. */
  codexRolloutRelativePath(threadId: string, at: string): string;
  /** Why `version` of `harness` cannot take part in a conversion by its number alone, or `undefined` when it can. */
  harnessVersionRefusal(harness: Harness, version: string | undefined, role: 'source' | 'target'): string | undefined;
  /** Converts one conversation, without a model in the loop. Pure. */
  convertConversation(request: ConversionRequest): ConversionResult;
  /** The hand-off documents a transcript's pointers name, for the caller to read before converting. */
  handoffPointerPaths(text: string): readonly string[];
  /** Whether `path` may be read as a hand-off document inside these folders. */
  isReadableHandoff(
    path: string,
    scope: { readonly roots: readonly string[]; readonly coordinatorHomes: readonly string[] },
  ): boolean;
  /** The most of one hand-off document that is ever read. */
  readonly handoffReadMaxBytes: number;
}

// ─── the account a move names ────────────────────────────────────────────────────────────────────────────────────────

/** A refusal raised while resolving the account a move names, in the start's own vocabulary (`unknown_agent`, `unavailable`, …). */
export class AccountResolutionError extends Error {
  constructor(
    readonly failure: string,
    message: string,
  ) {
    super(message);
    this.name = 'AccountResolutionError';
  }
}

/**
 * The account this move names, resolved with the start's own rule (today's `resolveStartAccount`): published, runnable
 * here, its launchability the domain's. Throws {@link AccountResolutionError}; the move restates `unknown_agent` and
 * `unavailable` in its own words and lets any other refusal through.
 */
export interface MoveAccountResolver {
  resolve(agent: string): Promise<{ readonly account: CoreAccount; readonly executable: string }>;
}

/** The reasoning effort the harness last persisted in a home (today's `readPersistedReasoningEffort`), or nothing. */
export type PersistedReasoningEffort = (kind: HarnessKind, home: string | undefined) => Promise<string | undefined>;

/** What a context window is read from (today's `SessionContextWindowEvidence`). */
export interface SessionContextWindowEvidence {
  readonly configuredModel?: string;
  readonly modelHint?: string;
  readonly observedModel?: string;
  readonly reportedWindow?: number;
  readonly declaredWindow?: number;
}

/** The window a session runs in, from the evidence its model states (today's `lib/core/context-window.ts`). */
export type ContextWindowForSession = (evidence: SessionContextWindowEvidence) => number;

// ─── the host ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The signal a stopped job is sent. */
export type ProcessStopSignal = 'SIGTERM' | 'SIGKILL';

/**
 * Signalling a process, and which processes are never signalled. The kernel hands a plugin no way to signal a pid it
 * did not start, so this is the host's: one signal to one pid, answering whether it was delivered.
 */
export interface ProcessSignalPort {
  /** Whether the signal was delivered; a process already gone, or one this daemon may not signal, is `false`. */
  signal(pid: number, signal: ProcessStopSignal): boolean;
  /** Never these, whatever a pane's tree claims: init, this daemon, and what started it. */
  protectedPids(): ReadonlySet<number>;
}
