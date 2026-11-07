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
 *      overlay, see {@link overlayLaunchArguments});
 *   7. where the conversation is compacted (Codex `-c model_auto_compact_token_limit=…`; Claude the same
 *      `--settings` overlay as fast mode, see {@link overlayLaunchArguments});
 *   8. the owner's free-form harness flags, LAST, so an explicitly supplied flag still wins.
 *
 * Pure: strings in, strings out. Which values go in is the relaunch service's decision.
 */

import type { HarnessKind } from '@ferretry/fleet';
import type { CompactAt, TranscriptProvenance } from '@ferretry/protocol';
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
   * Where to compact the conversation, in tokens. Absent leaves the harness's own trigger in charge, which
   * is what `auto` means, so `auto` never reaches here.
   */
  readonly compactAt?: number;
  /**
   * The text of the login's fixed `--settings` file, for a Claude launch that names fast mode or a compaction
   * trigger. Claude honours ONE `--settings`, the last, so naming either replaces the wrapper's own overlay
   * and has to carry it along. Empty when the login has no such file.
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

/** The Codex config key its automatic compaction trigger is read from. */
const CODEX_COMPACT_KEY = 'model_auto_compact_token_limit';

/** The Claude settings key its automatic compaction trigger is read from. */
const CLAUDE_COMPACT_KEY = 'autoCompactWindow';

/** A fixed settings file that is not a JSON object cannot be carried into a replacement overlay. */
export class FixedSettingsUnreadableError extends Error {
  constructor() {
    super(
      'the login’s fixed settings file is not a JSON object, so fast mode or a compaction trigger cannot be added to its launch',
    );
    this.name = 'FixedSettingsUnreadableError';
  }
}

/**
 * Everything the launch says through Claude's one `--settings` (or Codex's `-c` pairs): fast mode and the
 * compaction trigger. Asking for both yields ONE overlay carrying both.
 *
 *   * Codex reads its service tier from configuration, which `-c` overrides for one invocation.
 *   * Claude has no flag for fast mode. `--settings '{"fastMode":true}'` works, but only ONE `--settings` is
 *     honoured — the last — and the fleet wrapper already passes the fixed overlay (permission mode,
 *     skipped prompts). So the overlay is read, `fastMode` is added to it, and the whole object is
 *     passed inline after the wrapper's own, which it then replaces without losing anything.
 *
 * Fast mode is explicit in both directions: a login that saved fast mode with an earlier `/fast on` would
 * otherwise start every later session fast, whatever it was launched with.
 *
 * Throws {@link FixedSettingsUnreadableError} when the fixed file exists and is not a JSON object:
 * dropping it would launch an unattended agent without its permission mode.
 */
function overlayLaunchArguments(
  harness: HarnessKind,
  wanted: { readonly fast?: boolean | undefined; readonly compactAt?: number | undefined },
  fixedSettings: string | undefined,
): readonly string[] {
  const { fast, compactAt } = wanted;
  if (fast === undefined && compactAt === undefined) return [];
  if (harness === 'codex')
    return [
      ...(fast === undefined
        ? []
        : ['-c', `${CODEX_TIER_KEY}=${tomlBasicString(fast ? CODEX_TIER.fast : CODEX_TIER.standard)}`]),
      ...(compactAt === undefined ? [] : ['-c', `${CODEX_COMPACT_KEY}=${compactAt}`]),
    ];
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
  return [
    '--settings',
    JSON.stringify({
      ...base,
      ...(fast === undefined ? {} : { fastMode: fast }),
      ...(compactAt === undefined ? {} : { [CLAUDE_COMPACT_KEY]: compactAt }),
    }),
  ];
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
    ...overlayLaunchArguments(parts.harness, { fast: parts.fast, compactAt: parts.compactAt }, parts.fixedSettings),
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
 * Claude's inline `--settings` overlay that carries fast mode and/or the compaction trigger. Fast mode is a
 * run fact like the model: a `/fast` typed into the pane changes it without anything having gone stale. The
 * compaction trigger is a setting, so the overlay is replaced by a `--compact-at=<n>` marker that keeps it
 * visible to the stale-settings comparison.
 */
const INLINE_SETTINGS = /^\{.*"(?:fastMode":(?:true|false)|autoCompactWindow":\d+).*\}$/su;

/** An inline overlay as an object, or nothing when it is not one. */
function inlineOverlay(overlay: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(overlay);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What an inline overlay says that a Restart would change: the compaction trigger as a `--compact-at=<n>` marker,
 * when it has one, then every OTHER setting in it as an overlay of its own. Only fast mode, a run fact, is left
 * out, whether or not the trigger rides beside it.
 */
function overlaySettings(overlay: string): readonly string[] {
  const parsed = inlineOverlay(overlay);
  const { fastMode: _fast, [CLAUDE_COMPACT_KEY]: compactAt, ...others } = parsed ?? {};
  return [
    ...(typeof compactAt === 'number' ? [`--compact-at=${compactAt}`] : []),
    ...(Object.keys(others).length === 0
      ? []
      : [
          '--settings',
          JSON.stringify(Object.fromEntries(Object.entries(others).sort(([a], [b]) => a.localeCompare(b)))),
        ]),
  ];
}

/**
 * The compaction trigger a recorded launch command carries, in tokens, or `auto` when it carries none — what the
 * RUNNING process was started with. The LAST word wins, as it does for the process: Claude honours one
 * `--settings`, the last, so a later one (an owner's own flag) replaces the whole overlay and its trigger with
 * it; for Codex the last `-c` pair wins.
 */
export function launchedCompactAt(command: readonly string[]): CompactAt {
  let launched: CompactAt = 'auto';
  for (let index = 0; index < command.length; index += 1) {
    const next = command[index + 1];
    if (next === undefined) break;
    if (command[index] === '--settings') {
      const value = inlineOverlay(next)?.[CLAUDE_COMPACT_KEY];
      launched = typeof value === 'number' ? value : 'auto';
    }
    if (command[index] === '-c' && next.startsWith(`${CODEX_COMPACT_KEY}=`)) {
      const value = Number(next.slice(CODEX_COMPACT_KEY.length + 1));
      if (Number.isSafeInteger(value)) launched = value;
    }
  }
  return launched;
}

/**
 * The argv with what describes THIS RUN removed: the harness session, its Codex correlation root,
 * the model, the effort and fast mode. The compaction trigger stays (Codex's `-c` pair as it is, Claude's
 * overlay as a `--compact-at=<n>` marker), because changing it is a change a Restart applies.
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
    if (token === '--settings' && next !== undefined && INLINE_SETTINGS.test(next)) {
      kept.push(...overlaySettings(next));
      index += 1;
      continue;
    }
    if (
      RUN_FLAGS.has(token) ||
      (token === '-c' && next !== undefined && RUN_OVERRIDE.test(next)) ||
      isCodexCorrelationPair(token, next)
    ) {
      index += 1;
      continue;
    }
    kept.push(token);
  }
  return kept;
}
