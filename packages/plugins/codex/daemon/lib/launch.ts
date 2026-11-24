/**
 * The argv of one Codex launch, built from what is true NOW rather than replayed from what was true once.
 *
 * Codex's half of the old launch argv builder: the harness CLI itself, `resume <id>` when its conversation is known,
 * the settings items' flags (any flag; the permission switches the launch decides are dropped from them), the model, the
 * reasoning effort and the service tier, the compaction trigger and prompt, and the launch's own flags LAST so they win. Codex has no flag for effort, tier or the compaction trigger; it reads them
 * from configuration, which `-c` overrides for one invocation.
 *
 * Pure: strings in, strings out. Which values go in is the caller's decision.
 */
import { launchFlagsKept } from '../../contract/index.ts';
import { CODEX_COMPACT_PROMPT_KEY } from './compact-prompt.ts';
import { startupModelArguments } from './startup.ts';
import { tomlString } from './toml.ts';

/** A TOML basic string, for a value a Codex `-c` override carries. */
const tomlBasicString = (value: string): string => `"${value.replace(/[\\"]/gu, character => `\\${character}`)}"`;

/** The Codex config key its reasoning effort is read from. */
const CODEX_EFFORT_KEY = 'model_reasoning_effort';
/** The Codex config key its service tier is read from. */
const CODEX_TIER_KEY = 'service_tier';
/** The service tier ids Codex's `/fast` moves between: `priority` is the fast one. */
const CODEX_TIER = { fast: 'priority', standard: 'default' } as const;
/** The Codex config key its automatic compaction trigger is read from. */
const CODEX_COMPACT_KEY = 'model_auto_compact_token_limit';
/** Codex's subcommand for continuing a conversation it already has. */
const CODEX_RESUME = 'resume';

/** The launch argument that starts Codex at a reasoning effort. */
function effortLaunchArguments(effort: string | undefined): readonly string[] {
  return effort === undefined ? [] : ['-c', `${CODEX_EFFORT_KEY}=${tomlBasicString(effort)}`];
}

/** The daemon-owned parts of one Codex launch. */
export interface CodexLaunchParts {
  /** The Codex executable. Index 0 of the argv, which launch authorization pins. */
  readonly executable: string;
  /** Codex's own conversation id; present exactly when the launch continues one. */
  readonly resume?: string;
  /** The model to run on. Absent leaves the account's default in charge. */
  readonly model?: string;
  /** The reasoning effort to run at. Absent leaves Codex's own setting in charge. */
  readonly effort?: string;
  /**
   * Whether to launch in fast mode. Absent leaves Codex's own setting in charge, which is NOT 'off': Codex's fastest
   * models run fast by default, and a login may have saved either answer.
   */
  readonly fast?: boolean;
  /** Where to compact the conversation, in tokens. Absent leaves Codex's own trigger in charge. */
  readonly compactAt?: number;
  /** The prompt Codex summarises with at a compaction. It REPLACES Codex's own, so it must still ask for the summary. Absent leaves Codex's own in charge. */
  readonly compactPrompt?: string;
  /**
   * The settings items' launch flags (`launchFlagsKept`, the ones the launch decides already dropped by it): placed BEFORE
   * every argument the launch sets, so the model, effort, tier, trigger and fixed layer all win over them.
   */
  readonly settingsFlags?: readonly string[];
  readonly harnessFlags?: readonly string[];
}

/**
 * The programs a Codex launch execs through at the pane's one pid, ending in Codex itself (`RunSpec.execChain`): the
 * `env` that sets `CODEX_HOME`, then the interpreter an installed `codex` script runs on before it execs the real
 * binary (measured on a nix install: `systemd-run` → `bash` → `codex`; an npm install is a `node` script, a shim may be
 * `sh`), then the binary's own name. A runner binds a first turn to the pane along this chain and no other.
 */
export function codexExecChain(executable: string): readonly string[] {
  return ['env', 'bash', 'sh', 'node', executable.slice(executable.lastIndexOf('/') + 1)];
}

/**
 * The whole argv, in launch order. It carries NO prompt: a start's task is the ferret's `turns/turn-001.md`, and Ferrets
 * types the pointer to it into the pane once Codex is up, under the effect ledger's first-turn admission, exactly as
 * for every other harness (today put the prompt on no harness's argv). A prompt here as well would hand the agent its
 * task twice.
 */
export function buildCodexLaunchArgv(parts: CodexLaunchParts): readonly string[] {
  return [
    parts.executable,
    ...(parts.resume === undefined ? [] : [CODEX_RESUME, parts.resume]),
    ...launchFlagsKept(parts.settingsFlags ?? []),
    ...(parts.model === undefined ? [] : startupModelArguments(parts.model)),
    ...effortLaunchArguments(parts.effort),
    ...(parts.fast === undefined
      ? []
      : ['-c', `${CODEX_TIER_KEY}=${tomlBasicString(parts.fast ? CODEX_TIER.fast : CODEX_TIER.standard)}`]),
    ...(parts.compactAt === undefined ? [] : ['-c', `${CODEX_COMPACT_KEY}=${parts.compactAt}`]),
    ...(parts.compactPrompt === undefined
      ? []
      : ['-c', `${CODEX_COMPACT_PROMPT_KEY}=${tomlString(parts.compactPrompt)}`]),
    ...(parts.harnessFlags ?? []),
  ];
}
