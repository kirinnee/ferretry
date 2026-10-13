/**
 * The fixed layer — what Ferretry adds LAST to an agent runtime, and what it overrides
 * (docs/design/account-model.md §3.6, §8.4, F1–F5, E24).
 *
 * Only agent runtimes get it (F1). Its contents are exactly three things and never a credential or
 * an identity (F3): no trust prompt, no onboarding screens, and the permission mode from the
 * machine's **Agent permissions** (F4). Two carried-over launch flags join it because nobody is
 * there to answer an agent: Claude's `--disallowed-tools=AskUserQuestion` (owner question O3,
 * built with the lead's default) and Codex's `--no-alt-screen`.
 *
 * It wins because it is LAUNCH ARGUMENTS, which outrank every file the harness or the person can
 * edit (§8.4). So {@link applyFixedLayer} appends them after every flag the profile carries and
 * drops the profile's own flags that would fight them, and reports each user value it overrode so
 * a surface can strike it through (F2, E24).
 *
 * Measured, and authoritative over the design where they differ:
 *
 * - Every agent launch names its permission mode EXPLICITLY. Claude 2.1.296 made `auto` its default,
 *   so leaving the flag off would hand the choice to whichever version is installed.
 * - Codex's trust override is the TOML inline table `-c projects={"<cwd>"={trust_level="trusted"}}`.
 *   The design's dotted spelling makes the quotes part of the key and does not work. The table
 *   MERGES with `config.toml`'s own `projects`, so it names the launch folder alone.
 * - The bypass-permissions warning is suppressed by a `--settings` overlay holding
 *   `skipDangerousModePermissionPrompt`, returned here as `claudeSettingsOverlay` for the wrapper
 *   (`./materialise.ts`) to write and pass, because where that file lives is the wrapper's fact.
 *
 * Owner question O4, built with the lead's default: when the installed Claude does not accept
 * `--permission-mode auto`, the agent runtime is REFUSED with the fix named. Auto mode is never
 * mapped to a weaker or a stronger mode behind anybody's back.
 *
 * Pure and total: the machine setting, the launch folder and what the installed Claude accepts are
 * all parameters, read at launch by the caller, so a change applies to new sessions only (F5).
 */
import type { HarnessKind } from '../manifest.ts';
import { deepMergeSettings, type SettingsObject } from '../settings.ts';
import {
  type FlagContribution,
  type FlatLayer,
  pathsOverlap,
  type ResolvedProfile,
  sameSettingsValue,
  settingsKey,
} from './layering.ts';
import type { AgentPermissions } from './schema.ts';

/** What one fixed-layer entry is for, as the read-only lock shows it. */
export type FixedEntryPurpose =
  | 'permission-mode'
  | 'skip-prompt'
  | 'trust'
  | 'onboarding'
  | 'no-questions'
  | 'no-alt-screen';

/**
 * One locked entry of the fixed layer (F2).
 *
 * `target` is the document the value is about: the harness's `settings` (Claude `settings.json`,
 * Codex `config.toml`) — the ones a Settings component can also set, and so the ones an override is
 * reported against — Claude's per-config-directory `claude-json`, or a bare `launch` flag.
 */
export interface FixedEntry {
  readonly purpose: FixedEntryPurpose;
  readonly target: 'settings' | 'claude-json' | 'launch';
  readonly path: readonly string[];
  readonly key: string;
  readonly value: unknown;
}

export interface FixedLayer {
  readonly harness: HarnessKind;
  readonly agentPermissions: AgentPermissions;
  readonly entries: readonly FixedEntry[];
  /** Launch arguments, appended after every flag the profile carries. */
  readonly args: readonly string[];
  /**
   * Claude only: the body of the `--settings` overlay, when the layer needs one. The wrapper writes
   * it and passes `--settings <file>` after {@link FixedLayer.args}.
   */
  readonly claudeSettingsOverlay?: SettingsObject;
  /** Claude only: the keys re-asserted into the config directory's `.claude.json` before launch. */
  readonly claudeJson?: SettingsObject;
}

/** Why an agent runtime cannot be launched as asked. */
export interface FixedLayerRefusal {
  readonly kind: 'claude-auto-mode-unsupported';
  readonly message: string;
}

export type FixedLayerResult =
  | { readonly ok: true; readonly layer: FixedLayer }
  | { readonly ok: false; readonly refusal: FixedLayerRefusal };

export type FixedLayerInput =
  | {
      readonly harness: 'claude';
      readonly agentPermissions: AgentPermissions;
      /** The folder the agent is launched in. */
      readonly cwd: string;
      /** Whether the installed Claude accepts `--permission-mode auto` (O4). */
      readonly acceptsAutoPermissionMode: boolean;
    }
  | {
      readonly harness: 'codex';
      readonly agentPermissions: AgentPermissions;
      readonly cwd: string;
    };

/** Claude's spelling of each Agent permissions choice (§3.6). */
export const CLAUDE_PERMISSION_MODES: Readonly<Record<AgentPermissions, string>> = {
  auto: 'auto',
  skip: 'bypassPermissions',
};

/** Codex's spelling of each Agent permissions choice (§3.6). */
export const CODEX_PERMISSIONS: Readonly<
  Record<AgentPermissions, { readonly approvalPolicy: string; readonly sandboxMode: string }>
> = {
  auto: { approvalPolicy: 'on-request', sandboxMode: 'workspace-write' },
  skip: { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
};

/** O3: an agent has nobody to answer a question, so the tool that asks one is withheld. */
export const CLAUDE_NO_QUESTIONS_FLAG = '--disallowed-tools=AskUserQuestion';

export const CODEX_NO_ALT_SCREEN_FLAG = '--no-alt-screen';

const CARRIED_FLAGS: ReadonlySet<string> = new Set([CLAUDE_NO_QUESTIONS_FLAG, CODEX_NO_ALT_SCREEN_FLAG]);

/** A TOML basic string: what a `-c` override needs to carry any folder path. */
export function tomlString(value: string): string {
  const escaped = [...value]
    .map(character => {
      if (character === '\\') return '\\\\';
      if (character === '"') return '\\"';
      const code = character.codePointAt(0) as number;
      return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : character;
    })
    .join('');
  return `"${escaped}"`;
}

/** The measured Codex trust override for one folder: a TOML inline table, never a dotted key. */
export const codexTrustOverride = (cwd: string): string => `projects={${tomlString(cwd)}={trust_level="trusted"}}`;

const entry = (
  purpose: FixedEntryPurpose,
  target: FixedEntry['target'],
  path: readonly string[],
  value: unknown,
): FixedEntry => ({ purpose, target, path, key: target === 'launch' ? path.join(' ') : settingsKey(path), value });

const AUTO_MODE_REFUSAL =
  "Claude Code on this machine does not accept Auto mode (--permission-mode auto), so Ferretry won't launch this agent runtime. Update Claude Code, or switch this machine's Agent permissions to Skip all permission checks.";

/** The fixed layer for an agent runtime of `input.harness`, or the reason it cannot launch (O4). */
export function fixedLayerFor(input: FixedLayerInput): FixedLayerResult {
  const { agentPermissions, cwd } = input;
  if (input.harness === 'claude') {
    if (agentPermissions === 'auto' && !input.acceptsAutoPermissionMode) {
      return { ok: false, refusal: { kind: 'claude-auto-mode-unsupported', message: AUTO_MODE_REFUSAL } };
    }
    const mode = CLAUDE_PERMISSION_MODES[agentPermissions];
    const skip = agentPermissions === 'skip';
    const entries = [
      entry('permission-mode', 'settings', ['permissions', 'defaultMode'], mode),
      ...(skip ? [entry('skip-prompt', 'settings', ['skipDangerousModePermissionPrompt'], true)] : []),
      entry('trust', 'claude-json', ['projects', cwd, 'hasTrustDialogAccepted'], true),
      entry('onboarding', 'claude-json', ['hasCompletedOnboarding'], true),
      entry('no-questions', 'launch', [CLAUDE_NO_QUESTIONS_FLAG], true),
    ];
    return {
      ok: true,
      layer: {
        harness: 'claude',
        agentPermissions,
        entries,
        args: ['--permission-mode', mode, CLAUDE_NO_QUESTIONS_FLAG],
        ...(skip ? { claudeSettingsOverlay: { skipDangerousModePermissionPrompt: true } } : {}),
        claudeJson: { hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } },
      },
    };
  }
  const { approvalPolicy, sandboxMode } = CODEX_PERMISSIONS[agentPermissions];
  return {
    ok: true,
    layer: {
      harness: 'codex',
      agentPermissions,
      entries: [
        entry('permission-mode', 'settings', ['approval_policy'], approvalPolicy),
        entry('permission-mode', 'settings', ['sandbox_mode'], sandboxMode),
        entry('trust', 'settings', ['projects', cwd, 'trust_level'], 'trusted'),
        entry('no-alt-screen', 'launch', [CODEX_NO_ALT_SCREEN_FLAG], true),
      ],
      args: [
        '-c',
        `approval_policy=${tomlString(approvalPolicy)}`,
        '-c',
        `sandbox_mode=${tomlString(sandboxMode)}`,
        '-c',
        codexTrustOverride(cwd),
        CODEX_NO_ALT_SCREEN_FLAG,
      ],
    },
  };
}

// ── Applying it ──────────────────────────────────────────────────────────────────────────────────

/** A user value the fixed layer overrides, shown struck through (E24). */
export type FixedOverride =
  | {
      readonly kind: 'setting';
      readonly key: string;
      readonly path: readonly string[];
      readonly value: unknown;
      readonly layer: FlatLayer;
      readonly fixed: FixedEntry;
    }
  | {
      /** A profile flag dropped from the launch because the fixed layer decides what it decides. */
      readonly kind: 'flag';
      /** The flag as written, with its value when it takes one: `['--permission-mode', 'plan']`. */
      readonly tokens: readonly string[];
      readonly layer: FlatLayer;
    };

/** An agent runtime's launch, with the fixed layer applied last. */
export interface AgentLaunch {
  readonly fixed: FixedLayer;
  /** The profile's settings with every fixed `settings` entry written over them. */
  readonly settings: SettingsObject;
  /** The profile's surviving flags in order, then the fixed layer's arguments. */
  readonly args: readonly string[];
  readonly overridden: readonly FixedOverride[];
}

/**
 * The permission flags each harness's fixed layer replaces. `value` flags take the next token as
 * their value unless written `--flag=value`; `config` is Codex's `-c key=value`, superseded only for
 * the keys the fixed layer sets.
 */
const SUPERSEDED_FLAGS: Readonly<Record<HarnessKind, Readonly<Record<string, 'bare' | 'value' | 'config'>>>> = {
  claude: {
    '--permission-mode': 'value',
    '--dangerously-skip-permissions': 'bare',
    '--allow-dangerously-skip-permissions': 'bare',
  },
  codex: {
    '--dangerously-bypass-approvals-and-sandbox': 'bare',
    '--full-auto': 'bare',
    '--ask-for-approval': 'value',
    '-a': 'value',
    '--sandbox': 'value',
    '-s': 'value',
    '--config': 'config',
    '-c': 'config',
  },
};

const CODEX_FIXED_CONFIG_KEYS: ReadonlySet<string> = new Set(['approval_policy', 'sandbox_mode']);

/** Split a profile's flags into the ones the launch keeps and the ones the fixed layer replaces. */
function partitionFlags(
  harness: HarnessKind,
  flags: readonly FlagContribution[],
  fixedArgs: readonly string[],
): { readonly kept: readonly string[]; readonly dropped: readonly FixedOverride[] } {
  const table = SUPERSEDED_FLAGS[harness];
  const fixedTokens = new Set(fixedArgs.filter(arg => CARRIED_FLAGS.has(arg)));
  const kept: string[] = [];
  const dropped: FixedOverride[] = [];
  for (let index = 0; index < flags.length; index++) {
    const { flag, layer } = flags[index] as FlagContribution;
    const equals = flag.indexOf('=');
    const name = equals > 0 ? flag.slice(0, equals) : flag;
    const shape = table[name];
    if (shape === undefined) {
      // A flag the fixed layer passes itself would be passed twice, which a strict parser refuses.
      if (!fixedTokens.has(flag)) kept.push(flag);
      continue;
    }
    const inline = equals > 0;
    const next = flags[index + 1];
    const takesNext = shape !== 'bare' && !inline && next !== undefined;
    const tokens = takesNext ? [flag, (next as FlagContribution).flag] : [flag];
    if (shape === 'config') {
      const assignment = inline ? flag.slice(equals + 1) : (next?.flag ?? '');
      const key = assignment.split('=')[0]?.trim() ?? '';
      if (!CODEX_FIXED_CONFIG_KEYS.has(key)) {
        kept.push(...tokens);
        if (takesNext) index++;
        continue;
      }
    }
    dropped.push({ kind: 'flag', tokens, layer });
    if (takesNext) index++;
  }
  return { kept, dropped };
}

/** The fixed `settings` entries as one document, to write over the profile's own. */
const fixedSettingsDocument = (entries: readonly FixedEntry[]): SettingsObject =>
  entries
    .filter(fixed => fixed.target === 'settings')
    .reduce<SettingsObject>((document, fixed) => {
      const nested = [...fixed.path].reverse().reduce<unknown>((inner, segment) => ({ [segment]: inner }), fixed.value);
      return deepMergeSettings(document, nested as SettingsObject);
    }, {});

/**
 * Apply `fixed` LAST to a profile resolved for the same harness (F1): its settings entries are
 * written over the profile's, its arguments come after the profile's flags, and every user value
 * that lost is reported (E24). A value the user set to exactly what the fixed layer sets is not an
 * override and is not reported.
 */
export function applyFixedLayer(resolved: ResolvedProfile, fixed: FixedLayer): AgentLaunch {
  const overridden: FixedOverride[] = [];
  for (const fixedEntry of fixed.entries) {
    if (fixedEntry.target !== 'settings') continue;
    for (const leaf of resolved.settings.leaves) {
      if (!pathsOverlap(leaf.path, fixedEntry.path)) continue;
      if (leaf.path.length === fixedEntry.path.length && sameSettingsValue(leaf.value, fixedEntry.value)) continue;
      overridden.push({
        kind: 'setting',
        key: leaf.key,
        path: leaf.path,
        value: leaf.value,
        layer: leaf.layer,
        fixed: fixedEntry,
      });
    }
  }
  const flags = partitionFlags(fixed.harness, resolved.flags, fixed.args);
  return {
    fixed,
    settings: deepMergeSettings(resolved.settings.value, fixedSettingsDocument(fixed.entries)),
    args: [...flags.kept, ...fixed.args],
    overridden: [...overridden, ...flags.dropped],
  };
}
