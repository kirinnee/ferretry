/**
 * PEER: today's `packages/daemon/src/lib/session/transcript/{claude-path,codex-rollout,relaunch,wrapper-home}.ts` and
 * `packages/daemon/src/lib/session/send/handoff.ts` (owner: conversation) — the launch-argv half the session launch
 * code reads.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */

import type { HarnessKind } from './fleet.ts';

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
export const HARNESS_SESSION_FLAG = '--session-id';
/** The Claude flag that continues a session the harness already has. */
export const HARNESS_RESUME_FLAG = '--resume';

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
