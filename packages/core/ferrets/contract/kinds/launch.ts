import type { FencedPath, FerretId, InstructionEntry, SharedCredential, SharedTree } from '@ferretry/kernel/contract';
import type { JsonValue, Result } from '@ferretry/std';
import type { FerretRole, HarnessKey, PackId } from '../ids.ts';
import type { InitialAttachment, StartOptions } from '../port.ts';

// ─── launch ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Everything one start of one ferret is: identity, where, which harness and login, and what plugins added. */
export interface LaunchSpec {
  readonly ferret: FerretId;
  readonly name: string;
  readonly role: FerretRole;
  readonly parent?: FerretId;
  readonly pack?: PackId;
  readonly harness: HarnessKey;
  readonly runtime?: string;
  readonly login?: string;
  readonly model?: string;
  readonly effort?: string;
  /**
   * The ferret's mode (the record's own): an `interactive` ferret has an owner at the pane and so keeps the harness's
   * question tool; an `auto` one has nobody to answer, so the tool is withheld. ABSENT is unattended (`auto`), the rule
   * the Runtimes wrappers have always applied (`FY_SESSION_MODE` unset). Set by Ferrets from the record on every launch
   * (a start, a resume, Restart CLI, a move, a revive), so every launch of one ferret decides the tool the same way.
   */
  readonly mode?: 'interactive' | 'auto';
  /**
   * This ferret's OWN compaction choice, in tokens or `auto` (its session config, else its start options). A
   * `launch.parts` taker resolves it against the login's default and the model's window; ABSENT means the login's default.
   */
  readonly compactAt?: 'auto' | number;
  /** The work folder, fenced (`WorkFolders`). */
  readonly folder: FencedPath;
  /** The ferret's home under the harness's own `agent-homes` root: the harness's `homeFor` answer, unchanged. */
  readonly home: FencedPath;
  /** Instructions from the post-build snapshot, filtered by `when`, ordered. */
  readonly instructions: readonly InstructionEntry[];
  /**
   * The absolute folders, all inside THIS ferret's own session folder (`FERRET_READABLE_FOLDERS`), its agent is pointed
   * into to read what it was sent. Set by Ferrets only (never a `launch.parts` taker), so no plugin can widen what an
   * agent reads without asking. A harness that asks before reading outside the work folder lets its agent READ these
   * (and only read) without asking, in its own spelling (Claude: `--allowedTools=Read(//<folder>/**)`); one whose
   * sandbox already reads anywhere (Codex) adds nothing. Absent: nothing is pre-allowed.
   */
  readonly readable?: readonly FencedPath[];
  /** What `launch.parts` takers added for this ferret. */
  readonly parts: readonly LaunchPart[];
  /**
   * The login's sign-in FILE, shared with this harness (`LoginKind.credential`): Codex's `auth.json`, which the harness
   * asks the kernel to link into its own home (`RootHandle.linkCredential`). Set by Ferrets from the login only, never by
   * a `launch.parts` taker, so no plugin can put a credential into another's launch; and a taker is never handed it
   * (`LaunchPartSource.parts` takes the spec without it). It is single-use in the kernel: the one link the harness makes
   * spends it, and each launch mints its own. Absent: nothing to link.
   */
  readonly credential?: SharedCredential;
  /** The first message, when the owner gave one. */
  readonly prompt?: string;
  readonly harnessConversation?: string;
  /**
   * The start's options as they were given (today's start fields: harness flags, fast, remote control, the supervision
   * timers, …), kept in `details.json` so every resume launches with the same ones. `model` and `effort` are also
   * lifted to their own fields above.
   */
  readonly options?: Omit<StartOptions, 'title'>;
}

/** One piece a plugin adds to a launch (`launch.parts`): an MCP server, a skill, a shell, an instruction, env. */
export type LaunchPart =
  | { readonly kind: 'mcp'; readonly name: string; readonly config: JsonValue }
  | {
      readonly kind: 'skill';
      readonly name: string;
      /**
       * Not used to materialize anything: a skill reaches the home only through {@link tree}, and a part with no tree is
       * skipped (no project skill is copied or linked, owner decision !A466).
       */
      readonly path?: FencedPath;
      /**
       * The skill folder, shared by the plugin that holds it (`kernel.roots.share`, Skills) for the harness that
       * materializes it in the ferret home (`RootHandle.copyShared`). Unforgeable and valid for this launch: it
       * serialises as its folder name only, so a part read back from a record carries no usable tree.
       */
      readonly tree?: SharedTree;
    }
  | { readonly kind: 'shell'; readonly name: string; readonly env: Readonly<Record<string, string>> }
  | { readonly kind: 'instruction'; readonly id: string; readonly text: string }
  /** Names and `${secret:NAME}` references only; never a value. */
  | { readonly kind: 'env'; readonly env: Readonly<Record<string, string>> }
  /**
   * Where the harness squeezes its own conversation, in tokens (a login's `compactAt`, once it is a number: `auto` adds
   * nothing). The Claude harness writes it into its private settings file as `autoCompactWindow`.
   */
  | { readonly kind: 'compact'; readonly at: number }
  /**
   * What the login this ferret spends says about itself, as the login's own non-secret account file records it: the
   * organisation type (`claude_max`, `claude_team`, `claude_enterprise`, …), absent when it names none or cannot be read.
   * The Claude harness decides from it whether to give the ferret Ferretry's message channel by default. Never a token.
   */
  | { readonly kind: 'account'; readonly organizationType?: string };

/** What a `launch.parts` taker contributes: a source asked per launch (a contribute item is static; the parts are not). */
export interface LaunchPartSource {
  /**
   * A launch cannot be judged right without this source's answer (a login's compaction trigger is one): when it throws,
   * the launch is refused with nothing started, instead of the source being skipped. A source that is only an
   * addition (lessons, a skill) leaves this off and is skipped when it fails.
   */
  readonly required?: boolean;
  parts(spec: Omit<LaunchSpec, 'parts' | 'credential'>): Promise<readonly LaunchPart[]>;
}

/**
 * A launch refused with the sentence a person reads: thrown by a harness (its home's directory chain is unsafe) or by a
 * required launch-part source. The message must be plain words: never a value read from a file, an environment or a
 * secret. Any other failure on the launch path is refused with a generic sentence instead, because a port's error text
 * can carry launch values.
 */
export class LaunchRefusal extends Error {
  override readonly name: string = 'LaunchRefusal';
}

/** A required {@link LaunchPartSource} refusing the launch (see {@link LaunchRefusal}). */
export class LaunchPartsRefusal extends LaunchRefusal {
  override readonly name = 'LaunchPartsRefusal';
}

/**
 * What a start's opening message does with the files attached to it (`fy start -f`, today's `initialAttachments`).
 * Decoding, bounding, extracting a document's text and wording the section the agent reads belong to the attachment
 * owner (Conversation); Ferrets writes the planned files into the ferret's own `attachments/` folder and appends the
 * section to the task. `directory` is the absolute folder the files will be written into; every planned `file` is in it.
 * A refusal (too many files, too large, an unsafe name, undecodable bytes) is a sentence for the caller, never a throw.
 */
export interface OpeningAttachmentsSource {
  plan(request: {
    readonly attachments: readonly InitialAttachment[];
    readonly directory: string;
  }): Result<OpeningAttachmentsPlan, string>;
}

/** The section to append to the opening message, and every file to write before the agent is told about it. */
export interface OpeningAttachmentsPlan {
  readonly section: string;
  readonly files: readonly { readonly file: string; readonly contents: Uint8Array | string }[];
}
