import { z } from 'zod';
import { InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { type LearningConfig, LearningConfigSchema } from './learning.ts';
import {
  LegacyWardenTriageSchema,
  mergeWardenConfig,
  migrateLegacyWardenSettings,
  ProviderOutageConfigSchema,
  WardenAccountSchema,
  WardenCapsSchema,
  type WardenConfig,
  WardenEventTriggersSchema,
  WardenFailoverConfigSchema,
  WardenGuardConfigSchema,
  WardenInvestigationConfigSchema,
  WardenLayersSchema,
  WardenMayActAloneSchema,
  WardenSweepIntervalSchema,
} from './warden.ts';

/**
 * CONFIGURATION AS FILES — the layout of `$FY_HOME/config/`, the schemas of the files that are not the
 * fleet's own, and the wire every editor of those files speaks (docs/config-files.md).
 *
 * The files are the source of truth. The app, `fy`, and an agent holding the `config.*` tools are all
 * editors of them; the daemon watches the directory, validates each file, and keeps the last good
 * version of a file in effect while a newer one is invalid or waits for the owner's confirmation.
 *
 * SINGLE-SOURCED HERE because four packages must agree on where a file is and what kind it is: the
 * daemon (which reads and writes them), `fy` (which checks them without a daemon), the fleet library
 * (which turns them into the account model) and the app (which shows the backing file of a setting).
 * The fleet's own schemas stay in `@ferretry/fleet`; this module names only the layout and the three
 * files whose schemas are the daemon's — Warden, Learning and Voice.
 */

/** The directory under the state home that holds every configuration file. */
export const CONFIG_DIRECTORY_NAME = 'config' as const;

/** Where the JSON Schemas an editor validates against are written, inside the config directory. */
export const CONFIG_SCHEMA_DIRECTORY = '.schema' as const;

/**
 * The daemon's record of what it put into effect, file by file, in the state home's `state/`
 * directory. Named here because two programs read it: the daemon, which owns it, and `fy config
 * check`, which reads it to say what a file's last good version is without a daemon.
 */
export const CONFIG_ACCEPTED_FILE = 'config-accepted.json' as const;

/** The one extension a configuration file has. `.yml` is not read, and is reported as such. */
export const CONFIG_FILE_EXTENSION = '.yaml' as const;

/**
 * The six kinds of component, spelled exactly as a component directory and as the first half of a
 * profile's contents entry (`mcp/github`). `@ferretry/fleet` reads this list rather than keeping a copy.
 */
export const CONFIG_COMPONENT_KINDS = ['instructions', 'mcp', 'skills', 'settings', 'hooks', 'modelSets'] as const;
export const ConfigComponentKindSchema = z.enum(CONFIG_COMPONENT_KINDS);
export type ConfigComponentKind = z.infer<typeof ConfigComponentKindSchema>;

/** Every kind of configuration file. */
export const CONFIG_FILE_KINDS = [
  'machine',
  'login',
  'component',
  'profile',
  'runtime',
  'warden',
  'learning',
  'voice',
  'pack',
  'modelsGuide',
  'preset',
  'models',
] as const;
export const ConfigFileKindSchema = z.enum(CONFIG_FILE_KINDS);
export type ConfigFileKind = z.infer<typeof ConfigFileKindSchema>;

/** One file the directory can hold, by what it is rather than where. */
export type ConfigFileAddress =
  | { readonly kind: 'machine' | 'warden' | 'learning' | 'voice' | 'pack' | 'modelsGuide' }
  | { readonly kind: 'login' | 'profile' | 'runtime' | 'preset' | 'models'; readonly name: string }
  | { readonly kind: 'component'; readonly componentKind: ConfigComponentKind; readonly name: string };

/** The singleton files, by kind, and the directory each named kind lives in. */
const SINGLETON_FILES = {
  machine: 'machine.yaml',
  warden: 'warden.yaml',
  learning: 'learning.yaml',
  voice: 'voice.yaml',
  pack: 'pack.yaml',
  modelsGuide: 'models-guide.yaml',
} as const satisfies Record<string, string>;

const NAMED_DIRECTORIES = {
  login: 'logins',
  profile: 'profiles',
  runtime: 'runtimes',
  preset: 'presets',
  models: 'models',
} as const;

/** The directory components live under; each component kind is one directory below it. */
export const CONFIG_COMPONENTS_DIRECTORY = 'components' as const;

/**
 * A file name's stem as a configuration name: no separator, no leading dot (an editor's backup or
 * a hidden file), no traversal, no control character. Whether the NAME is valid for its kind — a
 * login id is stricter than a component name — is the fleet schema's question, answered with a
 * located error rather than by not reading the file.
 */
const usableStem = (stem: string): boolean =>
  stem.length > 0 &&
  stem.length <= 64 &&
  !stem.startsWith('.') &&
  !stem.includes('..') &&
  !/[/\\]/u.test(stem) &&
  ![...stem].some(character => (character.codePointAt(0) ?? 0) < 0x20);

/**
 * What a path relative to the config directory is, or `undefined` when Ferretry does not read it.
 * Total over every string, so a watcher holding any path it saw can ask.
 */
export function classifyConfigPath(relativePath: string): ConfigFileAddress | undefined {
  if (!relativePath.endsWith(CONFIG_FILE_EXTENSION)) return undefined;
  const parts = relativePath.slice(0, -CONFIG_FILE_EXTENSION.length).split('/');
  if (parts.length === 1) {
    const [stem] = parts as [string];
    const singleton = Object.entries(SINGLETON_FILES).find(([, file]) => file === `${stem}${CONFIG_FILE_EXTENSION}`);
    return singleton === undefined ? undefined : { kind: singleton[0] as keyof typeof SINGLETON_FILES };
  }
  if (parts.length === 2) {
    const [directory, stem] = parts as [string, string];
    const named = Object.entries(NAMED_DIRECTORIES).find(([, candidate]) => candidate === directory);
    if (named === undefined || !usableStem(stem)) return undefined;
    return { kind: named[0] as keyof typeof NAMED_DIRECTORIES, name: stem };
  }
  if (parts.length === 3) {
    const [directory, componentKind, stem] = parts as [string, string, string];
    const kind = ConfigComponentKindSchema.safeParse(componentKind);
    if (directory !== CONFIG_COMPONENTS_DIRECTORY || !kind.success || !usableStem(stem)) return undefined;
    return { kind: 'component', componentKind: kind.data, name: stem };
  }
  return undefined;
}

/** Where a file lives, relative to the config directory. The inverse of {@link classifyConfigPath}. */
export function configFilePath(address: ConfigFileAddress): string {
  switch (address.kind) {
    case 'machine':
    case 'warden':
    case 'learning':
    case 'voice':
    case 'pack':
    case 'modelsGuide':
      return SINGLETON_FILES[address.kind];
    case 'component':
      return `${CONFIG_COMPONENTS_DIRECTORY}/${address.componentKind}/${address.name}${CONFIG_FILE_EXTENSION}`;
    default:
      return `${NAMED_DIRECTORIES[address.kind]}/${address.name}${CONFIG_FILE_EXTENSION}`;
  }
}

/**
 * The JSON Schema a file is checked against, by id: one per singleton, one per named kind, and one
 * per component kind (`component-mcp`), because an MCP server and a hooks file share nothing.
 */
export const CONFIG_SCHEMA_IDS = [
  'machine',
  'login',
  ...CONFIG_COMPONENT_KINDS.map(kind => `component-${kind}` as const),
  'profile',
  'runtime',
  'warden',
  'learning',
  'voice',
  'pack',
  'modelsGuide',
  'preset',
  'models',
] as const;
export const ConfigSchemaIdSchema = z.enum(CONFIG_SCHEMA_IDS);
export type ConfigSchemaId = z.infer<typeof ConfigSchemaIdSchema>;

/** The schema id a file is validated against. */
export function configSchemaId(address: ConfigFileAddress): ConfigSchemaId {
  return address.kind === 'component' ? `component-${address.componentKind}` : address.kind;
}

/** The schema file an editor reads, relative to the config directory. */
export function configSchemaPath(id: ConfigSchemaId): string {
  return `${CONFIG_SCHEMA_DIRECTORY}/${id}.json`;
}

/**
 * The first line of every file Ferretry writes: the `yaml-language-server` modeline that points an
 * editor at the file's schema, written relative to the file so the directory can be moved whole.
 */
export function configSchemaModeline(address: ConfigFileAddress): string {
  const depth = configFilePath(address).split('/').length - 1;
  return `# yaml-language-server: $schema=${'../'.repeat(depth)}${configSchemaPath(configSchemaId(address))}`;
}

/**
 * The grant capability that governs writing a file. Warden settings are the `warden` capability's;
 * everything else — the machine, logins, components, profiles, runtimes, learning and voice — is how
 * this machine runs agents, which is `fleet`.
 */
export function configFileCapability(address: ConfigFileAddress): 'fleet' | 'warden' {
  return address.kind === 'warden' ? 'warden' : 'fleet';
}

// ── Warden ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The Warden settings a state home with no `warden.yaml` behaves as.
 *
 * ON, AND FREE: the sweep runs every two minutes and its rules flag what they find for the owner, but
 * both triage layers are off, so nothing is ever spent until the owner switches Jev or LLM investigation
 * on — each with its own daily cap (`docs/config-files.md`). Stop is never something an investigation may do alone by default.
 */
export const DEFAULT_WARDEN_CONFIG: WardenConfig = {
  enabled: true,
  layers: { jev: false, llm: false },
  guard: { threshold: 0.85, model: 'jev-latest', usdPerMillionInputTokens: 2 },
  caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 2, maxInvestigationsPerHour: 6 },
  mayActAlone: { nudge: true, resume: true, restart: true, failover: true, stop: false },
  events: { turnEnd: true, question: true, paneDied: true },
  investigation: { effort: 'low' },
  // None: the machine's default runtime, resolved when it is read. No login name is compiled in.
  accounts: [],
  failover: { policy: 'fallback', failureThreshold: 2, cooldownMinutes: 30 },
  providerOutage: { minDistinctSessions: 2, persistenceSweeps: 2, tailLines: 24 },
  intervalMinutes: 2,
  unattendedMinutes: 30,
  minSpawnGapMinutes: 15,
  susThinkingSeconds: 900,
  susSubprocessSeconds: 900,
  maxAssignedWardens: 1,
  assignedCooldownMinutes: 30,
  blessMinutes: 15,
};

/**
 * `warden.yaml` as written: every setting optional, the nested sections too, and an unknown key
 * refused. What a file leaves out is {@link DEFAULT_WARDEN_CONFIG}'s. A file from before the layers may
 * still say `triage`; it is read as the layers it meant, and the next write leaves it out.
 */
export const WardenFileSchema = z.strictObject({
  enabled: z.boolean().optional(),
  layers: WardenLayersSchema.strict().partial().optional(),
  /** DEPRECATED: the single choice `layers` replaced. Read as its layers; never written back. */
  triage: LegacyWardenTriageSchema.optional(),
  guard: WardenGuardConfigSchema.strict().partial().optional(),
  caps: WardenCapsSchema.strict().partial().optional(),
  mayActAlone: WardenMayActAloneSchema.strict().partial().optional(),
  events: WardenEventTriggersSchema.strict().partial().optional(),
  investigation: WardenInvestigationConfigSchema.strict().partial().optional(),
  accounts: z.array(WardenAccountSchema.strict()).optional(),
  failover: WardenFailoverConfigSchema.strict().partial().optional(),
  providerOutage: ProviderOutageConfigSchema.strict().partial().optional(),
  intervalMinutes: WardenSweepIntervalSchema.optional(),
  unattendedMinutes: PositiveIntegerSchema.optional(),
  minSpawnGapMinutes: NonNegativeIntegerSchema.optional(),
  susThinkingSeconds: PositiveIntegerSchema.optional(),
  susSubprocessSeconds: PositiveIntegerSchema.optional(),
  maxAssignedWardens: PositiveIntegerSchema.optional(),
  assignedCooldownMinutes: NonNegativeIntegerSchema.optional(),
  blessMinutes: NonNegativeIntegerSchema.optional(),
});
export type WardenFile = z.infer<typeof WardenFileSchema>;

/** The Warden settings a parsed `warden.yaml` means. */
export function wardenConfigFromFile(file: WardenFile): WardenConfig {
  return mergeWardenConfig(DEFAULT_WARDEN_CONFIG, migrateLegacyWardenSettings(file) as Omit<WardenFile, 'triage'>);
}

// ── Learning ─────────────────────────────────────────────────────────────────────────────────────

/** The learning schedule a state home with no `learning.yaml` behaves as. */
export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  enabled: true,
  agent: 'claude',
  intervalMinutes: 60,
  batchSize: 20,
  maxMinersPerRun: 2,
  maxSessionsPerRun: 40,
  minSpawnGapMinutes: 30,
  passiveDefault: true,
};

/** `learning.yaml` as written: every setting optional, an unknown key refused. */
export const LearningFileSchema = LearningConfigSchema.strict().partial();
export type LearningFile = z.infer<typeof LearningFileSchema>;

/** The learning settings a parsed `learning.yaml` means. */
export function learningConfigFromFile(file: LearningFile): LearningConfig {
  return LearningConfigSchema.parse({ ...DEFAULT_LEARNING_CONFIG, ...file });
}

// ── Voice ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Who cleans up a dictated transcript. Transcription itself is chosen on each device (Parakeet in the
 * browser, or the browser's own speech service — `docs/voice.md`) and is not configured here. Only the
 * transcript TEXT reaches the post-processor chosen here, never audio, and only when the owner dictates.
 */
export const VOICE_POST_PROCESSORS = ['off', 'groq', 'cerebras', 'login'] as const;
export const VoicePostProcessorSchema = z.enum(VOICE_POST_PROCESSORS);
export type VoicePostProcessor = z.infer<typeof VoicePostProcessorSchema>;

/** The speech engines a device can use: Parakeet in the browser, or the browser's/phone's own recognition. */
export const VOICE_ENGINES = ['parakeet', 'browser'] as const;
export const VoiceEngineSchema = z.enum(VOICE_ENGINES);
export type VoiceEngine = z.infer<typeof VoiceEngineSchema>;

/** What cleanup does: nothing, only fix transcription mistakes, or rewrite into clear sentences. */
export const VOICE_CLEANUP_STYLES = ['off', 'fix', 'polish'] as const;
export const VoiceCleanupStyleSchema = z.enum(VOICE_CLEANUP_STYLES);
export type VoiceCleanupStyle = z.infer<typeof VoiceCleanupStyleSchema>;

export const MAX_VOICE_PROMPT_CHARS = 2_000;

/** The prompts a person may rewrite. The daemon's fixed guard wraps whichever one runs and cannot be removed. */
export const VoiceCleanupPromptsSchema = z.strictObject({
  fix: z.string().trim().min(1).max(MAX_VOICE_PROMPT_CHARS).optional(),
  polish: z.string().trim().min(1).max(MAX_VOICE_PROMPT_CHARS).optional(),
});
export type VoiceCleanupPrompts = z.infer<typeof VoiceCleanupPromptsSchema>;

/** The shipped wording of each prompt; "Reset to default" in Settings writes nothing and falls back to these. */
export const DEFAULT_VOICE_CLEANUP_PROMPTS: Readonly<Record<Exclude<VoiceCleanupStyle, 'off'>, string>> = {
  fix: 'Fix transcription errors in the dictated text: misheard or misspelled words, punctuation and capitalization. Keep the speaker\u2019s own wording, order and meaning; do not rephrase.',
  polish:
    'Rewrite the dictated text into clear, well-formed sentences with correct spelling, punctuation and capitalization. Keep the same meaning and every fact; do not add, answer or explain anything.',
};

export const VoiceConfigSchema = z.strictObject({
  /**
   * The speech engine a device paired to this machine uses until that device picks its own (New machine
   * setup's Voice step writes it). Transcription always runs ON the device; this only names the default.
   */
  defaultEngine: VoiceEngineSchema.optional(),
  postProcessing: z
    .strictObject({
      provider: VoicePostProcessorSchema.default('off'),
      /** `provider: login` only: the login (credential id) whose model cleans up the text. */
      login: NonEmptyStringSchema.optional(),
      /** The model the provider runs; the provider's own default when unset. */
      model: NonEmptyStringSchema.optional(),
      /** What cleanup does to a take: nothing, fix mistakes only, or polish into clear sentences. */
      style: VoiceCleanupStyleSchema.default('fix'),
      /** Your own wording of a style's prompt; the shipped default when a style is not listed. */
      prompts: VoiceCleanupPromptsSchema.prefault({}),
      /** Send the last few messages of the session as read-only reference so names and terms are spelled right. */
      useConversation: z.boolean().default(false),
      /** How many of the latest messages that reference holds. */
      conversationMessages: z.number().int().min(1).max(10).default(8),
    })
    .check(ctx => {
      const value = ctx.value;
      if (value.provider === 'login' && value.login === undefined) {
        ctx.issues.push({
          code: 'custom',
          message: 'provider: login needs "login" — the login whose model cleans up the text',
          input: value,
          path: ['login'],
        });
      }
      if (value.provider !== 'login' && value.login !== undefined) {
        ctx.issues.push({
          code: 'custom',
          message: `"login" is only read with provider: login — this one is provider: ${value.provider}`,
          input: value.login,
          path: ['login'],
        });
      }
    })
    .prefault({}),
});
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

/** The voice settings a state home with no `voice.yaml` behaves as: no post-processing. */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = VoiceConfigSchema.parse({});

// ── The wire ─────────────────────────────────────────────────────────────────────────────────────

/** How bad an issue is: an `error` keeps the file's last good version in effect; a `warning` does not. */
export const ConfigIssueSeveritySchema = z.enum(['error', 'warning']);
export type ConfigIssueSeverity = z.infer<typeof ConfigIssueSeveritySchema>;

/**
 * One thing wrong with one file, located: the path relative to the config directory, the 1-based line
 * and column when the problem has a place, what is wrong, and the plain fix. Never the offending
 * value — a raw secret pasted into a file must not travel any further than the file.
 */
export const ConfigIssueSchema = z.strictObject({
  path: NonEmptyStringSchema,
  line: PositiveIntegerSchema.optional(),
  column: PositiveIntegerSchema.optional(),
  severity: ConfigIssueSeveritySchema,
  message: NonEmptyStringSchema,
  fix: NonEmptyStringSchema,
});
export type ConfigIssue = z.infer<typeof ConfigIssueSchema>;

/**
 * A file edit that LOOSENS what this machine may spend or what agents may do, held until the owner
 * confirms it at the machine (`fy config confirm`) or in the app with a passkey. The tighter version
 * stays in effect meanwhile. `etag` is the edit's digest: a confirmation names it, so confirming can
 * never apply a later edit nobody saw.
 */
export const ConfigPendingSchema = z.strictObject({
  path: NonEmptyStringSchema,
  etag: NonEmptyStringSchema,
  /** Each loosening, in words: "agents may now edit Ferretry settings". */
  changes: z.array(NonEmptyStringSchema).min(1),
});
export type ConfigPending = z.infer<typeof ConfigPendingSchema>;

/** Where a file stands: in effect as written, its last good version in effect, or waiting for a confirmation. */
export const ConfigFileStateSchema = z.enum(['ok', 'invalid', 'pending']);
export type ConfigFileState = z.infer<typeof ConfigFileStateSchema>;

export const ConfigFileSummarySchema = z.strictObject({
  path: NonEmptyStringSchema,
  kind: ConfigFileKindSchema,
  schema: ConfigSchemaIdSchema,
  state: ConfigFileStateSchema,
});
export type ConfigFileSummary = z.infer<typeof ConfigFileSummarySchema>;

/** `GET /v1/config/status`. */
export const ConfigStatusViewSchema = z.strictObject({
  /** The config directory, absolute, so "Open file path" names a real place on the machine. */
  directory: NonEmptyStringSchema,
  files: z.array(ConfigFileSummarySchema),
  issues: z.array(ConfigIssueSchema),
  pending: z.array(ConfigPendingSchema),
  checkedAt: InstantSchema,
});
export type ConfigStatusView = z.infer<typeof ConfigStatusViewSchema>;

/** The largest configuration file read or written over the wire. */
export const CONFIG_FILE_MAX_BYTES = 256 * 1024;

const ConfigTextSchema = z.string().refine(text => new TextEncoder().encode(text).length <= CONFIG_FILE_MAX_BYTES, {
  message: `a configuration file is at most ${String(CONFIG_FILE_MAX_BYTES / 1024)} KiB`,
});

/** A path relative to the config directory that names a file Ferretry reads. */
export const ConfigFilePathSchema = NonEmptyStringSchema.refine(path => classifyConfigPath(path) !== undefined, {
  message:
    'not a Ferretry configuration file — use machine.yaml, warden.yaml, learning.yaml, voice.yaml, logins/<id>.yaml, profiles/<name>.yaml, runtimes/<name>.yaml or components/<kind>/<name>.yaml',
});

/**
 * `GET /v1/config/file?path=`: one file as it is on disk. `etag` is its digest (`absent` when it does
 * not exist yet, and `text` is then the starter a new file of that kind begins with).
 */
export const ConfigFileViewSchema = z.strictObject({
  path: NonEmptyStringSchema,
  absolutePath: NonEmptyStringSchema,
  kind: ConfigFileKindSchema,
  schema: ConfigSchemaIdSchema,
  exists: z.boolean(),
  text: z.string(),
  etag: NonEmptyStringSchema,
  state: ConfigFileStateSchema,
  issues: z.array(ConfigIssueSchema),
});
export type ConfigFileView = z.infer<typeof ConfigFileViewSchema>;

/** The header `PUT /v1/config/file` reads the etag the edit was made against from. */
export const CONFIG_IF_MATCH_HEADER = 'if-match' as const;

/**
 * `PUT /v1/config/file`, with the etag the text was edited against in `If-Match`. Validated before
 * anything is written: an invalid file is refused with its located issues and the disk is untouched.
 */
export const ConfigFilePutRequestSchema = z.strictObject({
  path: ConfigFilePathSchema,
  text: ConfigTextSchema,
});
export type ConfigFilePutRequest = z.infer<typeof ConfigFilePutRequestSchema>;

/**
 * What a write did: `applied` (in effect now), or `pending` when it loosens something and the caller
 * could not confirm it in the same act — the file is written, and the tighter version stays in effect.
 */
export const ConfigFilePutResultSchema = z.strictObject({
  path: NonEmptyStringSchema,
  etag: NonEmptyStringSchema,
  outcome: z.enum(['applied', 'pending']),
  pending: ConfigPendingSchema.optional(),
});
export type ConfigFilePutResult = z.infer<typeof ConfigFilePutResultSchema>;

/** `POST /v1/config/confirm`: confirm ONE held edit, named by its path and the etag that was reviewed. */
export const ConfigConfirmRequestSchema = z.strictObject({
  path: ConfigFilePathSchema,
  etag: NonEmptyStringSchema,
});
export type ConfigConfirmRequest = z.infer<typeof ConfigConfirmRequestSchema>;

export const ConfigConfirmResultSchema = z.strictObject({
  path: NonEmptyStringSchema,
  confirmed: z.boolean(),
});
export type ConfigConfirmResult = z.infer<typeof ConfigConfirmResultSchema>;

/** A refusal's code when a file does not validate; the body carries the located issues. */
export const CONFIG_INVALID_CODE = 'config_invalid' as const;

/** The `422 config_invalid` body: the error envelope plus every located issue. */
export const ConfigInvalidBodySchema = z.looseObject({
  error: z.string(),
  code: z.literal(CONFIG_INVALID_CODE),
  issues: z.array(ConfigIssueSchema),
});
export type ConfigInvalidBody = z.infer<typeof ConfigInvalidBodySchema>;

// ── The agent's config tools ─────────────────────────────────────────────────────────────────────

/**
 * `POST /v1/agent/config` — the `config.*` tools an agent reaches through the Ferretry tools MCP
 * server. Governed by the machine's "What agents may control › Ferretry settings" switch (off by
 * default), and by the loosening rule like every other editor: an agent's write that loosens is held
 * until the owner confirms it.
 *
 * - `config.read` without a path lists the files and their issues; with one it returns the file.
 * - `config.validate` checks a text as if it were written, writing nothing.
 * - `config.write` writes a text, refused unless it validates; `etag` guards against a lost update.
 */
export const AgentConfigToolCallSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('config.read'), path: ConfigFilePathSchema.optional() }),
  z.strictObject({ tool: z.literal('config.validate'), path: ConfigFilePathSchema, text: ConfigTextSchema }),
  z.strictObject({
    tool: z.literal('config.write'),
    path: ConfigFilePathSchema,
    text: ConfigTextSchema,
    etag: NonEmptyStringSchema.optional(),
  }),
]);
export type AgentConfigToolCall = z.infer<typeof AgentConfigToolCallSchema>;
export type AgentConfigToolName = AgentConfigToolCall['tool'];

/** What a config tool answers: a sentence an agent can act on, and the file or the issues behind it. */
export const AgentConfigToolResultSchema = z.strictObject({
  summary: NonEmptyStringSchema,
  text: z.string().optional(),
  etag: NonEmptyStringSchema.optional(),
  issues: z.array(ConfigIssueSchema).optional(),
  files: z.array(ConfigFileSummarySchema).optional(),
});
export type AgentConfigToolResult = z.infer<typeof AgentConfigToolResultSchema>;
