/**
 * Every kind of configuration file, as one table: the schema a file is checked against, what a checked
 * file MEANS, what the machine behaves as when the file is absent, what a value looks like written
 * back, and which edits LOOSEN what this machine may spend or what its agents may do.
 *
 * The loosening rules are the real guard of configuration-as-files (docs/config-files.md). Anything
 * that can write a file — the owner's editor, `fy`, an agent with the `config.*` tools, an agent with
 * plain file access — can loosen, so a loosening edit is HELD until the owner confirms it, and the
 * tighter version stays in effect. Tightening always applies at once. Each rule says in words what it
 * loosened, because that sentence is what the owner confirms.
 *
 * Pure: no filesystem, no clock.
 */
import {
  type AccountDefaultLine,
  type AccountDefaultsFile,
  AccountDefaultsFileSchema,
  accountDefaultLines,
  accountDefaultScopeWords,
  type ConfigComponentKind,
  type ConfigSchemaId,
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_MODELS_GUIDE_FILE,
  DEFAULT_PACK_CONFIG,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_WARDEN_CONFIG,
  type LearningConfig,
  LearningFileSchema,
  learningConfigFromFile,
  type ModelsGuideFile,
  ModelsGuideFileSchema,
  type PackConfig,
  PackFileSchema,
  packConfigFromFile,
  type VoiceConfig,
  VoiceConfigSchema,
  type WardenConfig,
  WardenFileSchema,
  wardenConfigFromFile,
} from '@ferretry/protocol';
import { z } from 'zod';
import { BUDGET_PERIODS } from '../account/budget.ts';
import {
  type Advanced,
  AdvancedSchema,
  type AgentControl,
  type ComponentOf,
  type Credential,
  CredentialSchema,
  HooksComponentSchema,
  InstructionsComponentSchema,
  type LayerReferenceText,
  LayerReferenceTextSchema,
  MACHINE_SHAPE,
  type Machine,
  McpComponentSchema,
  ModelSetComponentSchema,
  type Runtime,
  RuntimeSchema,
  SettingsComponentSchema,
  SkillsComponentSchema,
} from '../account/schema.ts';
import { type ModelCatalogFile, ModelCatalogFileSchema } from '../models/schema.ts';
import { type ProviderPresetFile, ProviderPresetFileSchema } from '../presets/schema.ts';

/** `machine.yaml`: the machine's settings and the advanced block a beginner never sees. */
export const MachineFileSchema = z.strictObject({ ...MACHINE_SHAPE, advanced: AdvancedSchema });
export type MachineFile = z.infer<typeof MachineFileSchema>;

/** What `machine.yaml` means: the account model's `machine` and `advanced`. */
export interface MachineFileValue {
  readonly machine: Machine;
  readonly advanced: Advanced;
}

/**
 * `profiles/<name>.yaml`: the profile's contents, in order — a later entry overrides an earlier one
 * where both set the same key. The account model calls the list `layers`; the file says `contents`
 * because a profile is a bag of components, and order matters only for override.
 */
export const ProfileFileSchema = z.strictObject({
  contents: z.array(LayerReferenceTextSchema).default([]),
});
export type ProfileFile = z.infer<typeof ProfileFileSchema>;

const COMPONENT_FILE_SCHEMAS = {
  instructions: InstructionsComponentSchema,
  mcp: McpComponentSchema,
  skills: SkillsComponentSchema,
  settings: SettingsComponentSchema,
  hooks: HooksComponentSchema,
  modelSets: ModelSetComponentSchema,
} as const satisfies Record<ConfigComponentKind, z.ZodType>;

/** The schema a file of each id is checked against, as written (before any default is filled in). */
export const CONFIG_FILE_SCHEMAS: Readonly<Record<ConfigSchemaId, z.ZodType>> = {
  machine: MachineFileSchema,
  login: CredentialSchema,
  'component-instructions': COMPONENT_FILE_SCHEMAS.instructions,
  'component-mcp': COMPONENT_FILE_SCHEMAS.mcp,
  'component-skills': COMPONENT_FILE_SCHEMAS.skills,
  'component-settings': COMPONENT_FILE_SCHEMAS.settings,
  'component-hooks': COMPONENT_FILE_SCHEMAS.hooks,
  'component-modelSets': COMPONENT_FILE_SCHEMAS.modelSets,
  profile: ProfileFileSchema,
  runtime: RuntimeSchema,
  warden: WardenFileSchema,
  learning: LearningFileSchema,
  voice: VoiceConfigSchema,
  pack: PackFileSchema,
  modelsGuide: ModelsGuideFileSchema,
  accountDefaults: AccountDefaultsFileSchema,
  preset: ProviderPresetFileSchema,
  models: ModelCatalogFileSchema,
};

/** What each kind of file means once it has been checked. */
export interface ConfigValues {
  readonly machine: MachineFileValue;
  readonly login: z.infer<typeof CredentialSchema>;
  readonly component: ComponentOf<ConfigComponentKind>;
  readonly profile: { readonly layers: readonly LayerReferenceText[] };
  readonly runtime: z.infer<typeof RuntimeSchema>;
  readonly warden: WardenConfig;
  readonly learning: LearningConfig;
  readonly voice: VoiceConfig;
  readonly pack: PackConfig;
  readonly modelsGuide: ModelsGuideFile;
  readonly accountDefaults: AccountDefaultsFile;
  readonly preset: ProviderPresetFile;
  readonly models: ModelCatalogFile;
}

/** A checked file's meaning, from the schema's output. */
export function configValue(schema: ConfigSchemaId, parsed: unknown): ConfigValues[keyof ConfigValues] {
  switch (schema) {
    case 'machine': {
      const { advanced, ...machine } = parsed as MachineFile;
      return { machine, advanced };
    }
    case 'profile':
      return { layers: (parsed as ProfileFile).contents };
    case 'warden':
      return wardenConfigFromFile(parsed as z.infer<typeof WardenFileSchema>);
    case 'learning':
      return learningConfigFromFile(parsed as z.infer<typeof LearningFileSchema>);
    case 'pack':
      return packConfigFromFile(parsed as z.infer<typeof PackFileSchema>);
    default:
      return parsed as ConfigValues[keyof ConfigValues];
  }
}

/** What a value looks like written into its file, before an unchanged default is left out. */
export function configFileBody(schema: ConfigSchemaId, value: ConfigValues[keyof ConfigValues]): unknown {
  switch (schema) {
    case 'machine': {
      const { machine, advanced } = value as MachineFileValue;
      return { ...machine, advanced };
    }
    case 'profile':
      return { contents: [...(value as ConfigValues['profile']).layers] };
    default:
      return value;
  }
}

/** The singleton kinds, and what the machine behaves as without each file. */
export const SINGLETON_DEFAULTS = {
  machine: configValue('machine', MachineFileSchema.parse({})) as MachineFileValue,
  warden: DEFAULT_WARDEN_CONFIG,
  learning: DEFAULT_LEARNING_CONFIG,
  voice: DEFAULT_VOICE_CONFIG,
  pack: DEFAULT_PACK_CONFIG,
  modelsGuide: DEFAULT_MODELS_GUIDE_FILE,
  accountDefaults: {} as AccountDefaultsFile,
} as const;
export type SingletonKind = keyof typeof SINGLETON_DEFAULTS;

// ── Loosening ────────────────────────────────────────────────────────────────────────────────────

/** How "What agents may control" names each switch in a sentence. */
const AGENT_CONTROL_WORDS: Readonly<Record<keyof AgentControl, string>> = {
  terminals: 'terminals',
  browsers: 'browsers',
  files: 'project files',
  ferretrySettings: 'Ferretry settings',
  pageScripts: 'page scripts',
};

const raised = (before: number, after: number, what: string): readonly string[] =>
  after > before ? [`${what} goes up from ${String(before)} to ${String(after)}`] : [];

const lowered = (before: number, after: number, what: string): readonly string[] =>
  after < before ? [`${what} goes down from ${String(before)} to ${String(after)}`] : [];

const switchedOn = (before: boolean, after: boolean, what: string): readonly string[] =>
  !before && after ? [what] : [];

/**
 * A proxy newly set, or pointed somewhere else, or given other credentials, is held for the owner: the proxy sees
 * every host the browser visits, and its credential references are sent to whatever address is written — an agent
 * able to write the file could otherwise aim a stored secret at a server of its choosing. Removing a proxy, or
 * editing only its bypass list, hands an agent nothing it did not have.
 */
function browserProxyLoosening(
  before: MachineFileValue['machine']['browserProxy'],
  after: MachineFileValue['machine']['browserProxy'],
): readonly string[] {
  if (after === undefined) return [];
  const same =
    before !== undefined &&
    before.url === after.url &&
    before.username === after.username &&
    before.password === after.password;
  return same ? [] : [`the agent browser now sends its traffic through the proxy at ${after.url}`];
}

function machineLoosening(before: MachineFileValue, after: MachineFileValue): readonly string[] {
  return [
    ...(Object.keys(AGENT_CONTROL_WORDS) as (keyof AgentControl)[]).flatMap(kind =>
      switchedOn(
        before.machine.agentControl[kind],
        after.machine.agentControl[kind],
        `agents may now control ${AGENT_CONTROL_WORDS[kind]}`,
      ),
    ),
    ...(before.machine.agentPermissions === 'auto' && after.machine.agentPermissions === 'skip'
      ? ['agents now skip every permission prompt']
      : []),
    ...browserProxyLoosening(before.machine.browserProxy, after.machine.browserProxy),
    // A zone moves when every budget's day and week begin, so ANY change is held — the first one set
    // included. From the host's own zone (absent) to a zone where the next day has already begun would
    // reset a day that is over budget, and lift its hold, without the owner ever seeing it.
    ...(after.machine.timeZone !== before.machine.timeZone
      ? [
          `budgets now reset in ${after.machine.timeZone ?? "the host's time zone"} instead of ${before.machine.timeZone ?? "the host's time zone"}`,
        ]
      : []),
    ...switchedOn(
      before.machine.publicUsageFeed,
      after.machine.publicUsageFeed,
      'any process on this host can now read quota percentages and account labels without a credential',
    ),
  ];
}

/** A layer spends only while the Warden is on AND the layer is. The rules underneath never spend. */
const layerOn = (config: WardenConfig, layer: keyof WardenConfig['layers']): boolean =>
  config.enabled && config.layers[layer];

const WARDEN_LAYER_WORDS: Readonly<Record<keyof WardenConfig['layers'], string>> = {
  jev: 'the Warden may now spend on Jev decisions',
  llm: 'the Warden may now spend on AI investigations',
};

const WARDEN_ACT_WORDS: Readonly<Record<keyof WardenConfig['mayActAlone'], string>> = {
  nudge: 'nudge a ferret',
  resume: 'resume a ferret',
  restart: 'restart a ferret',
  failover: 'move a ferret to another login',
  stop: 'stop a ferret',
  closeLeftovers: 'close a browser a finished ferret left running',
};

/** Jev's acts, in the words a person reads a lowered bar in. */
const JEV_ACT_WORDS: Readonly<Record<keyof WardenConfig['jevActs'], string>> = {
  nudge: 'nudge a ferret',
  resume: 'resume a ferret',
  restart: 'restart a ferret',
  stop: 'stop a ferret',
};

function wardenLoosening(before: WardenConfig, after: WardenConfig): readonly string[] {
  return [
    ...(Object.keys(WARDEN_LAYER_WORDS) as (keyof WardenConfig['layers'])[]).flatMap(layer =>
      switchedOn(layerOn(before, layer), layerOn(after, layer), WARDEN_LAYER_WORDS[layer]),
    ),
    ...(Object.keys(WARDEN_ACT_WORDS) as (keyof WardenConfig['mayActAlone'])[]).flatMap(act =>
      switchedOn(
        before.mayActAlone[act],
        after.mayActAlone[act],
        `the Warden may now ${WARDEN_ACT_WORDS[act]} on its own`,
      ),
    ),
    // A lower bar lets Jev act alone on less certainty: more of what it may do, so the owner confirms it.
    ...(Object.keys(JEV_ACT_WORDS) as (keyof WardenConfig['jevActs'])[]).flatMap(act =>
      lowered(before.jevActs[act], after.jevActs[act], `how sure Jev must be to ${JEV_ACT_WORDS[act]} on its own`),
    ),
    ...raised(before.caps.jevUsdPerDay, after.caps.jevUsdPerDay, 'the daily Jev cap in dollars'),
    ...raised(
      before.caps.investigationUsdPerDay,
      after.caps.investigationUsdPerDay,
      'the daily investigation cap in dollars',
    ),
    ...raised(
      before.caps.maxInvestigationsPerHour,
      after.caps.maxInvestigationsPerHour,
      'the investigations allowed per hour',
    ),
    ...lowered(
      before.guard.usdPerMillionInputTokens,
      after.guard.usdPerMillionInputTokens,
      'the Jev price the cap counts with',
    ),
    ...raised(before.maxAssignedWardens, after.maxAssignedWardens, 'the number of wardens that may run at once'),
    ...lowered(before.intervalMinutes, after.intervalMinutes, 'the minutes between Warden sweeps'),
    ...lowered(before.minSpawnGapMinutes, after.minSpawnGapMinutes, 'the minutes between two Warden investigations'),
    ...autoMigrateLoosening(before, after),
  ];
}

/** Moving a ferret acts only while the Warden is on AND moving is: the same reading as a layer's. */
const movesOn = (config: WardenConfig): boolean => config.enabled && config.autoMigrate.enabled;

const AUTO_MIGRATE_TRIGGER_WORDS: Readonly<Record<WardenConfig['autoMigrate']['when'][number], string>> = {
  rate_limited: 'whose login hit a usage limit',
  budget_exceeded: 'whose login passed its hard spend budget',
};

/**
 * Moving a ferret to another login destroys its pane and starts it again elsewhere, so everything that lets
 * the Warden do that in more cases waits for the owner: switching it on, letting it stop background jobs, a
 * new trigger, a login it may move onto, more moves an hour, a lower headroom floor. A login named where any ready one was allowed is
 * held too — a named login may be another provider's, which "any ready login" never reaches.
 */
function autoMigrateLoosening(before: WardenConfig, after: WardenConfig): readonly string[] {
  const was = before.autoMigrate;
  const now = after.autoMigrate;
  const named = now.targets.filter(target => !was.targets.includes(target));
  return [
    ...switchedOn(
      movesOn(before),
      movesOn(after),
      'the Warden may now move a ferret that hit a limit to another login on its own',
    ),
    ...switchedOn(
      movesOn(before) && was.forceStopBackground,
      movesOn(after) && now.forceStopBackground,
      "the Warden may now stop a ferret's own background jobs to move it",
    ),
    ...now.when
      .filter(trigger => !was.when.includes(trigger))
      .map(trigger => `the Warden now also moves a ferret ${AUTO_MIGRATE_TRIGGER_WORDS[trigger]}`),
    ...named.map(target => `the Warden may now move ferrets onto ${target}`),
    ...(was.targets.length > 0 && now.targets.length === 0
      ? ['the Warden may now move ferrets onto any ready login of the same harness and provider']
      : []),
    ...raised(was.maxMovesPerHour, now.maxMovesPerHour, 'the moves one ferret may get in an hour'),
    ...lowered(was.minHeadroomPercent, now.minHeadroomPercent, 'the share a login must have left to be moved onto'),
  ];
}

function learningLoosening(before: LearningConfig, after: LearningConfig): readonly string[] {
  return [
    ...switchedOn(before.enabled, after.enabled, 'lesson mining may now spend on agent sessions'),
    ...raised(before.maxMinersPerRun, after.maxMinersPerRun, 'the lesson miners one run may start'),
    ...raised(before.maxSessionsPerRun, after.maxSessionsPerRun, 'the sessions one lesson run may read'),
    ...raised(before.batchSize, after.batchSize, 'the sessions one lesson miner reads'),
    ...lowered(before.intervalMinutes, after.intervalMinutes, 'the minutes between lesson runs'),
    ...lowered(before.minSpawnGapMinutes, after.minSpawnGapMinutes, 'the minutes between two lesson miners'),
  ];
}

/**
 * Pack mode loosens when ferrets may start more sub-ferrets, or nest deeper, or when Jev may spend on
 * choosing their models. A probe spends a token or two per start, only when a ferret asks for one, and
 * a longer probe or cache spends nothing more, so neither is judged.
 */
function packLoosening(before: PackConfig, after: PackConfig): readonly string[] {
  const jevSpends = (config: PackConfig): boolean => config.enabled && config.decision === 'jev';
  return [
    ...switchedOn(before.enabled, after.enabled, 'ferrets may now start sub-ferrets (Pack mode)'),
    ...switchedOn(jevSpends(before), jevSpends(after), 'Jev may now spend on choosing sub-ferret models'),
    ...raised(
      before.limits.interactiveChildren,
      after.limits.interactiveChildren,
      'the sub-ferrets an interactive ferret may run at once',
    ),
    ...raised(
      before.limits.autoChildren,
      after.limits.autoChildren,
      'the sub-ferrets an unattended ferret may run at once',
    ),
    ...raised(before.limits.maxDepth, after.limits.maxDepth, 'how deep sub-ferrets may nest'),
    ...raised(before.jev.usdPerDay, after.jev.usdPerDay, "Jev's daily cap in dollars for choosing models"),
  ];
}

function voiceLoosening(before: VoiceConfig, after: VoiceConfig): readonly string[] {
  const from = before.postProcessing;
  const to = after.postProcessing;
  const destination = to.provider === 'login' ? `the login ${to.login ?? ''}`.trim() : to.provider;
  const sends = to.provider !== 'off' && to.style !== 'off';
  const wasSending = from.provider !== 'off' && from.style !== 'off';
  const moved = sends && (!wasSending || from.provider !== to.provider || from.login !== to.login);
  const context = to.useConversation && !from.useConversation && to.style !== 'off';
  return [
    ...(moved ? [`dictated text now goes to ${destination} to be cleaned up`] : []),
    ...(context ? ['recent conversation messages may now go to the cleanup provider to help clean up dictation'] : []),
  ];
}

/**
 * A login's budget loosens when a limit goes up or goes away — a period dropped, the whole `budget`, or the
 * login file itself (`after` absent): a login deleted and made again without a budget is a budget removed in
 * two steps, and while it is gone its running ferrets are neither metered nor stopped. Adding or lowering a
 * limit tightens, and a new login file loosens nothing — a login nobody had could spend nothing before.
 */
export function loginLoosening(
  id: string,
  before: Pick<Credential, 'budget'> | undefined,
  after: Pick<Credential, 'budget'> | undefined,
): readonly string[] {
  if (before === undefined) return [];
  if (after === undefined) return before.budget === undefined ? [] : loginLoosening(id, before, {});
  return BUDGET_PERIODS.flatMap(period =>
    (['trigger', 'hard'] as const).flatMap(level => {
      const was = before.budget?.[period]?.[level];
      const now = after.budget?.[period]?.[level];
      if (was === undefined) return [];
      const what = `login "${id}"'s ${period} ${level === 'hard' ? 'hard limit' : 'trigger'} in dollars`;
      return now === undefined ? [`${what} is removed (was ${String(was)})`] : raised(was, now, what);
    }),
  );
}

/**
 * A runtime loosens a budget when it leaves a budgeted login — re-pointed at another login, or deleted. A
 * budget counts the spend of the runtimes on its login and stops their ferrets, so moving one off it takes its
 * week of spend and its running ferrets out of the budget's reach. `budgeted` says whether a login had a
 * budget in effect before the edit.
 */
export function runtimeLoosening(
  name: string,
  before: Pick<Runtime, 'credential'> | undefined,
  after: Pick<Runtime, 'credential'> | undefined,
  budgeted: (login: string) => boolean,
): readonly string[] {
  if (before === undefined || !budgeted(before.credential) || after?.credential === before.credential) return [];
  return [
    after === undefined
      ? `runtime "${name}" is removed from login "${before.credential}", whose budget counts and stops it`
      : `runtime "${name}" moves off login "${before.credential}", whose budget counts and stops it, to "${after.credential}"`,
  ];
}

/**
 * Every line of `account-defaults.yaml` that is added, removed or changed is a sentence: a default decides which
 * account a card offers first, and the card says "Default for ferretry" in the owner's name, so the words must be the
 * owner's and not a ferret's. Nothing here is an exemption — taking a default away is held too.
 */
function accountDefaultsLoosening(before: AccountDefaultsFile, after: AccountDefaultsFile): readonly string[] {
  const address = (line: AccountDefaultLine): string => JSON.stringify([line.scope, line.within ?? null, line.key]);
  const was = new Map(accountDefaultLines(before).map(line => [address(line), line]));
  const now = new Map(accountDefaultLines(after).map(line => [address(line), line]));
  const sentences: string[] = [];
  for (const [where, line] of [...now, ...was]) {
    if (was.get(where)?.account === now.get(where)?.account) continue;
    const sentence = `changes which account a card offers first for ${line.key} in ${accountDefaultScopeWords(line)}`;
    if (!sentences.includes(sentence)) sentences.push(sentence);
  }
  return sentences;
}

/**
 * Each loosening an edit from `before` to `after` makes, in words; empty when it loosens nothing.
 * The singleton files have rules here, and a login's budget has its own (`loginLoosening`): any other
 * edit to a login, component, profile or runtime changes what an agent RUNS WITH, which every editor may
 * already change, not what it may spend or control.
 */
export function configLoosening<K extends SingletonKind>(
  kind: K,
  before: (typeof SINGLETON_DEFAULTS)[K],
  after: (typeof SINGLETON_DEFAULTS)[K],
): readonly string[] {
  switch (kind) {
    case 'machine':
      return machineLoosening(before as MachineFileValue, after as MachineFileValue);
    case 'warden':
      return wardenLoosening(before as WardenConfig, after as WardenConfig);
    case 'learning':
      return learningLoosening(before as LearningConfig, after as LearningConfig);
    case 'pack':
      return packLoosening(before as PackConfig, after as PackConfig);
    // The guide only says which model suits which work: it widens nothing a ferret may do or spend.
    case 'modelsGuide':
      return [];
    case 'accountDefaults':
      return accountDefaultsLoosening(before as AccountDefaultsFile, after as AccountDefaultsFile);
    default:
      return voiceLoosening(before as VoiceConfig, after as VoiceConfig);
  }
}

// ── Starters ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What a new file of each id begins with when somebody opens one that does not exist yet: the
 * smallest valid body with a comment that says where to read more. Never a secret value — the login
 * starter shows the `${secret:NAME}` reference, which is the only way a secret is ever written.
 */
export const CONFIG_FILE_STARTERS: Readonly<Record<ConfigSchemaId, string>> = {
  machine: '# This machine. Every setting is optional; see docs/config-files.md.\nagentPermissions: auto\n',
  login:
    '# A login. Secrets are never written here: run `fy secret set NAME`, then write ${secret:NAME}.\nharness: claude\nstore: environment\nenv:\n  ANTHROPIC_BASE_URL: https://api.example.com/anthropic\n  ANTHROPIC_AUTH_TOKEN: ${secret:EXAMPLE_API_KEY}\n',
  'component-instructions':
    '# Instructions: a document, relative to the fleet asset tree.\nfile: instructions/main.md\n',
  'component-mcp': '# One MCP server: a command to start, or a url to reach.\ncommand: npx\nargs: []\n',
  'component-skills': '# Skills from the skills store, each by its directory name.\nitems:\n  - my-skill\n',
  'component-settings':
    '# Harness settings: a file, launch flags, or environment.\nharness: claude\nenv:\n  DISABLE_TELEMETRY: "1"\n',
  'component-hooks':
    '# Hooks: a hooks document, or a directory of hook scripts.\nharness: claude\nfile: hooks/hooks.json\n',
  'component-modelSets':
    '# A model set: the models a runtime may use, and its default.\nmodels:\n  - model-id\ndefault: model-id\n',
  profile: '# A profile: its contents in order; a later entry overrides an earlier one.\ncontents: []\n',
  runtime:
    '# A runtime: one login and one profile, launched under this file name.\ncredential: my-login\nprofile: my-profile\nagent: true\n',
  warden:
    '# The Warden. Its rules flag trouble for free; the Jev and LLM layers each spend, under their own daily cap.\nenabled: true\nlayers:\n  jev: false\n  llm: false\n',
  learning: '# Lessons. Every setting is optional.\nenabled: true\n',
  pack: '# Pack mode: ferrets delegate to sub-ferrets (docs/pack-mode.md). Every setting is optional.\nenabled: true\ndecision: agent\n',
  modelsGuide:
    '# The routing prompt (docs/pack-mode.md): which model runs which kind of sub-task, in plain words.\n# Leave prompt out to use the one built from the model catalogs.\nprompt: |\n  Planning and review: claude-opus-5-5 at max. Everyday coding: claude-sonnet-5-5.\n  Chores and bulk edits: claude-haiku-5-5 at low. Prefer a login with quota left.\n',
  accountDefaults:
    '# Which account a sign-in card offers first. It only orders buttons: your tap is still the permission.\n# A change here waits for you to confirm it, so a ferret can suggest a default but never set one.\nsites:\n  github.com: MY_ACCOUNT\n',
  voice:
    '# Voice. Transcription is chosen on each device (Settings › Voice); this picks who cleans up the text.\npostProcessing:\n  provider: "off"\n',
  preset:
    '# A provider preset: a template for environment logins (docs/provider-presets.md). Secrets are named, never written.\nlabel: My gateway\nharness: claude\nsummary: Claude Code through my gateway.\ndocs: https://example.com/docs\nverified: "2026-01-01"\nenv:\n  ANTHROPIC_BASE_URL:\n    value: https://gateway.example.com\n  ANTHROPIC_AUTH_TOKEN:\n    secretName: GATEWAY_API_KEY\ntest:\n  kind: none\n  reason: no test yet\nquota:\n  source: transcript-pricing\n  note: counted from the transcript\n',
  models:
    '# A model catalog (docs/model-catalog.md): the models a login on this provider offers. This file wins over the published list.\nlabel: My gateway\ndocs: https://example.com/docs\nverified: "2026-01-01"\ncustomIds: true\nclaude:\n  models:\n    - id: my-model\n      label: My model\n      tier: balanced\n      default: true\n',
};
