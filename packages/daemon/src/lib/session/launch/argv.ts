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
 *   6. fast mode, when the session has a decided state (Codex `-c service_tier=…`; Claude a `--settings`
 *      overlay, see {@link fastLaunchArguments});
 *   7. the owner's free-form harness flags, LAST, so an explicitly supplied flag still wins.
 *
 * Pure: strings in, strings out. Which values go in is the relaunch service's decision.
 */

import type { HarnessKind } from '@ferretry/fleet';
import type { TranscriptProvenance } from '@ferretry/protocol';
import { handoffReadArguments } from '../send/handoff.ts';
import { claudeSessionArguments } from '../transcript/claude-path.ts';
import { codexCorrelationArguments, isCodexCorrelationPair } from '../transcript/codex-rollout.ts';
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
  /**
   * Whether to launch in fast mode. Absent leaves the harness's own setting in charge, which is NOT
   * "off": Codex's fastest models run fast by default, and a login may have saved either answer.
   */
  readonly fast?: boolean;
  /**
   * The text of the login's fixed `--settings` file, for a Claude launch that names fast mode. Claude
   * honours ONE `--settings`, the last, so naming fast mode replaces the wrapper's own overlay and has
   * to carry it along. Empty when the login has no such file.
   */
  readonly fixedSettings?: string;
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

/** The Codex config key its service tier is read from. */
const CODEX_TIER_KEY = 'service_tier';

/** The service tier ids Codex's `/fast` moves between: `priority` is the fast one. */
const CODEX_TIER = { fast: 'priority', standard: 'default' } as const;

/** A fixed settings file that is not a JSON object cannot be carried into a replacement overlay. */
export class FixedSettingsUnreadableError extends Error {
  constructor() {
    super('the login’s fixed settings file is not a JSON object, so fast mode cannot be added to its launch');
    this.name = 'FixedSettingsUnreadableError';
  }
}

/**
 * The launch arguments that start a harness with fast mode on or off.
 *
 *   * Codex reads its service tier from configuration, which `-c` overrides for one invocation.
 *   * Claude has no flag for it. `--settings '{"fastMode":true}'` works, but only ONE `--settings` is
 *     honoured — the last — and the fleet wrapper already passes the fixed overlay (permission mode,
 *     skipped prompts). So the overlay is read, `fastMode` is added to it, and the whole object is
 *     passed inline after the wrapper's own, which it then replaces without losing anything.
 *
 * Both are explicit in both directions: a login that saved fast mode with an earlier `/fast on` would
 * otherwise start every later session fast, whatever it was launched with.
 *
 * Throws {@link FixedSettingsUnreadableError} when the fixed file exists and is not a JSON object:
 * dropping it would launch an unattended agent without its permission mode.
 */
export function fastLaunchArguments(
  harness: HarnessKind,
  fast: boolean | undefined,
  fixedSettings: string | undefined,
): readonly string[] {
  if (fast === undefined) return [];
  if (harness === 'codex')
    return ['-c', `${CODEX_TIER_KEY}=${tomlBasicString(fast ? CODEX_TIER.fast : CODEX_TIER.standard)}`];
  const text = fixedSettings?.trim() ?? '';
  let base: Record<string, unknown> = {};
  if (text !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FixedSettingsUnreadableError();
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new FixedSettingsUnreadableError();
    base = parsed as Record<string, unknown>;
  }
  return ['--settings', JSON.stringify({ ...base, fastMode: fast })];
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
    ...fastLaunchArguments(parts.harness, parts.fast, parts.fixedSettings),
    ...parts.harnessFlags,
  ];
}

/**
 * The transcript arguments a RELAUNCH of an existing session must carry.
 *
 * The recorded provenance is the evidence: Claude's minted id is what the start put on the argv. A
 * session whose document predates provenance still carries the flag in its recorded argv, so that
 * id is kept rather than a new conversation being created. Codex names its own session, so a fresh
 * one takes nothing; once its thread is KNOWN — proven by correlation, or adopted and started with
 * `resume <id>` — every relaunch resumes it. Only adopted threads used to: a correlated session came
 * back from a revive or a Restart in a brand-new rollout, its conversation left behind on disk.
 *
 * A Codex session with a correlation token is relaunched DECLARING it again, as its start did. A
 * session whose rollout was never proven — including one started before starts declared it — would
 * otherwise come back in a fresh rollout nothing can prove either, so Restart could never repair it.
 */
export function transcriptLaunchArguments(
  harness: HarnessKind,
  provenance: TranscriptProvenance | undefined,
  recorded: readonly string[],
): readonly string[] {
  if (harness !== 'claude') {
    // The schema makes an id present exactly when the identity is established.
    const id = provenance?.harnessSessionId ?? (recorded[1] === CODEX_RESUME ? recorded[2] : undefined);
    const token = provenance?.correlationToken;
    return [
      ...(id === undefined ? [] : [CODEX_RESUME, id]),
      ...(token === undefined ? [] : codexCorrelationArguments(token)),
    ];
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
/** Codex `-c` overrides that select the model, the effort or the service tier rather than a setting. */
const RUN_OVERRIDE = /^(?:model|model_reasoning_effort|service_tier)=/u;

/**
 * Claude's inline `--settings` overlay that carries fast mode. It is a run fact like the model: a
 * `/fast` typed into the pane changes it without anything having gone stale.
 */
const INLINE_SETTINGS = /^\{.*"fastMode":(?:true|false).*\}$/su;

/**
 * The argv with what describes THIS RUN removed: the harness session, its Codex correlation root,
 * the model, the effort and fast mode.
 *
 * What is left is the part a relaunch would change if a setting changed — the wrapper, the
 * remote-control surface, the `Read(...)` rules, the owner's flags — which is what a stale-settings
 * check must compare. A model the owner switched to with `/model` is not a stale setting, and a
 * revive turning `--session-id` into `--resume` is not one either. Nor is the correlation root: every
 * session started before launches declared it would otherwise be told its settings are stale.
 */
export function settingsArguments(argv: readonly string[]): readonly string[] {
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const next = argv[index + 1];
    if (
      RUN_FLAGS.has(token) ||
      (token === '-c' && next !== undefined && RUN_OVERRIDE.test(next)) ||
      (token === '--settings' && next !== undefined && INLINE_SETTINGS.test(next)) ||
      isCodexCorrelationPair(token, next)
    ) {
      index += 1;
      continue;
    }
    kept.push(token);
  }
  return kept;
}
