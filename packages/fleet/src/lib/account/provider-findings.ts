/**
 * Which model provider each CLI on this machine is set up for (docs/provider-presets.md § Detect,
 * "From this machine's own setup"), read where the CLI itself reads it, and the environment login
 * that provider becomes on import.
 *
 * WHERE EACH CLI TAKES ITS PROVIDER FROM, in the order it applies them:
 *
 * | | Claude Code | Codex |
 * | --- | --- | --- |
 * | 1 | `settings.json` `env` (applied over the process environment) | `config.toml` `model_provider` and its `[model_providers.<id>]` table |
 * | 2 | the login shell's environment | the login shell (the key the table's `env_key` names, `OPENAI_*`) |
 * | 3 | the sign-in, used only when nothing above switches it | `auth.json`, the same |
 *
 * A finding is made only when the CLI would really USE a provider: a `CLAUDE_CODE_USE_*` switch that is
 * on, an `ANTHROPIC_BASE_URL`, an `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` for Claude Code; an
 * active `model_provider` table, an `OPENAI_API_KEY` or `OPENAI_BASE_URL` for Codex. A shell that merely
 * HAS an `AWS_PROFILE` or an `OPENROUTER_API_KEY` is not a Claude Code on Bedrock or OpenRouter.
 *
 * Which provider it is, is the presets' own `detect:` table through {@link detectProvider} — no second
 * table — narrowed to the presets the CLI's state allows: a switch that is on admits only the presets
 * that set it, and a base URL on a host the winner does not declare is a custom gateway.
 *
 * VALUES STAY IN {@link ProviderFinding.values}. Everything else a finding holds is a NAME, a preset's
 * own words, or a plain fact: a value the preset declares PLAIN that {@link looksSecret} does not
 * claim, a URL only as its host, a profile only as its name. {@link providerFindingView} is the only
 * projection that leaves the daemon, and it has no field a value could ride in.
 *
 * Pure and total.
 */
import { MIN_SECRET_VALUE_LENGTH, secretReference } from '@ferretry/protocol';
import type { HarnessKind } from '../manifest.ts';
import { type DetectablePreset, detectProvider } from '../presets/detect.ts';
import { credentialFromPreset, type PresetLoginInput, presetLoginRefusal } from '../presets/login.ts';
import { type PresetVariable, type ProviderPreset, presetHarnesses } from '../presets/schema.ts';
import type { SettingsObject } from '../settings.ts';
import { parseCloudCredential } from './environment.ts';
import type { Credential } from './schema.ts';
import { looksSecret } from './secret-values.ts';

// ── What is read ─────────────────────────────────────────────────────────────────────────────────

/**
 * The login shell's environment, already narrowed to the names {@link shellVariableFilter} keeps, or
 * why it could not be read. An unavailable shell is never a failure of the scan: detection goes on
 * from the settings files alone, and the result says the shell was not read.
 */
export type ShellEnvironmentReading =
  | { readonly state: 'read'; readonly env: Readonly<Record<string, string>> }
  | { readonly state: 'unavailable'; readonly cause: 'timed-out' | 'failed' };

/** Codex's active provider table in `config.toml`: `model_provider = "<id>"` and `[model_providers.<id>]`. */
export interface CodexConfigProvider {
  readonly id: string;
  /** `base_url`, as written. A value: never leaves this module except as its host. */
  readonly baseUrl?: string;
  /** `env_key`: the NAME of the shell variable Codex sends as the key. */
  readonly envKey?: string;
}

/** Where the deciding clues came from, as the Found row says it. */
export type ProviderSource = 'settings.json' | 'shell' | 'settings.json+shell' | 'config.toml' | 'config.toml+shell';

/** One plain fact the Found row may show: never a secret, a URL only as its host. */
export interface ProviderFact {
  readonly name: string;
  readonly value: string;
}

/** One provider a CLI is set up for. */
export interface ProviderFinding {
  readonly harness: HarnessKind;
  readonly preset: ProviderPreset;
  readonly source: ProviderSource;
  /** The variables that pointed at the preset, by NAME. */
  readonly clues: readonly string[];
  readonly facts: readonly ProviderFact[];
  /** The variables whose values become secrets, by NAME. */
  readonly secrets: readonly string[];
  /**
   * NAME → value as the CLI would read it: the login's material. THE ONLY FIELD WITH VALUES. Never in a
   * view, a sentence, a note or a log.
   */
  readonly values: Readonly<Record<string, string>>;
  /** A cloud credential REFERENCE (`aws-profile:work`, `gcloud-adc`), never what it points at. */
  readonly cloudCredential?: string;
  /** The `settings.json` `env` names the login takes over, so the shared settings no longer switch every runtime. */
  readonly fromSettings: readonly string[];
  /** The `config.toml` provider table the login takes over, so the shared settings no longer switch every runtime. */
  readonly codexConfigProvider?: string;
}

/** What may leave the daemon about a finding. No field can hold a value of a secret. */
export interface ProviderFindingView {
  readonly preset: string;
  readonly label: string;
  readonly source: ProviderSource;
  readonly clues: readonly string[];
  readonly facts: readonly ProviderFact[];
  readonly secrets: readonly string[];
}

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/** An environment variable name, as both CLIs and the secret store accept one. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A Codex provider table id that can be reported as part of a clue name. */
const TABLE_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/** A variable that turns Claude Code onto a provider (`CLAUDE_CODE_USE_BEDROCK=1`). */
const SWITCH_NAME = /^CLAUDE_CODE_USE_[A-Z0-9_]+$/u;

/** The names a CLI reads its provider identity from, by the CLI's own prefix. */
const HARNESS_PREFIX: Readonly<Record<HarnessKind, RegExp>> = {
  claude: /^(?:ANTHROPIC_|CLAUDE_CODE_|CLAUDE_)/u,
  codex: /^(?:OPENAI_|CODEX_|AZURE_OPENAI_)/u,
};

/** An address or a key, by the shape of its name. Only ever tested on a harness-prefixed name. */
const URL_OR_KEY_NAME = /(?:BASE_URL|_ENDPOINT|_API_BASE|KEY|TOKEN|SECRET)$/u;

/** Claude Code's own provider-identity variables: the ones a sign-in runtime must not inherit. */
const CLAUDE_IDENTITY = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

/** The variables that pin which model Claude Code asks for: the main one, the small one and the three tiers. */
const MODEL_PIN_NAME = /^ANTHROPIC_(?:MODEL|SMALL_FAST_MODEL|DEFAULT_(?:OPUS|SONNET|HAIKU)_MODEL)$/u;

/**
 * A model id the Anthropic API itself serves: `claude-sonnet-5-5`, a dated one, or an alias (`sonnet`,
 * `opus[1m]`). Anything else — Bedrock's `us.anthropic.claude-…-v1:0` and ARNs, Vertex's `claude-…@2025…`, a
 * gateway's own names — means nothing to a sign-in's Anthropic endpoint.
 */
const PLAIN_ANTHROPIC_MODEL = /^(?:claude-[a-z0-9][a-z0-9.-]*|sonnet|opus|haiku|opusplan|best)(?:\[1m\])?$/iu;

/**
 * A model pin that only the provider can serve. It moves with the provider's login: left in the shared
 * `settings.json`, the sign-in runtime would be asked for a model id its endpoint does not know.
 */
const providerOnlyModelPin = (name: string, value: string | undefined): boolean =>
  MODEL_PIN_NAME.test(name) && value !== undefined && value.trim() !== '' && !PLAIN_ANTHROPIC_MODEL.test(value.trim());

/** The preset a base URL that no preset claims is: Claude Code through any Anthropic-compatible gateway. */
export const CUSTOM_GATEWAY_PRESET = 'custom-gateway';

const usable = (preset: ProviderPreset, harness: HarnessKind): boolean => presetHarnesses(preset).includes(harness);

/** The variables a preset's half for `harness` declares. */
const halfVariables = (preset: ProviderPreset, harness: HarnessKind): Readonly<Record<string, PresetVariable>> =>
  preset.halves[harness]?.env ?? {};

/**
 * Which login-shell variables are worth keeping long enough to detect from: a name a preset's half
 * declares or a single name a preset detects by, the switch shape, the address and key shapes of a
 * name that speaks to one of the CLIs, and the names `extra` adds (a Codex table's `env_key`).
 * Everything else is dropped by the reader the moment it is parsed, unread.
 *
 * Narrower on purpose than "anything named like a key": a `GITHUB_TOKEN`, or an `OPENROUTER_API_KEY`
 * neither CLI is pointed at, cannot tell which provider a CLI uses, so it is never held even for a moment.
 */
export function shellVariableFilter(
  presets: readonly ProviderPreset[],
  extra: readonly string[] = [],
): (name: string) => boolean {
  const exact = new Set<string>(extra);
  for (const preset of presets) {
    for (const pattern of preset.detect.variables) if (!pattern.endsWith('*')) exact.add(pattern);
    for (const harness of presetHarnesses(preset)) {
      for (const name of Object.keys(halfVariables(preset, harness))) exact.add(name);
    }
  }
  return name =>
    VARIABLE_NAME.test(name) &&
    (exact.has(name) ||
      SWITCH_NAME.test(name) ||
      ((HARNESS_PREFIX.claude.test(name) || HARNESS_PREFIX.codex.test(name)) && URL_OR_KEY_NAME.test(name)));
}

/**
 * Codex's active provider table, when `config.toml` names one; `openai` is Codex's own and is no provider.
 * A table whose id is not a plain word is named but never read: it could not be reported as a clue.
 */
export function codexConfigProvider(config: SettingsObject | undefined): CodexConfigProvider | undefined {
  const id = config?.model_provider;
  if (typeof id !== 'string' || id === '' || id === 'openai') return undefined;
  const tables = config?.model_providers;
  const table =
    typeof tables === 'object' && tables !== null && !Array.isArray(tables)
      ? (tables as Readonly<Record<string, unknown>>)[id]
      : undefined;
  if (typeof table !== 'object' || table === null || Array.isArray(table) || !TABLE_ID.test(id)) return { id };
  const { base_url: baseUrl, env_key: envKey } = table as Readonly<Record<string, unknown>>;
  return {
    id,
    ...(typeof baseUrl === 'string' && baseUrl !== '' ? { baseUrl } : {}),
    ...(typeof envKey === 'string' && VARIABLE_NAME.test(envKey) ? { envKey } : {}),
  };
}

// ── Values ───────────────────────────────────────────────────────────────────────────────────────

/** Whether a switch is on as the CLI reads one: set, and not `0` or `false`. */
const switchOn = (value: string | undefined): boolean =>
  value !== undefined && value.trim() !== '' && !/^(?:0|false|no|off)$/iu.test(value.trim());

const set = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';

/** The host of an `http(s)://` value, or `undefined`. Never the user, password, path or query. */
function hostOf(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** A URL that carries a user or a password: a credential, however plain its variable looks. */
function urlCarriesCredentials(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.username !== '' || url.password !== '';
  } catch {
    return false;
  }
}

/** Whether a found value must go to the secret store rather than sit in a login file as text. */
const secretValue = (name: string, value: string, declared: PresetVariable | undefined): boolean =>
  declared?.secretName !== undefined || looksSecret(name, value) || urlCarriesCredentials(value);

/**
 * The first variable the preset keeps as a secret whose value is shorter than the secret store accepts
 * (`MIN_SECRET_VALUE_LENGTH`) — LiteLLM's `sk-1234`, Ollama's `dummy`. A value that short cannot be masked out
 * of output safely, so the store refuses it, and a login file may not hold it as text either; the import
 * is refused by NAME, never showing the value, and the person adds that login by hand like any other.
 */
const tooShortToStore = (
  finding: ProviderFinding,
  declared: Readonly<Record<string, PresetVariable>>,
): string | undefined =>
  Object.entries(finding.values).find(
    ([name, value]) =>
      value !== '' && declared[name]?.secretName !== undefined && value.length < MIN_SECRET_VALUE_LENGTH,
  )?.[0];

/** The longest plain fact shown; a longer value is left out rather than cut. */
const MAX_FACT_LENGTH = 200;

// ── Detection ────────────────────────────────────────────────────────────────────────────────────

const tableOf = (presets: readonly ProviderPreset[]): readonly DetectablePreset[] =>
  presets.map(preset => ({ id: preset.id, detect: preset.detect }));

/** What one CLI's sources say, NAME → value, the later source winning, and which source each name came from. */
interface Layered {
  readonly env: Readonly<Record<string, string>>;
  readonly from: Readonly<Record<string, 'settings' | 'shell' | 'config'>>;
}

function layer(sources: readonly (readonly [Layered['from'][string], Readonly<Record<string, string>>])[]): Layered {
  const env: Record<string, string> = {};
  const from: Record<string, Layered['from'][string]> = {};
  for (const [source, values] of sources) {
    for (const [name, value] of Object.entries(values)) {
      env[name] = value;
      from[name] = source;
    }
  }
  return { env, from };
}

function sourceOf(names: readonly string[], from: Layered['from'], harness: HarnessKind): ProviderSource {
  const kinds = new Set(names.map(name => from[name]).filter(kind => kind !== undefined));
  const file = harness === 'claude' ? 'settings' : 'config';
  const fileName = harness === 'claude' ? 'settings.json' : 'config.toml';
  if (kinds.has(file) && kinds.has('shell')) return `${fileName}+shell` as ProviderSource;
  if (kinds.has(file)) return fileName as ProviderSource;
  return 'shell';
}

/** The winner, unless a base URL on a host it does not declare says the requests go somewhere else. */
function detected(
  presets: readonly ProviderPreset[],
  env: Readonly<Record<string, string>>,
  baseUrlVariable: string,
): { readonly preset: ProviderPreset; readonly clues: readonly string[] } | 'elsewhere' | undefined {
  const detection = detectProvider(tableOf(presets), env);
  const winner = presets.find(preset => preset.id === detection.preset);
  const pointed = set(env[baseUrlVariable]);
  if (winner === undefined) return pointed ? 'elsewhere' : undefined;
  const byHost = detection.clues.some(clue => clue.kind === 'host');
  if (pointed && !byHost && winner.detect.hosts.length > 0) return 'elsewhere';
  return { preset: winner, clues: [...new Set(detection.clues.map(clue => clue.variable))] };
}

/**
 * The variables of `env` the CLI itself reads its provider from: its own prefix, a name a usable
 * preset's half for it declares, or a single name a preset detects by (`AWS_PROFILE`). A detect FAMILY
 * (`OPENROUTER_*`) is left out: Claude Code never reads an `OPENROUTER_API_KEY` that a shell keeps for
 * something else, so it must not tip which provider Claude Code is on.
 */
function relevant(
  presets: readonly ProviderPreset[],
  harness: HarnessKind,
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const declared = new Set<string>();
  for (const preset of presets) {
    for (const name of Object.keys(halfVariables(preset, harness))) declared.add(name);
    for (const pattern of preset.detect.variables) if (!pattern.endsWith('*')) declared.add(pattern);
  }
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => VARIABLE_NAME.test(name) && (HARNESS_PREFIX[harness].test(name) || declared.has(name)),
    ),
  );
}

/** What Claude Code is set up for, from its `settings.json` `env` over the login shell. */
function claudeFinding(
  presets: readonly ProviderPreset[],
  settingsEnv: Readonly<Record<string, string>>,
  shell: Readonly<Record<string, string>>,
): ProviderFinding | undefined {
  const own = presets.filter(preset => usable(preset, 'claude'));
  const layered = layer([
    ['shell', relevant(own, 'claude', shell)],
    ['settings', relevant(own, 'claude', settingsEnv)],
  ]);
  const { env } = layered;
  const switches = Object.keys(env).filter(name => SWITCH_NAME.test(name) && switchOn(env[name]));
  const declaresSwitch = (preset: ProviderPreset): boolean =>
    Object.keys(halfVariables(preset, 'claude')).some(name => SWITCH_NAME.test(name));
  let candidates: readonly ProviderPreset[];
  if (switches.length > 0) {
    // A switch decides the provider family, whatever else is set: only the presets that set one that is on.
    candidates = own.filter(preset => switches.some(name => halfVariables(preset, 'claude')[name] !== undefined));
  } else if (CLAUDE_IDENTITY.some(name => set(env[name]))) {
    candidates = own.filter(preset => !declaresSwitch(preset));
  } else {
    return undefined;
  }
  const pick = detected(candidates, env, 'ANTHROPIC_BASE_URL');
  let preset: ProviderPreset;
  let clues: readonly string[];
  if (pick === undefined) return undefined;
  if (pick === 'elsewhere') {
    const gateway = own.find(each => each.id === CUSTOM_GATEWAY_PRESET);
    if (gateway === undefined || switches.length > 0) return undefined;
    preset = gateway;
    clues = ['ANTHROPIC_BASE_URL', ...(set(env.ANTHROPIC_AUTH_TOKEN) ? ['ANTHROPIC_AUTH_TOKEN'] : [])];
  } else {
    ({ preset, clues } = pick);
  }
  const declared = halfVariables(preset, 'claude');
  const takes = (name: string): boolean =>
    declared[name] !== undefined ||
    clues.includes(name) ||
    SWITCH_NAME.test(name) ||
    (CLAUDE_IDENTITY as readonly string[]).includes(name) ||
    providerOnlyModelPin(name, settingsEnv[name]);
  const fromSettings = Object.keys(settingsEnv).filter(takes);
  return finish({ harness: 'claude', preset, clues, layered, fromSettings });
}

/** What Codex is set up for, from its `config.toml` provider table and the login shell. */
function codexFinding(
  presets: readonly ProviderPreset[],
  config: CodexConfigProvider | undefined,
  shell: Readonly<Record<string, string>>,
): ProviderFinding | undefined {
  const own = presets.filter(preset => usable(preset, 'codex'));
  if (config?.baseUrl !== undefined) {
    const urlName = `model_providers.${config.id}.base_url`;
    const key = config.envKey === undefined ? undefined : shell[config.envKey];
    const layered = layer([
      ['config', { [urlName]: config.baseUrl }],
      ['shell', config.envKey !== undefined && set(key) ? { [config.envKey]: key } : {}],
    ]);
    // A provider table is recognised by where it sends the requests, and by nothing else.
    const detection = detectProvider(tableOf(own), { [urlName]: config.baseUrl });
    const preset = own.find(each => each.id === detection.preset);
    if (preset === undefined) return undefined;
    return finish({
      harness: 'codex',
      preset,
      clues: [urlName, ...(config.envKey !== undefined && set(key) ? [config.envKey] : [])],
      layered,
      fromSettings: [],
      codexConfigProvider: config.id,
      ...(config.envKey === undefined ? {} : { envKey: config.envKey }),
    });
  }
  if (config !== undefined) return undefined;
  const env = relevant(own, 'codex', shell);
  if (!set(env.OPENAI_API_KEY) && !set(env.OPENAI_BASE_URL)) return undefined;
  const pick = detected(own, env, 'OPENAI_BASE_URL');
  if (pick === undefined || pick === 'elsewhere') return undefined;
  return finish({
    harness: 'codex',
    preset: pick.preset,
    clues: pick.clues,
    layered: layer([['shell', env]]),
    fromSettings: [],
  });
}

/** The finding's material, facts and names, once the preset is known. */
function finish(input: {
  readonly harness: HarnessKind;
  readonly preset: ProviderPreset;
  readonly clues: readonly string[];
  readonly layered: Layered;
  readonly fromSettings: readonly string[];
  readonly codexConfigProvider?: string;
  /** A Codex table's `env_key`: the variable whose value is the key the preset's own key variable carries. */
  readonly envKey?: string;
}): ProviderFinding {
  const { harness, preset, layered } = input;
  const { env } = layered;
  const declared = halfVariables(preset, harness);
  const keyVariable = preset.halves[harness]?.codexProvider?.keyVariable;
  const values: Record<string, string> = {};
  for (const name of Object.keys(declared)) {
    const found = name === keyVariable && input.envKey !== undefined ? env[input.envKey] : env[name];
    if (found !== undefined) values[name] = found;
  }
  // What the login takes over from settings.json and does not declare is kept on it, not lost.
  for (const name of input.fromSettings) {
    if (values[name] === undefined && env[name] !== undefined) values[name] = env[name];
  }

  const awsProfile = env.AWS_PROFILE;
  const kinds = preset.cloudCredential?.kinds ?? [];
  const profile = set(awsProfile) ? `aws-profile:${awsProfile.trim()}` : undefined;
  const named =
    kinds.includes('aws-profile') && profile !== undefined && parseCloudCredential(profile) !== undefined
      ? profile
      : undefined;
  const cloudCredential = named ?? preset.cloudCredential?.suggested;
  delete values.AWS_PROFILE;

  const secrets: string[] = [];
  const facts: ProviderFact[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === '') continue;
    if (secretValue(name, value, declared[name])) {
      secrets.push(name);
      continue;
    }
    if (declared[name] === undefined || SWITCH_NAME.test(name)) continue;
    const host = hostOf(value);
    const shown = host ?? (/^[a-z][a-z0-9+.-]*:/iu.test(value) ? undefined : value.trim());
    if (shown !== undefined && shown !== '' && shown.length <= MAX_FACT_LENGTH) facts.push({ name, value: shown });
  }
  if (named !== undefined && !looksSecret('AWS_PROFILE', awsProfile as string)) {
    facts.push({ name: 'AWS_PROFILE', value: (awsProfile as string).trim() });
  }
  // A Codex table's address is a fact too, as its host.
  for (const name of input.clues) {
    if (!name.startsWith('model_providers.')) continue;
    const host = env[name] === undefined ? undefined : hostOf(env[name]);
    if (host !== undefined) facts.push({ name, value: host });
  }
  return {
    harness,
    preset,
    source: sourceOf(input.clues, layered.from, harness),
    clues: input.clues,
    facts,
    secrets,
    values,
    ...(cloudCredential === undefined ? {} : { cloudCredential }),
    fromSettings: input.fromSettings,
    ...(input.codexConfigProvider === undefined ? {} : { codexConfigProvider: input.codexConfigProvider }),
  };
}

/**
 * The provider `harness` is set up for, or `undefined` when it uses its own sign-in. `settingsEnv` is
 * Claude Code's `settings.json` `env` (text values only); `codexConfig` is Codex's active provider
 * table; `shell` is the filtered login shell, `{}` when it could not be read.
 */
export function findProvider(input: {
  readonly harness: HarnessKind;
  readonly presets: readonly ProviderPreset[];
  readonly shell: Readonly<Record<string, string>>;
  readonly settingsEnv?: Readonly<Record<string, string>>;
  readonly codexConfig?: CodexConfigProvider;
}): ProviderFinding | undefined {
  const presets = input.presets.filter(preset => preset.unavailable === undefined);
  return input.harness === 'claude'
    ? claudeFinding(presets, input.settingsEnv ?? {}, input.shell)
    : codexFinding(presets, input.codexConfig, input.shell);
}

/** What may leave the daemon about a finding: names, the preset's words and plain facts. */
export function providerFindingView(finding: ProviderFinding): ProviderFindingView {
  return {
    preset: finding.preset.id,
    label: finding.preset.label,
    source: finding.source,
    clues: [...finding.clues],
    facts: finding.facts.map(fact => ({ name: fact.name, value: fact.value })),
    secrets: [...finding.secrets],
  };
}

// ── The login ────────────────────────────────────────────────────────────────────────────────────

/**
 * The environment login a finding becomes — what `fy login add --from-env` makes: `store: environment`,
 * the preset, plain values as found, each secret as a `${secret:NAME}` reference and its cloud
 * credential as a reference. `claim` stores a value under a name derived from the one given and returns
 * the name it got; it is called only once the login is known to be valid, so a refused finding claims
 * nothing.
 */
export function providerCredential(
  finding: ProviderFinding,
  claim: (name: string, value: string) => string,
): { readonly credential: Credential } | { readonly refusal: string } {
  const { preset, harness } = finding;
  const declared = halfVariables(preset, harness);
  const envWith = (secret: (name: string, value: string) => string): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [name, variable] of Object.entries(declared)) {
      const value = finding.values[name];
      if (value === undefined || value === '') {
        if (variable.secretName === undefined) env[name] = variable.value ?? '';
        continue;
      }
      env[name] = secretValue(name, value, variable)
        ? secretReference(secret(variable.secretName ?? name, value))
        : value;
    }
    for (const [name, value] of Object.entries(finding.values)) {
      if (declared[name] !== undefined || value === '') continue;
      env[name] = secretValue(name, value, undefined) ? secretReference(secret(name, value)) : value;
    }
    return env;
  };
  const short = tooShortToStore(finding, declared);
  if (short !== undefined) {
    return {
      refusal: `${short} is shorter than the ${String(MIN_SECRET_VALUE_LENGTH)} characters Ferretry's secret store takes (a value that short cannot be masked out of output safely)`,
    };
  }
  const input = (env: Record<string, string>): PresetLoginInput => ({
    env,
    harness,
    halves: [harness],
    ...(finding.cloudCredential === undefined ? {} : { cloudCredential: finding.cloudCredential }),
  });
  const refusal = presetLoginRefusal(preset, input(envWith(name => name)));
  if (refusal !== undefined) return { refusal };
  return { credential: credentialFromPreset(preset, input(envWith(claim))) };
}
