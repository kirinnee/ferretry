/**
 * The version-2 fleet configuration — Machine, Credential, Component, Profile, Runtime — as the one
 * place an untrusted version-2 document becomes a domain type.
 *
 * The words are the product's words (docs/design/account-model.md §2) and nothing else: there is no
 * agent, route, variant, identity, home or lane here. Everything a later unit needs to reason about
 * the model — flattening a profile, materialising a runtime, adapting a component — reads these types,
 * so they say exactly what the design's §5.3 says and no more.
 *
 * WHAT IS NOT HERE, on purpose:
 *
 * - **No runtime id.** Ids are opaque and live in Ferretry's state (`ids.json`, R6), so renaming a
 *   runtime in the config can never break a join.
 * - **No wrapper or config-directory path.** Both are derived from the runtime's name and id.
 * - **No `flags` or `env` on a runtime or profile.** Settings is where flags and environment live
 *   (K4); the only environment in the config outside a component is a credential's, and only when
 *   that credential IS an environment (`store: environment`).
 *
 * Every rule that spans two fields is checked by one parse and named in a sentence that says which
 * field it is about, in the style of `../config.ts`: a person who typed a layer that does not exist
 * is told which profile, which layer and what exists instead.
 *
 * Pure throughout: no filesystem, no environment, no clock.
 */
import { BrowserModeSchema, CONFIG_COMPONENT_KINDS, isLoopbackHost, SECRET_REFERENCE_SOURCE } from '@ferretry/protocol';
import { z } from 'zod';
import { AliasSchema, EnvSchema, SafeNameSchema, UsageSchema } from '../config.ts';
import { HarnessKindSchema } from '../manifest.ts';
import {
  CloudCredentialSchema,
  CodexProviderSchema,
  cloudCredentialVariable,
  parseCloudCredential,
  templatePlaceholders,
} from './environment.ts';
import {
  credentialCodexProvider,
  credentialHalves,
  credentialHarnesses,
  credentialVariables,
  hasHalves,
} from './halves.ts';

/** A URL a bearer token may be sent to: HTTPS, or plain HTTP only to this machine. */
const secureMcpUrl = (url: string): boolean => {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname));
};

const NonEmptyString = z.string().min(1);

/** The version this module parses. Any other document is refused (`./document.ts`). */
export const ACCOUNT_MODEL_VERSION = 2 as const;

const NAME_GRAMMAR = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

const nameSchema = () =>
  z.string().max(64).regex(NAME_GRAMMAR, {
    message: 'use only letters, digits and dashes, starting and ending with a letter or digit',
  });

/**
 * A runtime's name (R1): letters, digits and dashes, and no dash at either end. It is the CLI wrapper
 * a person types, so it must survive being a filename and a shell word without quoting.
 *
 * A credential id uses the same grammar, because it is the directory name of a `store: ferretry`
 * credential (`<FY_HOME>/fleet/credentials/<id>/`).
 */
export const RuntimeNameSchema = nameSchema();

/** A credential's id. The same grammar as a runtime name; see {@link RuntimeNameSchema}. */
export const CredentialIdSchema = nameSchema();

/**
 * A record whose KEYS are names, each checked with a sentence that says what is wrong with it.
 *
 * A record key schema reports only "Invalid key in record", so a person who typed `claude.work` as a
 * runtime name would not be told the grammar. The keys are checked here instead, as `../config.ts`
 * checks environment variable names.
 */
const namedRecord = <T extends z.ZodType>(value: T, name: z.ZodType<string>, what: string) =>
  z.record(z.string(), value).check(ctx => {
    for (const key of Object.keys(ctx.value)) {
      const parsed = name.safeParse(key);
      if (parsed.success) continue;
      ctx.issues.push({
        code: 'custom',
        message: `${what} "${key}": ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
        input: key,
        path: [key],
      });
    }
  });

/** Whether `value` satisfies the runtime-name grammar. One owner, so a suggestion can be checked too. */
export const isRuntimeName = (value: string): boolean => RuntimeNameSchema.safeParse(value).success;

// ── Machine ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The machine's **Agent permissions** (F4): how an agent runtime's permission mode is set by the
 * fixed layer. `auto` stops to ask before anything that looks risky; `skip` never stops to ask.
 */
export const AgentPermissionsSchema = z.enum(['auto', 'skip']);
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;

/**
 * "What agents may control" (T, session-spec.html Settings): the three things a person can switch
 * off independently for every agent runtime on this machine. All default on, because the product
 * starts open and the switch is the escape hatch (same posture as `docs/grants.md`'s permissive
 * defaults) — never read as a security boundary against the operator's own agents, only as a kill
 * switch for one kind of thing they do.
 */
export const AgentControlSchema = z
  .strictObject({
    terminals: z.boolean().default(true),
    browsers: z.boolean().default(true),
    files: z.boolean().default(true),
    /**
     * Whether an agent may read and edit this machine's configuration files through the `config.*`
     * tools (docs/config-files.md). OFF by default, unlike the three above: it is how an agent changes
     * what every other agent may do. Even on, an agent's edit that loosens spend or authority is held
     * until the owner confirms it — this switch is a kill switch, the confirmation is the guard.
     */
    ferretrySettings: z.boolean().default(false),
  })
  .prefault({});
export type AgentControl = z.infer<typeof AgentControlSchema>;

/**
 * "Conversations" (Settings › Machine): how Ferretry treats the CLIs' own history on this computer.
 *
 * `listComputer` is "Keep in sync": while it is on, the Continue list also shows the conversations in
 * the owner's default Claude Code and Codex homes (read-only, read when the list is opened or
 * `fy import conversations` runs, never on a timer). Nothing is adopted until the owner continues one.
 * On by default; switching it off hides them from Continue and nothing else.
 */
export const ConversationsSchema = z
  .strictObject({
    listComputer: z.boolean().default(true),
  })
  .prefault({});
export type Conversations = z.infer<typeof ConversationsSchema>;

/**
 * The runtime name Ferretry's first run gives the first Claude Code it imports (§4.3 step 4's
 * suggestion). Not a schema default — a machine that never imported this way has no such runtime —
 * but the one name {@link resolveDefaultRuntime} tries when the machine named no default itself.
 */
export const DEFAULT_RUNTIME_NAME = 'claude-default';

/** The machine's settings, as a shape `machine.yaml` extends with `advanced` (`../config-files/kinds.ts`). */
export const MACHINE_SHAPE = {
  agentPermissions: AgentPermissionsSchema.default('auto'),
  /**
   * "Default runtime for new agents" (T): the runtime a session starts on when nobody names one.
   * Unset rather than defaulted to {@link DEFAULT_RUNTIME_NAME} here, so a machine with no such
   * runtime still parses — {@link resolveDefaultRuntime} is where the fallback actually happens.
   * When set, it must name an agent runtime on this machine (checked below, by `AccountModelSchema`,
   * where the runtimes it is checked against are in scope).
   */
  defaultRuntime: RuntimeNameSchema.optional(),
  agentControl: AgentControlSchema,
  conversations: ConversationsSchema,
  /**
   * "Browser mode" (docs/browser-mode.md): `headless` (the default — what agents and a display-less
   * server get) or `window`, a real Chrome window for an owner who browses and signs in through it
   * themselves. Read when the agent browser STARTS, so a running browser keeps its mode until it stops.
   * Not a loosening: it changes how the one browser draws, not what an agent may do with it.
   */
  browserMode: BrowserModeSchema.default('headless'),
  /**
   * "Auto-resume after restart": when the daemon boots and finds ferrets that were running when the host
   * went down, it resumes them with their conversation intact. On by default; sessions the owner stopped
   * stay stopped. Read when the daemon starts.
   */
  autoResume: z.boolean().default(true),
  /**
   * "Agenda check" (docs/agenda.md): when a top-level ferret's turn ends on a
   * reply that asks the owner to act and the turn raised no agenda item or notice for it, the daemon sends the
   * ferret one short reminder to raise each one. On by default. Not a loosening either way: it changes
   * what a ferret is reminded of, never what it may do or spend. Read at every turn end.
   */
  attentionNudge: z.boolean().default(true),
  /**
   * The same switch under its new name (wire `agenda.wire.1`). `attentionNudge` is still read until the agenda
   * removal release. It has NO default so that "written" stays distinguishable from "left out": when both are
   * written this one wins, and `agendaNudgeEnabled` is the one place that decides, so no consumer ever sees two.
   */
  agendaNudge: z.boolean().optional(),
  /**
   * "Agenda mode for new ferrets" (docs/agenda.md § The machine default): whether a ferret that is started or adopted
   * from now on is told to keep an agenda. On by default. It is recorded on the new ferret once, as `config.agenda`, so
   * a ferret that already exists is never touched and an owner's explicit per-ferret switch always wins. Not a
   * loosening either way: it changes what a ferret is told, never what it may do or spend. Read at every start.
   */
  agendaMode: z.boolean().default(true),
};

export const MachineSchema = z.strictObject(MACHINE_SHAPE).prefault({});
export type Machine = z.infer<typeof MachineSchema>;

/** Whether the agenda check is on: `agendaNudge` when written, otherwise the older `attentionNudge`. */
export function agendaNudgeEnabled(machine: Pick<Machine, 'agendaNudge' | 'attentionNudge'>): boolean {
  return machine.agendaNudge ?? machine.attentionNudge;
}

// ── Credential ───────────────────────────────────────────────────────────────────────────────────

/**
 * Where a credential is kept (C3).
 *
 * - `host` — the person's own `~/.claude` / `~/.codex` login, shared in place. Ferretry keeps a
 *   pointer and never a copy, and at most one per harness can exist (C4).
 * - `ferretry` — a login Ferretry signed in, under `<FY_HOME>/fleet/credentials/<id>/`.
 * - `environment` — no login at all: the credential's own `env` authenticates every runtime on it.
 */
export const CredentialStoreSchema = z.enum(['host', 'ferretry', 'environment']);
export type CredentialStore = z.infer<typeof CredentialStoreSchema>;

/**
 * Set by Clone (C8, L2) on everything it copies: where it came from. Display only.
 *
 * - `clonedFrom` — the source machine by the name it gave ITSELF, so never proof of anything.
 * - `clonedFromDaemon` — the source's daemon id AS THE COPYING BROWSER REPORTED IT: the fingerprint it
 *   paired with, which a surface turns into the reader's own label for that machine. The target cannot
 *   check it, so it is exactly as true as the browser that staged the copy, which already holds this
 *   machine's `fleet.configure`.
 */
const CLONE_ORIGIN_SHAPE = {
  clonedFrom: NonEmptyString.optional(),
  clonedFromDaemon: NonEmptyString.optional(),
};

/**
 * One CLI's half of an environment login with halves (`./halves.ts`): the variables that CLI is given
 * beyond the login's shared `env`, and — Codex only — the model provider it is pointed at.
 */
export const CredentialHalfSchema = z.strictObject({
  env: EnvSchema.optional(),
  codexProvider: CodexProviderSchema.optional(),
});
export type CredentialHalfFile = z.infer<typeof CredentialHalfSchema>;

/**
 * One login to one harness on this machine (C1, C2) — or, for an environment login with halves, to
 * both. Stored exactly once; every runtime that names it reads that one store.
 *
 * An ENVIRONMENT login (`store: environment`) is no sign-in at all: its `env` is injected into every
 * runtime on it at launch, a secret as a `${secret:NAME}` reference and never a value
 * (docs/provider-presets.md). It may also name the preset it was made from, a cloud credential this
 * machine already has (`cloudCredential`, kept as a reference) and — Codex only — the model provider
 * Codex is pointed at (`codexProvider`).
 *
 * A provider that serves both CLIs makes ONE login with `claude:` and `codex:` halves (`./halves.ts`):
 * the top-level `env` is then shared by both, each half adds its own, and `codexProvider` lives in
 * `codex:`. `harness` names the half a runtime on it runs when nothing else says.
 */
export const CredentialSchema = z
  .strictObject({
    harness: HarnessKindSchema,
    store: CredentialStoreSchema.default('ferretry'),
    /** Display only (C9): what tells two logins with one email apart. */
    label: NonEmptyString.optional(),
    ...CLONE_ORIGIN_SHAPE,
    /** `store: environment` only. A secret travels as a `${secret:NAME}` reference, never a value. */
    env: EnvSchema.optional(),
    /** `store: environment` only: the provider preset it was made from. Display, Test and quota. */
    preset: SafeNameSchema.optional(),
    /** `store: environment` only: a cloud credential this machine has, by reference (`./environment.ts`). */
    cloudCredential: CloudCredentialSchema.optional(),
    /** `store: environment`, Codex only, no halves: the model provider the runtime is pointed at. */
    codexProvider: CodexProviderSchema.optional(),
    /** `store: environment` only: what Claude Code is given (`./halves.ts`). */
    claude: CredentialHalfSchema.optional(),
    /** `store: environment` only: what Codex is given (`./halves.ts`). */
    codex: CredentialHalfSchema.optional(),
  })
  .check(ctx => {
    const credential = ctx.value;
    const push = (message: string, path: string | readonly PropertyKey[], input: unknown): void => {
      ctx.issues.push({ code: 'custom', message, input, path: typeof path === 'string' ? [path] : [...path] });
    };
    if (credential.store !== 'environment') {
      for (const field of ['env', 'preset', 'cloudCredential', 'codexProvider', 'claude', 'codex'] as const) {
        if (credential[field] === undefined) continue;
        push(
          `"${field}" belongs only to a credential with store: environment — this one is store: ${credential.store}`,
          field,
          credential[field],
        );
      }
      return;
    }
    const halved = hasHalves(credential);
    if (halved) {
      if (credential[credential.harness] === undefined) {
        push(
          `"harness: ${credential.harness}" must name one of this login's halves (${credentialHarnesses(credential).join(', ')})`,
          'harness',
          credential.harness,
        );
      }
      if (credential.codexProvider !== undefined) {
        push(
          '"codexProvider" goes inside "codex:" when the login has halves',
          'codexProvider',
          credential.codexProvider,
        );
      }
      if (credential.claude?.codexProvider !== undefined) {
        push(
          '"codexProvider" points Codex at a model provider — it goes in "codex:", not "claude:"',
          ['claude', 'codexProvider'],
          credential.claude.codexProvider,
        );
      }
    } else if (credential.codexProvider !== undefined && credential.harness !== 'codex') {
      push(
        '"codexProvider" points Codex at a model provider — this login is for Claude Code',
        'codexProvider',
        credential.codexProvider,
      );
    }
    const all = credentialVariables(credential);
    if (
      Object.keys(all).length === 0 &&
      credentialCodexProvider(credential) === undefined &&
      credential.cloudCredential === undefined
    ) {
      push(
        'a credential kept in the environment must say which variables authenticate it, in "env"',
        'env',
        credential.env,
      );
    }
    const codex = credentialHalves(credential).codex;
    const provider = codex?.codexProvider;
    if (codex !== undefined && provider !== undefined) {
      const where = halved ? ['codex', 'codexProvider'] : ['codexProvider'];
      const env = codex.env;
      if (provider.keyVariable !== undefined && env[provider.keyVariable] === undefined) {
        push(
          `the Codex provider sends its key from ${provider.keyVariable}, so "env" must set ${provider.keyVariable} (as \${secret:NAME})`,
          where,
          provider.keyVariable,
        );
      }
      for (const name of templatePlaceholders(provider.baseUrl ?? '')) {
        if (env[name] === undefined) {
          push(`the Codex provider's base URL names {${name}}, so "env" must set ${name}`, where, name);
        }
      }
    }
    const reference =
      credential.cloudCredential === undefined ? undefined : parseCloudCredential(credential.cloudCredential);
    const variable = reference === undefined ? undefined : cloudCredentialVariable(reference);
    if (variable !== undefined && all[variable] !== undefined) {
      push(
        `${variable} comes from "cloudCredential" (${credential.cloudCredential}) — leave it out of "env"`,
        'env',
        variable,
      );
    }
  });
export type Credential = z.infer<typeof CredentialSchema>;

// ── Components ───────────────────────────────────────────────────────────────────────────────────

/**
 * The six kinds of component, spelled exactly as the `components` block's keys and as the first half
 * of a layer reference (`instructions/main`, `modelSets/heavy`).
 */
export const COMPONENT_KINDS = CONFIG_COMPONENT_KINDS;
export const ComponentKindSchema = z.enum(COMPONENT_KINDS);
export type ComponentKind = z.infer<typeof ComponentKindSchema>;

/** A component file, relative to the asset tree unless it starts with `/`, `~` or `$HOME`. */
const ComponentFileSchema = NonEmptyString;

/** Instructions (generic, K2): one document, optionally narrowed to one harness (K3). */
export const InstructionsComponentSchema = z.strictObject({
  file: ComponentFileSchema,
  harness: HarnessKindSchema.optional(),
  ...CLONE_ORIGIN_SHAPE,
});
export type InstructionsComponent = z.infer<typeof InstructionsComponentSchema>;

/**
 * A client registered BY HAND with a server's sign-in provider, for a provider that does not let apps
 * register themselves (no RFC 7591 endpoint, or one that refuses). The field names are Claude Code's
 * `.mcp.json` `oauth` block (`clientId`, `callbackPort`); the client secret, which Claude keeps in its
 * keychain, is a `${secret:NAME}` reference to the daemon's secret store and never a value
 * (docs/mcp-oauth.md#a-client-registered-by-hand).
 */
export const McpOAuthClientSchema = z.strictObject({
  clientId: NonEmptyString.max(512),
  clientSecret: z
    .string()
    .regex(
      new RegExp(`^${SECRET_REFERENCE_SOURCE}$`, 'u'),
      `a client secret is written as a \${secret:NAME} reference to the secret store, never as the value`,
    )
    .optional(),
  /** The redirect registered with the provider is then `http://localhost:<callbackPort>/callback`. */
  callbackPort: z.number().int().min(1024).max(65535).optional(),
});
export type McpOAuthClient = z.infer<typeof McpOAuthClientSchema>;

/**
 * One MCP server (generic, K2): either a command Ferretry's runtimes start (`command` + `args`) or a
 * server they reach at a `url`. Exactly one of the two, because a server that is both is a server
 * nobody can say how to start.
 */
export const McpComponentSchema = z
  .strictObject({
    command: NonEmptyString.optional(),
    args: z.array(z.string()).optional(),
    env: EnvSchema.optional(),
    url: z.url().optional(),
    /**
     * `oauth`: a server reached at `url` that is signed in to from Ferretry. The daemon keeps its tokens
     * in the secret store and the runtime reads the access token by variable name (docs/mcp-oauth.md).
     */
    auth: z.literal('oauth').optional(),
    /** A client registered by hand with the provider: Ferretry then registers nothing. Needs `auth: oauth`. */
    oauth: McpOAuthClientSchema.optional(),
    harness: HarnessKindSchema.optional(),
    ...CLONE_ORIGIN_SHAPE,
  })
  .check(ctx => {
    const server = ctx.value;
    if ((server.command === undefined) === (server.url === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: 'an MCP server needs exactly one of "command" (a server to start) or "url" (a server to reach)',
        input: server,
        path: [],
      });
      return;
    }
    if (server.url !== undefined && (server.args !== undefined || server.env !== undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: '"args" and "env" start a command — a server reached at a "url" takes neither',
        input: server,
        path: [server.args === undefined ? 'env' : 'args'],
      });
    }
    if (server.auth !== undefined && server.url === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: '"auth" signs in to a server reached at a "url" — a server Ferretry starts has nothing to sign in to',
        input: server,
        path: ['auth'],
      });
    }
    if (server.oauth !== undefined && server.auth !== 'oauth') {
      ctx.issues.push({
        code: 'custom',
        message: '"oauth" names the client a sign-in uses — it needs "auth: oauth" on a server reached at a "url"',
        input: server,
        path: ['oauth'],
      });
    }
    // A signed-in server is sent a bearer token on every launch: never over cleartext to another host.
    if (server.auth !== undefined && server.url !== undefined && !secureMcpUrl(server.url)) {
      ctx.issues.push({
        code: 'custom',
        message: '"auth" sends a token to this server, so its "url" must be https:// (plain http only on this machine)',
        input: server,
        path: ['url'],
      });
    }
  });
export type McpComponent = z.infer<typeof McpComponentSchema>;

/** Skills (generic, K2): a selection of items from the skills store, each landing under its own name. */
export const SkillsComponentSchema = z
  .strictObject({
    items: z.array(SafeNameSchema).min(1),
    harness: HarnessKindSchema.optional(),
    ...CLONE_ORIGIN_SHAPE,
  })
  .check(ctx => {
    const seen = new Set<string>();
    ctx.value.items.forEach((item, index) => {
      if (seen.has(item)) {
        ctx.issues.push({
          code: 'custom',
          message: `skill item "${item}" is listed twice`,
          input: item,
          path: ['items', index],
        });
      }
      seen.add(item);
    });
  });
export type SkillsComponent = z.infer<typeof SkillsComponentSchema>;

/**
 * Settings (one harness, K2) — and the one place flags and environment live (K4). Any of the three
 * may be given alone, but a settings component must say something.
 *
 * - `file` — the harness's own settings document (`settings.json`, `config.toml`). Layers deep-merge
 *   per harness, the later key winning (§3.4).
 * - `flags` — launch arguments, in order. Layers **append**, oldest first, so a later layer's flag
 *   comes later on the command line. Appending rather than replacing is what version 1 did, and it is
 *   what lets a later layer add one flag without restating every earlier one.
 * - `env` — launch environment. Layers merge **by variable**, the later layer winning. A secret is a
 *   `${secret:NAME}` reference, never a value, and the variables that bind a runtime to its config
 *   directory or its credential are refused (`RESERVED_ENV_NAMES`).
 */
export const SettingsComponentSchema = z
  .strictObject({
    harness: HarnessKindSchema,
    file: ComponentFileSchema.optional(),
    flags: z.array(NonEmptyString).min(1).optional(),
    env: EnvSchema.optional(),
    ...CLONE_ORIGIN_SHAPE,
  })
  .check(ctx => {
    const settings = ctx.value;
    if (settings.file === undefined && settings.flags === undefined && settings.env === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'a settings component needs at least one of "file", "flags" or "env"',
        input: settings,
        path: [],
      });
    }
  });
export type SettingsComponent = z.infer<typeof SettingsComponentSchema>;

/**
 * Hooks (one harness, K2): a hooks `file`, or a `directory` of the scripts hooks run. Exactly one,
 * because each lands at its own place in a runtime's config directory and one component is one thing.
 */
export const HooksComponentSchema = z
  .strictObject({
    harness: HarnessKindSchema,
    file: ComponentFileSchema.optional(),
    directory: ComponentFileSchema.optional(),
    ...CLONE_ORIGIN_SHAPE,
  })
  .check(ctx => {
    const hooks = ctx.value;
    if ((hooks.file === undefined) === (hooks.directory === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: 'a hooks component needs exactly one of "file" (a hooks document) or "directory" (hook scripts)',
        input: hooks,
        path: [],
      });
    }
  });
export type HooksComponent = z.infer<typeof HooksComponentSchema>;

/** A model set (K2, K8): model ids and the one a runtime uses when nobody names one. */
export const ModelSetComponentSchema = z
  .strictObject({
    models: z.array(NonEmptyString).min(1),
    default: NonEmptyString,
    ...CLONE_ORIGIN_SHAPE,
  })
  .check(ctx => {
    const set = ctx.value;
    const seen = new Set<string>();
    set.models.forEach((model, index) => {
      if (seen.has(model)) {
        ctx.issues.push({
          code: 'custom',
          message: `model "${model}" is listed twice`,
          input: model,
          path: ['models', index],
        });
      }
      seen.add(model);
    });
    if (!set.models.includes(set.default)) {
      ctx.issues.push({
        code: 'custom',
        message: `default "${set.default}" is not one of this model set's models (${set.models.join(', ')})`,
        input: set.default,
        path: ['default'],
      });
    }
  });
export type ModelSetComponent = z.infer<typeof ModelSetComponentSchema>;

/** The component name grammar: safe as a path component, and never containing the layer separator. */
export const ComponentNameSchema = SafeNameSchema;

export const ComponentsSchema = z
  .strictObject({
    instructions: namedRecord(InstructionsComponentSchema, ComponentNameSchema, 'component name').default({}),
    mcp: namedRecord(McpComponentSchema, ComponentNameSchema, 'component name').default({}),
    skills: namedRecord(SkillsComponentSchema, ComponentNameSchema, 'component name').default({}),
    settings: namedRecord(SettingsComponentSchema, ComponentNameSchema, 'component name').default({}),
    hooks: namedRecord(HooksComponentSchema, ComponentNameSchema, 'component name').default({}),
    modelSets: namedRecord(ModelSetComponentSchema, ComponentNameSchema, 'component name').default({}),
  })
  .prefault({});
export type Components = z.infer<typeof ComponentsSchema>;

/** One component of any kind, as its kind's own type. */
export type ComponentOf<K extends ComponentKind> = Components[K][string];

// ── Profile ──────────────────────────────────────────────────────────────────────────────────────

/** The first half of a layer reference that names another profile used as a base (P1). */
export const PROFILE_LAYER_PREFIX = 'profile' as const;

/** A layer reference as written: `<kind>/<name>` for a component, `profile/<name>` for a base. */
export type LayerReferenceText = `${ComponentKind}/${string}` | `${typeof PROFILE_LAYER_PREFIX}/${string}`;

/** A layer reference, read. */
export type LayerReference =
  | { readonly kind: 'profile'; readonly name: string }
  | { readonly kind: 'component'; readonly componentKind: ComponentKind; readonly name: string };

const LAYER_KINDS: readonly string[] = [...COMPONENT_KINDS, PROFILE_LAYER_PREFIX];

/**
 * Read a layer reference, or `undefined` when it is not one. Total over every string, so a caller
 * holding text it did not parse can still ask.
 */
export function parseLayerReference(text: string): LayerReference | undefined {
  const separator = text.indexOf('/');
  if (separator < 0) return undefined;
  const kind = text.slice(0, separator);
  const name = text.slice(separator + 1);
  if (!LAYER_KINDS.includes(kind) || !ComponentNameSchema.safeParse(name).success) return undefined;
  if (kind === PROFILE_LAYER_PREFIX) return { kind: 'profile', name };
  return { kind: 'component', componentKind: kind as ComponentKind, name };
}

/** Write a layer reference. The inverse of {@link parseLayerReference}. */
export function layerReferenceText(reference: LayerReference): LayerReferenceText {
  return reference.kind === 'profile'
    ? `${PROFILE_LAYER_PREFIX}/${reference.name}`
    : `${reference.componentKind}/${reference.name}`;
}

export const LayerReferenceTextSchema = z.string().check(ctx => {
  if (parseLayerReference(ctx.value) === undefined) {
    ctx.issues.push({
      code: 'custom',
      message: `"${ctx.value}" is not a layer — write <kind>/<name> with kind one of ${COMPONENT_KINDS.join(', ')}, or profile/<name>`,
      input: ctx.value,
    });
  }
}) as unknown as z.ZodType<LayerReferenceText, string>;

/**
 * A profile (P1): an ordered stack of layers, **oldest first**, in which the newer layer always
 * overrides the older (P2). How each kind merges is the layering module's (`./layering.ts`).
 *
 * An empty stack is accepted here — it is a profile that applies nothing, which P5 already reports as
 * unavailable — so a document can always be read. The build flow refuses to CREATE one.
 *
 * The product calls this a **Profile**. The code says `LayeredProfile` only because version 1's own
 * `Profile` (`../config.ts`) is exported from the same barrel until the old model is retired.
 */
export const LayeredProfileSchema = z.strictObject({
  layers: z.array(LayerReferenceTextSchema).default([]),
});
export type LayeredProfile = z.infer<typeof LayeredProfileSchema>;

// ── Runtime ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A runtime (R1): one credential and one profile, launched under its name.
 *
 * `harness` is for a login that drives both CLIs (`./halves.ts`): which of them this runtime runs. Left
 * out, it is the one its profile is scoped to, else the login's own `harness` (`./scope.ts`
 * `runtimeHarness`).
 */
export const RuntimeSchema = z.strictObject({
  credential: CredentialIdSchema,
  profile: ComponentNameSchema,
  harness: HarnessKindSchema.optional(),
  /** "Ferretry launches this as an agent" (R3): only these get the fixed layer and start unattended. */
  agent: z.boolean().default(false),
});
export type Runtime = z.infer<typeof RuntimeSchema>;

// ── Advanced ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A thin executable that runs one runtime with extra flags prepended. Named by RUNTIME NAME, because
 * runtime ids are not in the config (R6).
 */
export const RuntimeCommandSchema = z.strictObject({
  wrapper: RuntimeNameSchema,
  runtime: RuntimeNameSchema,
  flags: z.array(NonEmptyString).default([]),
});
export type RuntimeCommand = z.infer<typeof RuntimeCommandSchema>;

/** Everything a beginner never sees, carried over from version 1. */
export const AdvancedSchema = z
  .strictObject({
    /** Shell file every wrapper sources before it runs, so `$NAME` references resolve. */
    secretsFile: NonEmptyString.optional(),
    aliases: namedRecord(AliasSchema, SafeNameSchema, 'alias name').default({}),
    commands: z.array(RuntimeCommandSchema).default([]),
    usage: UsageSchema,
    /** Whether the CLI prints the line that puts the wrappers on `PATH`. */
    path: z.strictObject({ announce: z.boolean().default(true) }).prefault({}),
  })
  .prefault({});
export type Advanced = z.infer<typeof AdvancedSchema>;

// ── The whole document ───────────────────────────────────────────────────────────────────────────

type Issue = { code: 'custom'; message: string; input: unknown; path: (string | number)[] };

const listOf = (names: Iterable<string>): string => {
  const all = [...names];
  return all.length === 0 ? 'none' : all.join(', ');
};

/**
 * The profile names `name` reaches through its `profile/…` layers, itself excluded unless it loops
 * back. Iterative, so a pathological chain cannot exhaust the stack.
 */
function reachedProfiles(profiles: Readonly<Record<string, LayeredProfile>>, name: string): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [name];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const layer of profiles[next]?.layers ?? []) {
      const reference = parseLayerReference(layer);
      if (reference?.kind !== 'profile' || reached.has(reference.name)) continue;
      reached.add(reference.name);
      pending.push(reference.name);
    }
  }
  return reached;
}

/**
 * Whether profile `name` would include `candidate` — directly, through a base, or by being it. The
 * "Would include itself" rule (P3, E19) a build flow disables a base with.
 */
export function wouldIncludeItself(
  profiles: Readonly<Record<string, LayeredProfile>>,
  name: string,
  candidate: string,
): boolean {
  return candidate === name || reachedProfiles(profiles, candidate).has(name);
}

/**
 * A whole version-2 fleet configuration, `<FY_HOME>/fleet/config.yaml` (§5.3).
 *
 * Strict everywhere, so a typo is an error rather than a silently ignored key, and cross-referential:
 * an unknown credential, profile or layer, a profile that reaches itself, a second `host` login for
 * one harness, and a command naming a runtime that does not exist are all reported by one parse.
 */
export const AccountModelSchema = z
  .strictObject({
    version: z.literal(ACCOUNT_MODEL_VERSION),
    machine: MachineSchema,
    credentials: namedRecord(CredentialSchema, CredentialIdSchema, 'credential id').default({}),
    components: ComponentsSchema,
    profiles: namedRecord(LayeredProfileSchema, ComponentNameSchema, 'profile name').default({}),
    runtimes: namedRecord(RuntimeSchema, RuntimeNameSchema, 'runtime name').default({}),
    advanced: AdvancedSchema,
  })
  .check(ctx => {
    const model = ctx.value;
    const push = (issue: Issue): void => {
      ctx.issues.push(issue);
    };

    // C4: one `host` login per harness, because there is one `~/.claude` and one `~/.codex`.
    const hostOwners = new Map<string, string>();
    for (const [id, credential] of Object.entries(model.credentials)) {
      if (credential.store !== 'host') continue;
      const owner = hostOwners.get(credential.harness);
      if (owner === undefined) {
        hostOwners.set(credential.harness, id);
        continue;
      }
      push({
        code: 'custom',
        message: `"${id}" and "${owner}" are both your own ${credential.harness} login (store: host) — a machine has only one, so one of them must be store: ferretry`,
        input: credential.store,
        path: ['credentials', id, 'store'],
      });
    }

    for (const [name, profile] of Object.entries(model.profiles)) {
      profile.layers.forEach((layer, index) => {
        // Already a valid reference: the element schema refused anything else.
        const reference = parseLayerReference(layer) as LayerReference;
        const path = ['profiles', name, 'layers', index];
        if (reference.kind === 'profile') {
          if (model.profiles[reference.name] === undefined) {
            push({
              code: 'custom',
              message: `profile "${name}" uses unknown profile "${reference.name}" as a layer (profiles: ${listOf(Object.keys(model.profiles))})`,
              input: layer,
              path,
            });
          }
          return;
        }
        const existing = model.components[reference.componentKind];
        if (existing[reference.name] === undefined) {
          push({
            code: 'custom',
            message: `profile "${name}" uses unknown ${reference.componentKind} component "${reference.name}" (${reference.componentKind}: ${listOf(Object.keys(existing))})`,
            input: layer,
            path,
          });
        }
      });
      // P3: reported once per profile, on the profile, rather than once per layer of the loop.
      if (reachedProfiles(model.profiles, name).has(name)) {
        push({
          code: 'custom',
          message: `profile "${name}" includes itself through its layers — a profile can never be its own base`,
          input: profile.layers,
          path: ['profiles', name, 'layers'],
        });
      }
    }

    // T: "Default runtime for new agents" must name an agent runtime actually on this machine —
    // refused here, by name, the same way an unknown credential or profile is.
    if (model.machine.defaultRuntime !== undefined) {
      const named = model.runtimes[model.machine.defaultRuntime];
      if (named === undefined || !named.agent) {
        const agentRuntimes = Object.entries(model.runtimes)
          .filter(([, runtime]) => runtime.agent)
          .map(([runtimeName]) => runtimeName);
        push({
          code: 'custom',
          message: `the default runtime for new agents, "${model.machine.defaultRuntime}", is not an agent runtime on this machine (agent runtimes: ${listOf(agentRuntimes)})`,
          input: model.machine.defaultRuntime,
          path: ['machine', 'defaultRuntime'],
        });
      }
    }

    for (const [name, runtime] of Object.entries(model.runtimes)) {
      const credential = model.credentials[runtime.credential];
      if (credential === undefined) {
        push({
          code: 'custom',
          message: `runtime "${name}" uses unknown credential "${runtime.credential}" (credentials: ${listOf(Object.keys(model.credentials))})`,
          input: runtime.credential,
          path: ['runtimes', name, 'credential'],
        });
      } else if (runtime.harness !== undefined && !credentialHarnesses(credential).includes(runtime.harness)) {
        push({
          code: 'custom',
          message: `runtime "${name}" runs ${runtime.harness}, but login "${runtime.credential}" drives only ${listOf([...credentialHarnesses(credential)])}`,
          input: runtime.harness,
          path: ['runtimes', name, 'harness'],
        });
      }
      if (model.profiles[runtime.profile] === undefined) {
        push({
          code: 'custom',
          message: `runtime "${name}" uses unknown profile "${runtime.profile}" (profiles: ${listOf(Object.keys(model.profiles))})`,
          input: runtime.profile,
          path: ['runtimes', name, 'profile'],
        });
      }
    }

    // A command is an executable beside the runtimes' own, so it may not take a runtime's name or
    // another command's.
    const wrapperOwners = new Map<string, string>(Object.keys(model.runtimes).map(name => [name, `runtime ${name}`]));
    model.advanced.commands.forEach((command, index) => {
      if (model.runtimes[command.runtime] === undefined) {
        push({
          code: 'custom',
          message: `command "${command.wrapper}" runs unknown runtime "${command.runtime}"`,
          input: command.runtime,
          path: ['advanced', 'commands', index, 'runtime'],
        });
      }
      const owner = wrapperOwners.get(command.wrapper);
      if (owner !== undefined) {
        push({
          code: 'custom',
          message: `command "${command.wrapper}" has the same name as ${owner}`,
          input: command.wrapper,
          path: ['advanced', 'commands', index, 'wrapper'],
        });
        return;
      }
      wrapperOwners.set(command.wrapper, `command ${command.wrapper}`);
    });
  });
export type AccountModel = z.infer<typeof AccountModelSchema>;

/** What an author writes: the same document before defaults are filled in. */
export type AccountModelDocument = z.input<typeof AccountModelSchema>;

/**
 * Parse a version-2 document from untrusted input, so downstream code holds an {@link AccountModel}
 * rather than a promise that one was checked. Throws a `ZodError` naming every problem at once.
 */
export function parseAccountModel(input: unknown): AccountModel {
  return AccountModelSchema.parse(input);
}

/**
 * "Default runtime for new agents" (T), resolved: the machine's own setting when it has one — the
 * schema above already refused anything that is not an agent runtime here — or else
 * {@link DEFAULT_RUNTIME_NAME} when THAT is an agent runtime on this machine, or else `undefined`
 * when neither resolves, which a start without an explicit runtime must then refuse in its own words.
 */
export function resolveDefaultRuntime(model: AccountModel): string | undefined {
  if (model.machine.defaultRuntime !== undefined) return model.machine.defaultRuntime;
  return model.runtimes[DEFAULT_RUNTIME_NAME]?.agent === true ? DEFAULT_RUNTIME_NAME : undefined;
}
