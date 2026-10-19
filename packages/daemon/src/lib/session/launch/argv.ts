/**
 * THE ONE LAUNCH ARGV, built from what is true NOW rather than replayed from what was true once.
 *
 * Every way an agent process comes into being — a start, a Restart CLI, a migration, a revive of a
 * dead pane — runs the fleet wrapper with arguments the daemon owns. Those arguments used to be
 * assembled in three places that drifted apart: the start added `--model`, the migration forgot it,
 * and the revive did not assemble anything at all — it re-ran the argv recorded at start, so a session
 * started before the handoff `Read(...)` rules existed never got them, and a session switched to
 * another model came back on the one it started with.
 *
 * WHAT THE DAEMON OWNS ON THE ARGV, in launch order:
 *
 *   1. the wrapper itself — which carries everything the FLEET owns (permission mode, the fixed
 *      `--settings` file, MCP, skills, instructions) and is regenerated whenever those change;
 *   2. the remote-control arguments, only when the session asked for that surface;
 *   3. the transcript arguments that name the harness session (`--session-id`);
 *   4. the fixed `Read(...)` rules for the session's own hand-off folders;
 *   5. the session's CURRENT model and reasoning effort;
 *   6. the owner's free-form harness flags, LAST, so an explicitly supplied flag still wins.
 *
 * Pure: strings in, strings out. Which values go in is the relaunch service's decision.
 */

import type { HarnessKind } from '@ferretry/fleet';
import type { TranscriptProvenance } from '@ferretry/protocol';
import { handoffReadArguments } from '../send/handoff.ts';
import { claudeSessionArguments } from '../transcript/claude-path.ts';
import { HARNESS_RESUME_FLAG, HARNESS_SESSION_FLAG } from '../transcript/relaunch.ts';

/** The daemon-owned parts of one launch. */
export interface LaunchArgvParts {
  readonly harness: HarnessKind;
  /** The absolute fleet wrapper. Index 0 of the argv, which launch authorization pins. */
  readonly executable: string;
  /** The remote-control surface's arguments, or none when the session has no such surface. */
  readonly remoteControl: readonly string[];
  /** The arguments naming the harness session, in their CREATE form (`--session-id`). */
  readonly transcript: readonly string[];
  /** The session's hand-off folders, read without a prompt. */
  readonly readableFolders: readonly string[];
  /** The model to run on. Absent leaves the wrapper's default in charge. */
  readonly model?: string;
  /** The reasoning effort to run at. Absent leaves the harness's own setting in charge. */
  readonly effort?: string;
  readonly harnessFlags: readonly string[];
}

/** `--model <id>` for both harness CLIs. */
const modelArguments = (model: string | undefined): readonly string[] =>
  model === undefined ? [] : ['--model', model];

/** A TOML basic string, for a value a Codex `-c` override carries. */
const tomlBasicString = (value: string): string => `"${value.replace(/[\\"]/gu, character => `\\${character}`)}"`;

/** The Codex config key its reasoning effort is read from. */
const CODEX_EFFORT_KEY = 'model_reasoning_effort';

/**
 * The launch argument that starts a harness at a reasoning effort.
 *
 * Claude takes `--effort <level>`; Codex has no flag and reads `model_reasoning_effort` from its
 * configuration, which `-c` overrides for one invocation.
 */
export function effortLaunchArguments(harness: HarnessKind, effort: string | undefined): readonly string[] {
  if (effort === undefined) return [];
  return harness === 'claude' ? ['--effort', effort] : ['-c', `${CODEX_EFFORT_KEY}=${tomlBasicString(effort)}`];
}

/** The whole argv, in the order the file comment states. */
export function buildLaunchArgv(parts: LaunchArgvParts): readonly string[] {
  return [
    parts.executable,
    ...parts.remoteControl,
    ...parts.transcript,
    ...handoffReadArguments(parts.harness, parts.readableFolders),
    ...modelArguments(parts.model),
    ...effortLaunchArguments(parts.harness, parts.effort),
    ...parts.harnessFlags,
  ];
}

/**
 * The transcript arguments a RELAUNCH of an existing session must carry.
 *
 * The recorded provenance is the evidence: Claude's minted id is what the start put on the argv. A
 * session whose document predates provenance still carries the flag in its recorded argv, so that
 * id is kept rather than a new conversation being created. Codex names its own session and takes
 * nothing — except a conversation Ferretry ADOPTED, which it was started on with `resume <id>` and
 * must keep being resumed into.
 */
export function transcriptLaunchArguments(
  harness: HarnessKind,
  provenance: TranscriptProvenance | undefined,
  recorded: readonly string[],
): readonly string[] {
  if (harness !== 'claude') {
    const adopted = provenance?.identity === 'adopted' ? provenance.harnessSessionId : undefined;
    const id = adopted ?? (recorded[1] === CODEX_RESUME ? recorded[2] : undefined);
    return id === undefined ? [] : [CODEX_RESUME, id];
  }
  if (provenance?.harnessSessionId !== undefined) return claudeSessionArguments(provenance.harnessSessionId);
  const at = recorded.findIndex(token => token === HARNESS_SESSION_FLAG || token === HARNESS_RESUME_FLAG);
  const id = at < 1 ? undefined : recorded[at + 1];
  return id === undefined ? [] : claudeSessionArguments(id);
}

/** Codex's subcommand for continuing a conversation it already has. */
const CODEX_RESUME = 'resume';

/** Flags whose VALUE is the next argv entry and that describe the run, not the settings. */
const RUN_FLAGS: ReadonlySet<string> = new Set([HARNESS_SESSION_FLAG, HARNESS_RESUME_FLAG, '--model', '--effort']);
/** Codex `-c` overrides that select the model or the effort rather than a setting. */
const RUN_OVERRIDE = /^(?:model|model_reasoning_effort)=/u;

/**
 * The argv with what describes THIS RUN removed: the harness session, the model and the effort.
 *
 * What is left is the part a relaunch would change if a setting changed — the wrapper, the
 * remote-control surface, the `Read(...)` rules, the owner's flags — which is what a stale-settings
 * check must compare. A model the owner switched to with `/model` is not a stale setting, and a
 * revive turning `--session-id` into `--resume` is not one either.
 */
export function settingsArguments(argv: readonly string[]): readonly string[] {
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const next = argv[index + 1];
    if (RUN_FLAGS.has(token) || (token === '-c' && next !== undefined && RUN_OVERRIDE.test(next))) {
      index += 1;
      continue;
    }
    kept.push(token);
  }
  return kept;
}
