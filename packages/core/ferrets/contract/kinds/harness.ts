import type { FencedPath, FerretId } from '@ferretry/kernel/contract';
import type { ChildEnvironment } from '@ferretry/core-vault/contract';
import type { Instant, JsonValue, Result } from '@ferretry/std';
import type { HarnessKey, LoginKindKey } from '../ids.ts';
import type { HarnessHistorySource } from '../history.ts';
import type { LaunchSpec } from './launch.ts';
import type { AdoptedConversation, PortableConversation } from './portable-conversation.ts';
import type { HarnessRuntimeSwitch, RuntimeSwitchPane } from './runtime-switch.ts';
import type { HarnessScreenReader, HarnessStop, Runner, RunnerHandle, RunningFerret, StartRefusal } from './runner.ts';
import type { HarnessRuntimeDescriptor } from './runtime-descriptor.ts';

// ─── harness (§4.3) ───────────────────────────────────────────────────────────────────────────────────────────────

export type HarnessInstall = { readonly found: true; readonly binary: string; readonly version: string };
export type HarnessMissing = { readonly found: false; readonly reason: string };
export type UpdateResult = { readonly updated: boolean; readonly version?: string; readonly sentence: string };

/** What `prepareHome` wrote, inside the ferret's home only. */
export interface HomePlan {
  readonly files: readonly FencedPath[];
  /** Extra argv the harness's command takes for what it wrote (a system prompt flag). */
  readonly args: readonly string[];
}

export interface Started {
  readonly running: RunningFerret;
  readonly harnessConversation?: string;
}

/** A turn in a ferret's conversation, as a harness names it. */
export interface TurnRef {
  readonly turn: number;
  readonly entry?: string;
}

export interface ForkPlan {
  readonly from: FerretId;
  readonly at?: TurnRef;
  readonly harnessConversation: string;
  /**
   * Removes the conversation this fork wrote, and only that one, when the ferret that was to continue it never started.
   * Absent: the unused conversation stays in the history, where nothing refers to it.
   */
  readonly discard?: () => Promise<void>;
}

/** Where a forked conversation will be worked on: the folder its new ferret starts in (a harness may key transcripts by it). */
export interface ForkTarget {
  readonly folder: string;
}

/** A message to a ferret. Idempotent by `id`: delivering one id twice delivers it once. */
export interface OutboundMessage {
  readonly id: string;
  readonly text: string;
  readonly attachments?: readonly FencedPath[];
}

export type Delivery =
  | { readonly status: 'delivered' | 'queued'; readonly id: string }
  | { readonly status: 'refused'; readonly id: string; readonly reason: string };

/** One transcript entry, already masked when it leaves the reader. */
export interface TranscriptEntry {
  readonly id: string;
  readonly at: Instant;
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly text?: string;
  readonly data?: JsonValue;
  /**
   * The tool calls this record made and the tool results it carries, by their ids (Claude's `tool_use.id` and
   * `tool_result.tool_use_id`): what a reader that must know whether ONE call was made or answered matches, exactly. They
   * are not in `text`, which holds only what a person would read. Absent when the record holds no such block.
   */
  readonly tools?: { readonly calls?: readonly string[]; readonly results?: readonly string[] };
}

/**
 * What a read of a transcript that may have been CUT to its newest part (a long conversation) can promise: the entries it
 * holds, and whether it provably reaches back to the instant the caller needs. A cut read that does not is unproved for
 * any question about what is NOT there (a send is absent): it may only say what it found.
 */
export interface TranscriptCoverage {
  readonly entries: readonly TranscriptEntry[];
  /** `true` when nothing was cut, or the oldest complete record read is not newer than `since`. */
  readonly covered: boolean;
}

export interface TranscriptReader {
  read(ferret: FerretId, after?: string, limit?: number): Promise<readonly TranscriptEntry[]>;
  /**
   * Additive (G162, the send tracker's evidence): {@link read} plus whether the read reaches back to `since`. Absent: the
   * harness reads the whole conversation, so a read is always covered.
   */
  readCovering?(ferret: FerretId, since: Instant): Promise<TranscriptCoverage>;
  follow(ferret: FerretId, signal: AbortSignal): AsyncIterable<TranscriptEntry>;
  find(ferret: FerretId, entry: string): Promise<TranscriptEntry | undefined>;
}

/**
 * A {@link TranscriptReader} bound to one ferret: the harness seam hands it out for the ferret it was opened for, and it
 * takes no ferret argument, so it can read no other ferret's conversation.
 */
export interface BoundTranscriptReader {
  read(after?: string, limit?: number): Promise<readonly TranscriptEntry[]>;
  /** {@link TranscriptReader.readCovering}, for this ferret. Absent: the harness reads the whole conversation. */
  readCovering?(since: Instant): Promise<TranscriptCoverage>;
  follow(signal: AbortSignal): AsyncIterable<TranscriptEntry>;
  find(entry: string): Promise<TranscriptEntry | undefined>;
}

export interface TurnUsage {
  readonly turn: number;
  readonly at: Instant;
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface UsageReader {
  turns(ferret: FerretId, since?: Instant): Promise<readonly TurnUsage[]>;
}

/** A permission prompt or question the harness shows, with its choices. */
export interface HarnessDialog {
  readonly id: string;
  readonly kind: 'permission' | 'question' | 'harness';
  readonly prompt: string;
  readonly choices: readonly string[];
}

export interface DialogReader {
  current(ferret: FerretId): Promise<HarnessDialog | undefined>;
  answer(ferret: FerretId, dialog: string, choice: string): Promise<Delivery>;
}

/** One of the harness's own conversations on this machine (§6.2), for import as a link. */
export interface FoundConversation {
  readonly id: string;
  readonly folder: string;
  readonly title?: string;
  readonly updatedAt: Instant;
}

export interface ConversationFinder {
  list(folder?: FencedPath): Promise<readonly FoundConversation[]>;
}

/**
 * One conversation of the owner's own history (`~/.claude`, `~/.codex`) a harness is asked to make its own copy of:
 * `source` is the transcript's path BELOW that history folder (`projects/<folder>/<id>.jsonl`,
 * `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`), never an absolute path.
 */
export interface ConversationImport {
  readonly id: string;
  readonly source: string;
}

// ─── transcript tail (U5): what the turn watch and the live readout read from a conversation ─────────────────────────

/**
 * One record of a harness's conversation as the turn watch and the live readout read it: WHAT happened and WHEN, never
 * what was said. No record carries message, reasoning or tool text, so nothing here needs masking; the one sentence a
 * record may carry is a usage-limit `notice`, already masked and bounded by the harness.
 */
export type HarnessTailRecord =
  | {
      /** A message. `inputSource` marks one the harness itself wrote into the user channel (never something the owner said). */
      readonly kind: 'message';
      readonly role: 'user' | 'assistant' | 'developer' | 'system';
      readonly at?: Instant;
      readonly inputSource?: 'native-queue' | 'harness';
    }
  | {
      /** Reasoning, a tool call or a tool result: the agent is mid-turn. */
      readonly kind: 'work';
      readonly at?: Instant;
    }
  | { readonly kind: 'turn'; readonly state: 'started' | 'completed' | 'aborted'; readonly at?: Instant }
  | {
      /** One model call's spend. `call` names the call when the harness writes several records for one. */
      readonly kind: 'usage';
      readonly at?: Instant;
      readonly call?: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly cacheCreationInputTokens?: number;
      readonly contextTokens?: number;
    }
  | {
      readonly kind: 'compaction';
      readonly at?: Instant;
      readonly trigger?: 'manual' | 'auto';
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
    }
  | {
      /** A turn's error. `code` is the harness's own; `notice` is its first sentence, masked and short. */
      readonly kind: 'error';
      readonly at?: Instant;
      readonly code?: string;
      readonly notice?: string;
    };

/**
 * The transcript a harness proved to be one ferret's, as a stat: `file` names it (compared, never opened by Ferrets and
 * never leaving the daemon), and the pair `size`/`mtimeMs` moves whenever the harness writes to it.
 */
export interface HarnessTranscriptStamp {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** The newest records of a ferret's transcript, oldest first. `unresolved`: no transcript is proved to be this ferret's yet. */
export type HarnessTranscriptTail =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'read'; readonly records: readonly HarnessTailRecord[] };

/**
 * Rejected by {@link HarnessTranscriptBytes.read} when the file the handle was opened on is no longer the transcript the
 * harness proved to be the ferret's (replaced, rotated or gone). The reader drops its handle and asks again.
 */
export class HarnessTranscriptReplaced extends Error {
  override readonly name = 'HarnessTranscriptReplaced';
  constructor(message = 'the proved transcript was replaced') {
    super(message);
  }
}

/**
 * The id of a transcript parser: the name a harness gives the byte format of its transcript (`claude`, `codex`, or a
 * format a third harness declares). Conversation's reader keeps ONE parser per id; an id it has no parser for is read as
 * unsupported, never as another format.
 */
export type TranscriptFormatId = string;

/**
 * What a harness says about itself as DATA, so no caller has to know which harness it is talking to
 * (`FerretsApi.harnessFacts(key)`). One owner per fact: the harness's own home writer reads these, so a value here
 * cannot drift from what the harness writes.
 */
export interface HarnessFacts {
  /** What a person reads: "Claude Code", "Codex". */
  readonly displayName: string;
  /** The instruction file the harness reads from its home (`CLAUDE.md`, `AGENTS.md`). */
  readonly instructionFile: string;
  /** The folder in the harness's home that holds the skills it loads, relative to that home. */
  readonly skillsDir: string;
  /** How the harness takes MCP servers: the document format and the file in its home that holds them. */
  readonly mcp: { readonly format: 'json' | 'toml'; readonly file: string };
  /** The parser id for its transcript bytes (`HarnessTranscriptBytes.format`). */
  readonly transcriptFormat: TranscriptFormatId;
  /** The key of this harness's half in a model catalog file (`claude`, `codex`): the catalog side's name for it. */
  readonly catalogHalf: string;
}

/**
 * The transcript a harness PROVED to be one ferret's own, as RAW bytes, for the one reader that parses records itself
 * (Conversation's transcript reader, G162). UNMASKED: it is evidence, not an answer. Its consumer, Conversation's
 * reader, masks every answer it cuts from these bytes through the kernel's read-scoped redaction (Conversation's
 * `reads.ts`), exactly as v4's reader masked what it read from the file. Logins is the one other trusted consumer,
 * because it keeps only the normalized rate_limits fields and timestamps (a Codex login's passive usage reading), so no
 * message text ever leaves the bytes. No other plugin calls `transcriptBytes` (a consumer-check test pins it), and it
 * never names the file's path.
 */
export interface HarnessTranscriptBytes {
  /** Which parser speaks these bytes. */
  readonly format: TranscriptFormatId;
  /**
   * Opaque. A digest of the path and of the OPENED object (device, inode and, where the host reports one, its creation
   * time): the same for every handle on one generation of the file, and different for every replacement generation,
   * including a file recreated under a reused inode number. A host that reports no creation time cannot offer the first
   * half: its token is fixed for ONE handle and never repeats for another open, so a consumer that compares tokens across
   * handles there sees a change and starts over, and never mistakes a replacement for the same file.
   */
  readonly file: string;
  /** The file's size and modification time when the handle was opened. */
  readonly size: number;
  readonly mtimeMs: number;
  /**
   * At most `length` bytes from `offset` (`length` at most the kernel's `MAX_ROOT_WINDOW_BYTES`), fewer only where the
   * file ends. Read from the ONE descriptor the handle holds (never a pathname), so the bytes are the proved object's;
   * rejects {@link HarnessTranscriptReplaced} when the name no longer reaches that object (replaced, a link put there, or
   * gone), before or after the read.
   */
  read(offset: number, length: number): Promise<Uint8Array>;
  /**
   * The held object's size and mtime now (`fstat` of the descriptor), or `undefined` once the name is gone or no longer
   * reaches it (replaced).
   */
  stat(): Promise<{ readonly size: number; readonly mtimeMs: number } | undefined>;
  /**
   * Lets the descriptor go. Idempotent. The single consumer calls it when it is done; a handle left open closes itself
   * after a minute unused. A read after it fails (an `Error`, not {@link HarnessTranscriptReplaced}) and a stat answers
   * `undefined`.
   */
  close(): Promise<void>;
}

// ─── launch settings (W2-c): whether a relaunch would run a ferret on other harness settings ──────────────────────────

/**
 * The parts of a harness's own launch settings it compares, by NAME only: the permission mode, the fixed layer it adds
 * to every launch, and (Claude Code) the settings and hooks items it writes into the home. A closed list, so an answer
 * can never carry anything but one of these words.
 */
export const HARNESS_LAUNCH_SECTIONS = ['permission-mode', 'fixed-layer', 'settings', 'hooks'] as const;
export type HarnessLaunchSection = (typeof HARNESS_LAUNCH_SECTIONS)[number];

/**
 * Whether the settings the harness launched a ferret under differ from the ones it would launch it under now (today's
 * `FileLaunchSettingsDigest` comparison, taken by the harness over its OWN files and configuration). Values-free by
 * construction: `drifted` names sections and nothing else; no setting value, hash, path or environment value leaves
 * the harness. `unknown` when nothing was recorded at the launch, or what was recorded cannot be read: a stale-settings
 * claim made without evidence would be a guess.
 */
export type HarnessLaunchSettings =
  | { readonly kind: 'current' }
  | { readonly kind: 'drifted'; readonly sections: readonly HarnessLaunchSection[] }
  | { readonly kind: 'unknown' };

/** The value of `harnesses:<key>` (§4.3). */
export interface Harness {
  /** Registered native reader, also used when adopting a persisted pane after a restart. */
  readonly screenReader?: HarnessScreenReader;
  readonly key: HarnessKey;
  /** What this harness says about itself as data (`FerretsApi.harnessFacts`); see {@link HarnessFacts}. */
  readonly facts: HarnessFacts;
  readonly runtime?: HarnessRuntimeDescriptor;
  /** Binary and version; never reads its sign-in files. */
  discover(): Promise<HarnessInstall | HarnessMissing>;
  update?(): Promise<UpdateResult>;
  /** Which login kinds it can spend. */
  readonly accepts: readonly LoginKindKey[];
  /**
   * The ferret's home, which only the harness can name: it resolves its own `state/<harness>/agent-homes/<ferret>`
   * through its OWN `agent-homes` root (scope `{ ferret, subfolder: ferret }`), never a path Ferrets built. The answer
   * is a canonical absolute ASCII path: already normalized, no `.` or `..` segment, no doubled or trailing `/`, and
   * never `/` itself. Ferrets asks for it before every start and launches with exactly this answer in `LaunchSpec.home`;
   * a harness that throws or answers any other spelling is not started (fail closed). It must also answer a plain
   * probe id (`home-probe`, never minted) with a home that neither equals, holds nor sits inside the ferret's own.
   * Resolving names a path only: the folder is created and narrowed (0700) by `prepareHome`.
   */
  homeFor(ferret: FerretId): Promise<FencedPath>;
  /**
   * Writes instructions, MCP config and skills in its own format, inside the ferret's home only, after creating or
   * narrowing that home privately. Refuses a `spec.home` that is not its own `homeFor` answer. Ferrets calls it
   * before every start and resume, before the runner is asked for anything.
   */
  prepareHome(spec: LaunchSpec): Promise<HomePlan>;
  start(spec: LaunchSpec, runner: Runner, env: ChildEnvironment): Promise<Result<Started, StartRefusal>>;
  resume(
    spec: LaunchSpec,
    runner: Runner,
    env: ChildEnvironment,
    harnessConversation: string,
  ): Promise<Result<Started, StartRefusal>>;
  /**
   * Additive (mig-harness-home): whether the conversation a resume would name is in the ferret's home for this launch,
   * asked before `resume`. `false` ONLY when its absence is proved (the harness looked where it keeps that conversation
   * and nothing is there); `undefined` when it cannot tell. A real harness asked to resume a conversation it does not
   * have fails the launch ("No conversation found…"), so on `false` Ferrets starts a NEW conversation instead and says
   * so; on `true` or `undefined` it resumes as before. Absent: every resume is attempted as asked.
   */
  hasConversation?(spec: LaunchSpec, harnessConversation: string): Promise<boolean | undefined>;
  /**
   * Additive (shared history, copy-on-link): copies ONE conversation of the OWNER'S OWN history into this harness's shared
   * history pool, at the same relative path, so a ferret started on it resumes the copy (`hasConversation` finds it there).
   * The harness reads the owner's history through its own read-only `harness-history` root and writes only its own pool:
   * the original is never written, linked or locked, and a name already in the pool is never overwritten (the answer is
   * still `ok`: it is there). Refused, with one plain sentence, for a source that is not this harness's transcript of that
   * id, a file too large to copy, or a harness whose pool is off. Absent: the harness cannot hold a copy.
   */
  importConversation?(input: ConversationImport): Promise<Result<void, { readonly reason: string }>>;
  /**
   * Additive (codex-resume-id): the conversation this ferret's LAST launch is PROVED to have written, for a harness that
   * names its own conversation after launch (Codex), so Ferrets can record it and a later resume names it. Proved means
   * by the harness's own evidence of this launch (Codex: the correlation marker only this launch typed, in a rollout that
   * was not there before it), never by folder or recency; `undefined` on any doubt, and while none is written yet.
   * `home` is the harness home the launch exported, `file` the conversation's file in it. Absent (Claude Code, which
   * names its conversation on the launch argv): nothing is recorded this way.
   */
  provedConversation?(
    ferret: FerretId,
  ): Promise<{ readonly id: string; readonly file: string; readonly home: string } | undefined>;
  /**
   * Additive (c58-37, Fork): cuts `from`'s conversation at `at` (absent: whole) into a NEW conversation in this harness's own
   * history, keyed for `into.folder`, and answers its id. It reads the source's home and writes only the new conversation:
   * the source is never changed. Absent: the harness cannot be forked, and a fork on it refuses with that sentence.
   */
  fork?(from: FerretId, at: TurnRef | undefined, into: ForkTarget): Promise<ForkPlan>;
  /**
   * Additive (C-45, the move to another machine, SOURCE side): this ferret's own conversation as the raw bytes its harness
   * keeps, and the path they sit at relative to the harness's conversation store ({@link PackedConversation}), or one
   * plain sentence saying why it cannot be packed. Same harness on both ends, so nothing is converted and nothing lost.
   * It reads the ferret's OWN home (through the pool link the ferret resumes by) and writes nothing; it never returns a
   * credential file (`auth.json`) or the harness's `session-env`, `paste-cache` or `shell-snapshots`. Absent: the
   * harness cannot be moved to another machine.
   */
  packConversation?(ferret: FerretId): Promise<Result<PackedConversation, { readonly reason: string }>>;
  /**
   * Additive (C-45, the move to another machine, TARGET side): writes a conversation {@link packConversation} packed on the
   * other machine into THIS ferret's home, under this machine's own spelling of `spec.folder` (the new worktree), with every
   * folder the source recorded rewritten to it and, when `spec.harnessConversation` names another id than the packed one,
   * every self id too. It refuses with one plain sentence, NOTHING written, for a harness version it was not tested on, a
   * pack it cannot read, or a conversation that does not prove (`hasConversation`) once written. Absent: the harness cannot
   * be moved to.
   */
  unpackConversation?(
    spec: LaunchSpec,
    packed: PackedConversation,
  ): Promise<Result<UnpackedConversation, { readonly reason: string }>>;
  /**
   * Additive (c58-37, the cross-harness move, SOURCE side): this ferret's conversation in the harness-neutral form
   * ({@link PortableConversation}), at most `budgetTokens` of it (the oldest turns are left out and counted), or one
   * plain sentence saying why it cannot be read. It reads the ferret's OWN home only and writes nothing. Absent: the
   * harness cannot be moved FROM, and a move that would convert it refuses with that sentence.
   */
  exportConversation?(
    ferret: FerretId,
    conversation: string,
    budgetTokens: number,
  ): Promise<Result<PortableConversation, { readonly reason: string }>>;
  /**
   * Additive (c58-37, the cross-harness move, TARGET side): writes `from` into THIS ferret's home in this harness's own
   * format, and proves this harness's own CLI resumes it (today's conversion check, run in a throwaway home) before it
   * answers `ok`. `dryRun` writes nothing and answers the summary the preview shows (`conversation` absent). Refuses with
   * one plain sentence, nothing written, for a version it was not tested on or a conversation that does not resume.
   * Absent: the harness cannot be moved TO.
   */
  adoptConversation?(
    spec: LaunchSpec,
    from: PortableConversation,
    options: { readonly dryRun: boolean },
  ): Promise<Result<AdoptedConversation, { readonly reason: string }>>;
  stop(ferret: FerretId, handle: RunnerHandle, runner: Runner, how: 'polite' | 'now'): Promise<void>;
  deliver(ferret: FerretId, handle: RunnerHandle, message: OutboundMessage): Promise<Delivery>;
  /**
   * Additive (codex-protocol-send): hand ONE message to the harness's own protocol, typing nothing — for a harness whose
   * running TUI takes a message from outside it, so a send never depends on reading the pane. `handed`: the harness
   * accepted the full text for this ferret's conversation (it lands as the next user turn, in order, whether the ferret
   * is idle or busy), and Ferrets types nothing. `unavailable`: it was not handed (no conversation proved yet, the
   * harness could not be run, it refused, it timed out, or the text is too large) and NOTHING was sent, so Ferrets falls
   * back to typing the message as it always did. `uncertain`: the hand-over was cut off (a timeout, a signal) after it may
   * already have been accepted, so the message may still land and must NEVER be typed or handed again: Ferrets answers
   * it as an unconfirmed delivery. Total: never throws, and never carries the message back in any answer or log. Absent
   * (Claude Code): every message is typed.
   */
  inject?(ferret: FerretId, text: string): Promise<'handed' | 'unavailable' | 'uncertain'>;
  /**
   * Additive (U3, today's `RuntimeSupervisedLauncher` explanation): the sentence a person can act on for a start whose
   * first turn could not be typed or whose pane died while starting, read off what the pane last showed
   * ({@link Runner.lastScreen}), or `undefined` when the screen says nothing this harness recognises. The answer is a
   * FIXED sentence of the harness's own: it never quotes the screen. Absent: no harness explanation.
   */
  startFailure?(screen: string): string | undefined;
  /**
   * Additive (harness-refusals): how this harness's turn is stopped — the key (today's `Escape` in both TUIs) and
   * whether it is harmless at an idle prompt (today's `STOP_KEY_SAFE_WHEN_IDLE`, Claude Code only). Absent: the harness
   * names no safe stop, and an interrupt is refused rather than guessed.
   */
  readonly turnStop?: HarnessStop;
  /**
   * Additive (U5): one stat of the transcript this harness proved to be the ferret's own (the same file `transcript` and
   * `usage` read), or `undefined` while none is proved or the file cannot be read. Cheap by contract: the live readout
   * and the transcript-change signal ask it every half second to learn whether the file was written. Absent: the
   * harness offers no transcript tail, and the ferret's turn is decided from its pane alone.
   */
  transcriptStamp?(ferret: FerretId): Promise<HarnessTranscriptStamp | undefined>;
  /**
   * Additive (U5): the newest `limit` records of that transcript as {@link HarnessTailRecord}s: kinds, roles and
   * instants, never message text. Ferrets asks only when the stamp moved. Absent: see {@link transcriptStamp}.
   */
  transcriptTail?(ferret: FerretId, limit: number): Promise<HarnessTranscriptTail>;
  /**
   * Additive (G162, Conversation's transcript reader): the transcript this harness proved to be the ferret's own, as a
   * windowed, UNMASKED byte handle ({@link HarnessTranscriptBytes}) that carries an opaque token and never a path.
   * `undefined` while no transcript is proved. Absent: this harness offers entries only ({@link transcript}).
   */
  transcriptBytes?(ferret: FerretId): Promise<HarnessTranscriptBytes | undefined>;
  /**
   * Additive (W2-c, RULING #27 Q9): whether a relaunch of this ferret would run on other settings of this harness's own
   * than its last start or resume did. The harness records what it launched under (in its own state, never in the
   * ferret's home) and compares it with its configuration now; Ferrets never reads a harness's files. Total: a damaged
   * or missing record is `unknown`, never a throw. Absent: Ferrets claims nothing about this harness's settings.
   */
  launchSettings?(ferret: FerretId): Promise<HarnessLaunchSettings>;
  /**
   * Additive (the conversation index): the past conversations this harness holds, as read-only trees Conversation walks
   * and reads for its listing (`HarnessHistorySource`): the owner's own home, each ferret home and, later, the shared pool.
   * Total: a tree that cannot be reached is left out, never an error. Absent: this harness lists no history.
   */
  historySources?(): Promise<readonly HarnessHistorySource[]>;
  /**
   * Additive (runtime control): this harness's part of changing the model, reasoning level or fast mode of a RUNNING ferret
   * (`POST /v1/ferrets/:id/runtime`), built for ONE ferret's pane. Ferrets' runtime-control service asks it for the plan, the
   * catalog and the picker recovery and never names the harness; absent: the harness cannot be switched live, and the answer
   * is `422 runtime_control_unsupported`.
   */
  runtimeSwitch?(pane: RuntimeSwitchPane): HarnessRuntimeSwitch;
  readonly transcript: TranscriptReader;
  readonly usage: UsageReader;
  readonly dialogs?: DialogReader;
  readonly conversations: ConversationFinder;
}

/** One conversation as its harness keeps it, packed to travel to another machine ({@link Harness.packConversation}). */
export interface PackedConversation {
  /** The conversation file, byte for byte. */
  readonly bytes: Uint8Array;
  /** Where it sits relative to the harness's conversation store: a plain relative path, no `..`, no leading `/`. */
  readonly relPath: string;
}

/** What {@link Harness.unpackConversation} made: the id this harness resumes the unpacked conversation by. */
export interface UnpackedConversation {
  readonly conversation: string;
}
