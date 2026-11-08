/**
 * THE PORTS HALF B OF ACCOUNTS ASKS OF OTHER SUBSYSTEMS, as today's code declares them (bb89d054d). Each is a local
 * interface because the owning contract does not export it (yet); each carries a TODO(contract) for the lead. The
 * composition (accounts-a owns `daemon/index.ts`) binds them.
 */
import type { AuditActor, AuditDetail, AuditKindName, AuditOutcome } from '@ferretry/core-gate/contract';
import type { CopyElementPart } from '../../contract/routes/index.ts';
import type { BrowserElementTarget } from './vault-inputs.ts';

// ─── audit (today's `lib/audit/types.ts`) ─────────────────────────────────────────────────────────────────────────

// Today's service shape is bound to GateApi.audit at composition; Gate stamps the kept record.

/** One thing that happened, as an emitter describes it. The instant is the log's to stamp. */
export interface AuditEntry {
  readonly event: AuditKindName;
  readonly actor: AuditActor;
  readonly cause?: 'daemon';
  readonly subject?: string;
  readonly outcome: AuditOutcome;
  readonly detail?: AuditDetail;
}

/** Where emitters write. One method, so a site's whole involvement is one line. An audit write never decides. */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

// ─── clock (today's `lib/ports.ts`) ───────────────────────────────────────────────────────────────────────────────

/** The instant now, as ISO text. Bound to the kernel's `Clock`. */
export interface ClockPort {
  now(): string;
}

// ─── passkeys (today's `lib/step-up/passkeys-changed.ts`) ─────────────────────────────────────────────────────────

/**
 * What changed in the passkey registries: a paired device was forgotten (revoked, so its passkeys went with it), or a
 * catalog member's key was, with its passkeys. Ids only — never a key, a credential or a name.
 *
 * TODO(contract): a revoked device arrives as Access's `DevicesChanged` (`change: 'revoked'`, lead decision); a
 * removed passkey and a forgotten member key have no event in any contract yet.
 */
export type PasskeysChange =
  | { readonly cause: 'device-forgotten'; readonly deviceId: string }
  | { readonly cause: 'member-key-forgotten'; readonly keyId: string };

export type PasskeysChangedListener = (change: PasskeysChange) => Promise<void> | void;

// ─── board projects (today's `lib/board-projects/session-projects.ts`) ────────────────────────────────────────────

// TODO(contract): the Board/Projects contracts export no session → project read.
export const UNFILED_PROJECT_ID = 'unfiled';

/** The parts of a session's config the resolver reads. */
interface SessionProjectFacts {
  readonly cwd: string;
  readonly parent?: string;
  readonly projectId?: string;
}

export interface SessionProjectFactSource {
  /** The stored facts, or `null` for a session this daemon does not know. */
  read(sessionId: string): Promise<SessionProjectFacts | null>;
}

// ─── the agent browser (today's `lib/browser/transport/copy-contracts.ts`) ───────────────────────────────────────

// TODO(contract): Browsers' contract has no secure-copy read.

/** What a read found: the value and where it came from, or why there is nothing (the element is gone, or empty). */
export type BrowserCopyRead =
  | {
      readonly ok: true;
      readonly value: string;
      /** `scheme://host[:port]` of the page. */
      readonly origin: string;
      /** `scheme://host[:port]` of the frame the element is in: the page's own, or a frame from another site. */
      readonly frameOrigin: string;
      /** The document the value was read from: it changes with every navigation. */
      readonly navigationId: string;
      /** The element is editable (a contenteditable one, or inside one): its text is whatever was typed there. */
      readonly editable?: true;
    }
  | { readonly ok: false; readonly reason: 'missing' | 'empty' | 'changed' };

export interface BrowserCopyPort {
  copyRead(
    pageId: string,
    target: BrowserElementTarget,
    part: CopyElementPart,
    attribute?: string,
  ): Promise<BrowserCopyRead>;
}

// ─── a child with secrets (today's `lib/secrets/types.ts`) ────────────────────────────────────────────────────────

// TODO(contract): the Vault runs a child through `VaultApi.run`; a secure copy's capture runs a command and keeps its
// stdout sealed, which `run` does not offer.

/** What a use child is asked to do, once every reference has been resolved. */
export interface SecretChildSpec {
  readonly command: readonly string[];
  readonly cwd: string;
  /** The child's environment, INCLUDING the resolved secret values. It exists only here. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** What running one produced. Raw — redaction happens in the domain, above this boundary. */
export interface SecretChildOutcome {
  readonly outcome: 'exited' | 'timeout' | 'spawn_failed';
  readonly program?: string;
  readonly replaceable?: true;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Spawning one child. THE ADAPTER NEVER PUTS THE COMMAND OR ITS ENVIRONMENT IN A LOG OR AN ERROR. */
export interface SecretChildRunner {
  run(spec: SecretChildSpec): Promise<SecretChildOutcome>;
}

// ─── a ferret's transcript (today's `lib/session/transcript/reader.ts`) ──────────────────────────────────────────

// TODO(contract): Ferrets' contract has `TranscriptReader` (entries), not the transcript FILE a secure copy searches raw.
export interface TranscriptFileResolver {
  file(sessionId: string): Promise<string | undefined>;
}
