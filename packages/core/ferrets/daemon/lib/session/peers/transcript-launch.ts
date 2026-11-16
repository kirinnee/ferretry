/**
 * PEER: today's `packages/daemon/src/lib/session/transcript/{claude-path,codex-rollout,relaunch,wrapper-home}.ts` and
 * `packages/daemon/src/lib/session/send/handoff.ts` (owner: conversation) — the launch-argv half the session launch
 * code reads.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */
import type { Harness } from '../../protocol/session-base.ts';
import type { HarnessKind } from './fleet.ts';
import type { TranscriptProvenance } from '../../protocol/session.ts';

// --- session/send/handoff.ts ------------------------------------------------------------------------------------

/**
 * The argv that lets a harness read the folders a handover brief points into without asking.
 *
 * Codex needs nothing: its sandbox reads anywhere in every mode Ferretry runs it in, and limits only
 * writes.
 */
export function handoffReadArguments(harness: HarnessKind, folders: readonly string[]): readonly string[] {
  return harness === 'claude' ? folders.map(folder => `--allowedTools=Read(/${folder}/**)`) : [];
}

// --- session/transcript/claude-path.ts --------------------------------------------------------------------------

/** The argv Claude needs so it writes the transcript this daemon just named. */
export function claudeSessionArguments(harnessSessionId: string): readonly string[] {
  return ['--session-id', harnessSessionId];
}

// --- session/transcript/codex-rollout.ts ------------------------------------------------------------------------

/** The root a Codex correlation token is declared under. Nobody creates it, so the proof costs no access. */
const CODEX_CORRELATION_ROOT = 'codex-correlation';

/** The declared root's own name, under {@link CODEX_CORRELATION_ROOT}. */
const CODEX_CORRELATION_LEAF = 'unreachable';

/** The Codex flag that declares an extra workspace root. */
const CODEX_ADD_DIR = '--add-dir';

/** The launch arguments that make a Codex rollout carry `correlationToken` from its first record. */
export function codexCorrelationArguments(correlationToken: string): readonly string[] {
  return [CODEX_ADD_DIR, `${correlationToken}/${CODEX_CORRELATION_ROOT}/${CODEX_CORRELATION_LEAF}`];
}

/** Whether `flag value` is the pair {@link codexCorrelationArguments} produces, for any session. */
export function isCodexCorrelationPair(flag: string, value: string | undefined): boolean {
  return (
    flag === CODEX_ADD_DIR &&
    value !== undefined &&
    value.endsWith(`/${CODEX_CORRELATION_ROOT}/${CODEX_CORRELATION_LEAF}`)
  );
}

// --- session/transcript/relaunch.ts -----------------------------------------------------------------------------

/** The Claude flag a start uses to name the session it is creating. */
const HARNESS_SESSION_FLAG = '--session-id';
/** The Claude flag that continues a session the harness already has. */
const HARNESS_RESUME_FLAG = '--resume';

/**
 * The argv to relaunch with.
 *
 * Unchanged when the session was never created — including for a harness that names its own
 * session, whose argv carries neither flag.
 */
export function relaunchCommand(command: readonly string[], harnessSessionStarted: boolean): readonly string[] {
  const flag = command.indexOf(HARNESS_SESSION_FLAG);
  // Never index 0: that position is the wrapper the launch authorization pins.
  if (flag < 1 || !harnessSessionStarted) return command;
  const next = [...command];
  next[flag] = HARNESS_RESUME_FLAG;
  return next;
}

// --- session/transcript/wrapper-home.ts -------------------------------------------------------------------------

/** The variable each harness reads its private home from. */
const HOME_VARIABLE: Readonly<Record<Harness, string>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * `export NAME=value`, `export NAME="value"`, `NAME=value` — the three forms a generated wrapper
 * writes. An unquoted value stops at whitespace or a comment, so neither becomes part of the path.
 */
function assignedValue(source: string, variable: string): string | undefined {
  const pattern = new RegExp(
    String.raw`^[ \t]*(?:export[ \t]+)?${variable}=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'#]+))`,
    'mu',
  );
  const match = pattern.exec(source);
  if (match === null) return undefined;
  const value = match[1] ?? match[2] ?? match[3] ?? '';
  return value === '' ? undefined : value;
}

/** `$NAME` and `${NAME}` references, in the order they appear. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu;

/**
 * The value with every variable reference replaced by what the environment holds.
 *
 * `~` is expanded only in leading position, which is the only place a shell would have expanded it.
 */
function expand(value: string, environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const home = environment.HOME ?? '';
  const tilde = value === '~' || value.startsWith('~/');
  // A `~` with no HOME behind it is the unresolvable case below, reached before the substitution
  // rather than after it.
  if (tilde && home === '') return undefined;
  let unresolved = false;
  const expanded = (tilde ? `${home}${value.slice(1)}` : value).replaceAll(
    REFERENCE,
    (_match, braced?: string, bare?: string) => {
      const resolved = environment[braced ?? bare ?? ''] ?? '';
      if (resolved === '') unresolved = true;
      return resolved;
    },
  );
  if (unresolved) return undefined;
  // A relative home would be resolved against whatever directory the harness started in, so it
  // names no durable location and is refused for the same reason an unresolved variable is.
  return expanded.startsWith('/') ? expanded : undefined;
}

/**
 * The harness home a wrapper script exports, or `undefined` when the script declares none this
 * daemon can resolve into an absolute path. EVERY EXPANSION IS FAIL-CLOSED.
 */
export function harnessHomeFromWrapper(
  source: string,
  harness: Harness,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const declared = assignedValue(source, HOME_VARIABLE[harness]);
  return declared === undefined ? undefined : expand(declared, environment);
}

/** Codex's subcommand for continuing a conversation it already has. */
const CODEX_RESUME = 'resume';

/**
 * The transcript arguments a RELAUNCH of an existing session must carry.
 *
 * The recorded provenance is the evidence: Claude's minted id is what the start put on the argv. Codex names its own
 * session, so a fresh one takes nothing; once its thread is KNOWN — proven by correlation, or adopted and started with
 * `resume <id>` — every relaunch resumes it. A Codex session with a correlation token is relaunched DECLARING it again,
 * as its start did, so Restart can repair a session whose rollout was never proven.
 */
export function transcriptLaunchArguments(
  harness: HarnessKind,
  provenance: TranscriptProvenance | undefined,
): readonly string[] {
  if (harness !== 'claude') {
    // The schema makes an id present exactly when the identity is established.
    const id = provenance?.harnessSessionId;
    const token = provenance?.correlationToken;
    return [
      ...(id === undefined ? [] : [CODEX_RESUME, id]),
      ...(token === undefined ? [] : codexCorrelationArguments(token)),
    ];
  }
  return provenance?.harnessSessionId === undefined ? [] : claudeSessionArguments(provenance.harnessSessionId);
}
