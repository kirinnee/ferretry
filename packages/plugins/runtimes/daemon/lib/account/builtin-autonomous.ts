/**
 * What the built-in, read-only profiles `ferretry-claude` and `ferretry-codex` hold, so Claude Code and Codex work ALONE
 * well with nothing imported. They ship with Ferretry and are never written to a file; a profile or component of the same
 * name in `config/` wins (copy it to edit it).
 *
 * WHAT THEY HOLD (runtimes plan U2, owner !A613):
 * - the starter model set of the harness (`FLEET_STARTER_MODELS`);
 * - the instructions, ONE generic text each harness writes as its own file (`CLAUDE.md`, `AGENTS.md`). It says only what
 *   the launch instruction parts (`fixed-layer.ts`: tools, settings, agenda, sub-ferret, pack) do not already say;
 * - Claude's comfort settings, only what the fixed layer does not already force. Codex has none: every setting worth
 *   changing is already its default (`shell_environment_policy.inherit` is `all`, and its default excludes of KEY, SECRET
 *   and TOKEN variables must stay), so adding one would only hide that.
 *
 * WHAT THEY DO NOT HOLD:
 * - **Permissions (D6).** The permission mode stays the machine's (`harness-<x>.yaml`, default `skip`), so applying a
 *   profile is never a loosening. {@link COMFORT_SETTINGS} is checked for permission keys by its test.
 * - **The Ferretry MCP server and tools.** They already reach every autonomous ferret as a launch part of the fixed layer
 *   (`--mcp-config` / `mcp_servers.ferretry`), so naming them here would add them twice.
 * - **Skills.** None; the owner's catalogs add their own.
 *
 * An imported setup layers OVER these (these are its oldest layers), so the owner's own words win where they say anything.
 *
 * Pure: values only.
 */
import { FLEET_STARTER_MODELS } from '../defaults.ts';
import { isKind, supportedKinds } from '../harness-kind.ts';
import type { HarnessKind } from '../manifest.ts';
import type { InstructionsComponent, SettingsComponent } from './schema.ts';

/** The built-in profile of a harness (the names O8-9 introduced): derived runtimes run on it. */
export const builtinProfileName = (harness: HarnessKind): string => `ferretry-${harness}`;

/** The generic instructions component every built-in profile names. */
const AUTONOMOUS_INSTRUCTIONS_NAME = 'ferretry-work-alone';

/** The comfort settings component of Claude Code (a component is named once across harnesses, so it says which). */
const CLAUDE_COMFORT_NAME = 'ferretry-claude-comfort';

/**
 * The one generic text: how to work well on your own. The home file is the same for an autonomous and an interactive
 * launch (the wrapper exports one home for both), so every line is true in BOTH: nothing here says nobody is watching.
 * What only an autonomous launch is told (the agenda, a lead) is the launch parts' (`fixed-layer.ts`, by
 * `FY_SESSION_MODE`), and this only points at it. Short on purpose (it is in every ferret's context).
 */
export const AUTONOMOUS_INSTRUCTIONS = [
  '# Working well on your own',
  '',
  '- When a choice is yours to make, make it: pick the sensible option and say what you chose, rather than stopping at "should I continue?".',
  '- If only the owner can decide something that blocks you, ask through the channel your launch instructions name (if they name none, ask in the conversation), then carry on with whatever is not blocked.',
  '- Commit, push or open a pull request only when asked to.',
  '- Verify before you say it is done: run the checks, read their output, and report a failure as a failure.',
  "- Follow the repository's own `CLAUDE.md` / `AGENTS.md`. Where they disagree with this page, they win.",
  '',
].join('\n');

/**
 * Claude's comfort settings. NONE is a permission: they keep a long unattended run from being cut short (history kept long
 * enough to resume, long shell and MCP waits), and go in the launch environment.
 */
export const COMFORT_SETTINGS = {
  harness: 'claude',
  document: { cleanupPeriodDays: 90 },
  env: { BASH_DEFAULT_TIMEOUT_MS: '600000', MCP_TIMEOUT: '60000' },
} as const;

/**
 * Whether an instructions layer is the built-in text itself: the built-in name AND its own words. A component of the same
 * name the owner wrote is theirs (an explicit choice), so it is never taken for this one.
 */
export const isBuiltinInstructions = (name: string, body: string | undefined): boolean =>
  name === AUTONOMOUS_INSTRUCTIONS_NAME && body === AUTONOMOUS_INSTRUCTIONS;

/** The layers of each built-in profile, oldest first. */
export const builtinProfileLayers = (harness: HarnessKind): readonly string[] => [
  `modelSets/${builtinProfileName(harness)}`,
  `instructions/${AUTONOMOUS_INSTRUCTIONS_NAME}`,
  ...(isKind(harness, 'claude') ? [`settings/${CLAUDE_COMFORT_NAME}`] : []),
];

/** The built-in components by kind and name; an owner's component of the same name always wins over these. */
export const BUILTIN_COMPONENTS: {
  readonly instructions: Readonly<Record<string, InstructionsComponent>>;
  readonly settings: Readonly<Record<string, SettingsComponent>>;
} = {
  instructions: { [AUTONOMOUS_INSTRUCTIONS_NAME]: { text: AUTONOMOUS_INSTRUCTIONS } as InstructionsComponent },
  settings: { [CLAUDE_COMFORT_NAME]: COMFORT_SETTINGS as unknown as SettingsComponent },
};

/** The starter model set of a harness (O8-9's; U1 moves it to the catalog default). */
export const starterModelSet = (harness: HarnessKind): { readonly models: string[]; readonly default: string } => ({
  models: [FLEET_STARTER_MODELS[harness]],
  default: FLEET_STARTER_MODELS[harness],
});

/**
 * Every built-in piece as an account-model document, for a model assembled with nothing beside it: the first import on a
 * machine with no files, whose profiles name `profile/ferretry-<harness>` as their oldest layer. Equal to what
 * `deriveRuntimes` and the component built-ins give, so a change that starts from it writes none of it.
 */
export function builtinDocument(): {
  readonly profiles: Readonly<Record<string, { readonly layers: readonly string[] }>>;
  readonly components: {
    readonly modelSets: Readonly<Record<string, unknown>>;
    readonly instructions: Readonly<Record<string, InstructionsComponent>>;
    readonly settings: Readonly<Record<string, SettingsComponent>>;
  };
} {
  const harnesses = supportedKinds();
  return {
    profiles: Object.fromEntries(
      harnesses.map(harness => [builtinProfileName(harness), { layers: builtinProfileLayers(harness) }]),
    ),
    components: {
      modelSets: Object.fromEntries(harnesses.map(harness => [builtinProfileName(harness), starterModelSet(harness)])),
      ...BUILTIN_COMPONENTS,
    },
  };
}
