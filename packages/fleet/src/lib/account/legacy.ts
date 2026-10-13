/**
 * Version 1 → version 2, in memory and pure (docs/design/account-model.md §10.2, §10.4).
 *
 * Two callers read through this one mapping: the compatibility read, which lets every surface built
 * on the new model run against a version-1 `config.yaml` it never writes back, and `fy fleet migrate`,
 * which prints and then applies what this returns. One mapping, so the dry run describes exactly what
 * the daemon was already showing.
 *
 * ## The rule: preserve what a runtime LAUNCHES WITH, not the shape it was written in
 *
 * Version 1 composes a route from a chain of slots, and in that chain `memory`, `hooks`, `hooksDir`
 * and `mcp` are last-writer-wins and `skills` is replaced whole by a later slot. Version 2 does the
 * opposite for most of them — instructions concatenate, hooks all apply, skills union (§3.4). So
 * translating the chain slot by slot would change meaning: every auto runtime would suddenly read
 * `CLAUDE.md` AND `CLAUDE-auto.md`. Instead each route is flattened by today's own resolver
 * (`resolveAccounts`) and becomes ONE profile holding its resolved documents, and routes that resolve
 * to the same layers share one profile. A migrated profile is therefore flat; the owner can layer it
 * again from the UI.
 *
 * A field is carried only where version 1 actually DELIVERED it. Version 1 materialises each field
 * per harness (`HARNESS_ASSETS`) — hooks reach only Codex and an MCP file only Claude — so a Claude
 * hook in a version-1 profile never ran, and carrying it would make a Claude runtime gain hooks it
 * never had. Such a field becomes a note instead.
 *
 * ## Total: everything lands somewhere a person can see
 *
 * Every version-1 fact either becomes part of the model or comes back as a {@link LegacyConversionNote}
 * naming where it was and what happened to it. Two things the pure mapping cannot finish are returned
 * as typed work rather than guessed at: an inline settings object becomes a {@link GeneratedSettingsBody}
 * (a file the migration writes), and an MCP list file becomes a {@link PendingMcpList} (servers only a
 * reader of that file can name).
 *
 * The model is parsed by `AccountModelSchema` before it is returned, so a conversion can never hand a
 * caller a document version 2 would refuse.
 */
import type { AssetField } from '../assets.ts';
import { HARNESS_ASSETS } from '../assets.ts';
import { type FleetConfig, FleetConfigSchema, SafeNameSchema, type SettingsLayer } from '../config.ts';
import { credentialSourceOf, HARNESS_CREDENTIAL_ENV } from '../credential-source.ts';
import type { HarnessKind } from '../manifest.ts';
import { canonicalAssetReference } from '../paths.ts';
import { groupByIdentity, type ResolvedAccount, resolveAccounts } from '../profiles.ts';
import type { SettingsFormat, SettingsObject } from '../settings.ts';
import {
  type AccountModel,
  AccountModelSchema,
  type AccountModelDocument,
  type AgentPermissions,
  type CredentialStore,
  type LayerReferenceText,
  parseAccountModel,
} from './schema.ts';

// ── What a conversion returns ────────────────────────────────────────────────────────────────────

/** Where a converted runtime came from: what `ids.json` records so every old join still holds (R6). */
export interface LegacyRuntimeOrigin {
  /** The route's UUID, which the runtime keeps as its id. */
  readonly routeId: string;
  /** The route's wrapper name, which keeps resolving (`fy start --agent <old name>`). */
  readonly wrapper: string;
  /** The route's home as configured. The config directory stays there: nothing moves. */
  readonly home: string;
  readonly agent: string;
  readonly variant: string;
  readonly harness: HarnessKind;
}

/** Where a converted credential came from: one version-1 `<kind>:<identity>` group (§10.2.1). */
export interface LegacyCredentialOrigin {
  /** The grouping key `identity.ts` computes, `<kind>:<identity>`. */
  readonly key: string;
  readonly harness: HarnessKind;
  readonly identity: string;
  /** The routes that shared this login, by UUID, in configuration order. */
  readonly routeIds: readonly string[];
}

/** An inline version-1 settings object, which version 2 keeps as a file the migration must write. */
export interface GeneratedSettingsBody {
  /** The Settings component that names this file. */
  readonly component: string;
  readonly harness: HarnessKind;
  /** The component's `file`, relative to the asset tree. */
  readonly file: string;
  readonly format: SettingsFormat;
  readonly content: SettingsObject;
}

/** An MCP list file whose servers become MCP components once somebody reads the file. */
export interface PendingMcpList {
  readonly harness: HarnessKind;
  /** The file, as version 1 referenced it. */
  readonly file: string;
  /** The profiles each server read from it must be added to as a layer. */
  readonly profiles: readonly string[];
}

/** One thing the mapping did that a person should be told about. */
export interface LegacyConversionNote {
  /** Where in the version-1 document it was. */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface LegacyConversion {
  readonly model: AccountModel;
  /** Runtime name → where it came from. */
  readonly runtimes: Readonly<Record<string, LegacyRuntimeOrigin>>;
  /** Credential id → where it came from. */
  readonly credentials: Readonly<Record<string, LegacyCredentialOrigin>>;
  readonly settingsBodies: readonly GeneratedSettingsBody[];
  readonly pendingMcp: readonly PendingMcpList[];
  readonly notes: readonly LegacyConversionNote[];
}

export interface LegacyConversionOptions {
  /**
   * Whether this group's login is the person's own host login, shared in place (`store: host`).
   *
   * The mapping cannot know — that takes reading seed provenance and the host's credential — so the
   * caller decides and every group defaults to `store: ferretry`. A second `true` for one harness is
   * refused by C4, so it becomes `ferretry` with a note.
   */
  readonly isHostLogin?: (origin: LegacyCredentialOrigin) => boolean;
}

// ── Declared tables ──────────────────────────────────────────────────────────────────────────────

/**
 * Flags that mean "skip every permission check". On an agent runtime they are dropped in favour of the
 * machine's Agent permissions (§10.2.4), which the fixed layer applies.
 */
export const LEGACY_SKIP_PERMISSION_FLAGS: Readonly<Record<HarnessKind, readonly string[]>> = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
};

/** Flags today's auto lane carries that the fixed layer carries from now on (§8.4 "carried from today"). */
export const LEGACY_FIXED_LAYER_FLAGS: Readonly<Record<HarnessKind, readonly string[]>> = {
  claude: ['--disallowed-tools=AskUserQuestion'],
  codex: ['--no-alt-screen'],
};

const deliveredFields = (harness: HarnessKind): ReadonlySet<AssetField> =>
  new Set(HARNESS_ASSETS[harness].map(asset => asset.field));

const settingsFormatOf = (harness: HarnessKind): SettingsFormat =>
  HARNESS_ASSETS[harness].find(asset => asset.field === 'settings')?.format ?? 'json';

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

const NAME_LIMIT = 64;

/** The nearest letters-digits-dashes name to `value`, or `fallback` when nothing of it survives. */
export function slugName(value: string, fallback: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9]+/g, '-')
    .slice(0, NAME_LIMIT)
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? fallback : slug;
}

/** `base`, or `base-2`, `base-3`, … — the first not yet taken (E16, E28) — and takes it. */
function claimName(taken: Set<string>, base: string): string {
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) {
    const tail = `-${suffix}`;
    name = `${base.slice(0, NAME_LIMIT - tail.length)}${tail}`;
  }
  taken.add(name);
  return name;
}

const stemOf = (reference: string): string => {
  const file = canonicalAssetReference(reference).split('/').pop() ?? reference;
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
};

const sortedEntries = <V>(record: Readonly<Record<string, V>>): [string, V][] =>
  Object.entries(record).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

const keyOf = (value: unknown): string => JSON.stringify(value);

// ── The conversion ───────────────────────────────────────────────────────────────────────────────

/** Components collected while walking the routes, deduplicated by what they say. */
class ComponentRegistry<T> {
  readonly #byKey = new Map<string, { name: string; value: T; harnesses: Set<HarnessKind> }>();
  readonly #names = new Set<string>();

  /** The component's name, creating it under `preferred` (made unique) the first time. */
  use(key: string, preferred: string, value: T, harness: HarnessKind): string {
    const existing = this.#byKey.get(key);
    if (existing !== undefined) {
      existing.harnesses.add(harness);
      return existing.name;
    }
    const name = claimName(this.#names, preferred);
    this.#byKey.set(key, { name, value, harnesses: new Set([harness]) });
    return name;
  }

  entries(): readonly { name: string; value: T; harnesses: ReadonlySet<HarnessKind> }[] {
    return [...this.#byKey.values()];
  }
}

const sharedNameFor = (registry: Readonly<Record<string, string>>, reference: string): string | undefined =>
  Object.entries(registry).find(
    ([, path]) => canonicalAssetReference(path) === canonicalAssetReference(reference),
  )?.[0];

/**
 * The version-2 item a version-1 skills reference names, or `undefined` when it has no spelling there.
 *
 * Version 1 lists references (`./skills/review`, as docs/fleet-sharing.md documents); a version-2
 * skills component lists bare item names. A bare name is already one, and a reference directly under
 * `skills/` is its last segment. Anything else — another directory, an absolute path, a nested item —
 * names no item the store can hold, so it is reported rather than turned into a name that would make
 * the whole document unreadable.
 */
const skillItemOf = (reference: string): string | undefined => {
  const segments = canonicalAssetReference(reference).split('/');
  const item =
    segments.length === 1 ? segments[0] : segments.length === 2 && segments[0] === 'skills' ? segments[1] : undefined;
  return item !== undefined && SafeNameSchema.safeParse(item).success ? item : undefined;
};

const isAgentRuntime = (account: ResolvedAccount, routeMode: string | undefined): boolean =>
  account.mode === 'auto' || (account.variant === 'auto' && routeMode === undefined);

/**
 * Convert a parsed version-1 configuration into the version-2 model. Pure and total: it never throws
 * on a configuration `FleetConfigSchema` accepted.
 */
export function convertLegacyConfig(config: FleetConfig, options: LegacyConversionOptions = {}): LegacyConversion {
  const notes: LegacyConversionNote[] = [];
  const note = (path: readonly (string | number)[], message: string): void => {
    notes.push({ path, message });
  };

  const accounts = resolveAccounts(config);
  const routePaths = new Map<string, { path: (string | number)[]; mode: string | undefined }>();
  config.agents.forEach((agent, agentIndex) => {
    for (const [variant, route] of Object.entries(agent.routes)) {
      routePaths.set(route.id, { path: ['agents', agentIndex, 'routes', variant], mode: route.mode });
    }
  });
  const routeOf = (account: ResolvedAccount) =>
    routePaths.get(account.id) ?? { path: ['agents'] as (string | number)[], mode: undefined };

  // ── Credentials: one per `<kind>:<identity>` group ──────────────────────────────────────────────
  const credentialIds = new Set<string>();
  const credentials: Record<string, NonNullable<AccountModelDocument['credentials']>[string]> = {};
  const credentialOrigins: Record<string, LegacyCredentialOrigin> = {};
  const credentialOfAccount = new Map<string, string>();
  /** The variables each account's credential owns, so they are not repeated in its settings. */
  const credentialVariables = new Map<string, ReadonlySet<string>>();
  const hostTaken = new Set<HarnessKind>();

  for (const [key, members] of groupByIdentity(accounts)) {
    const first = members[0] as ResolvedAccount;
    const origin: LegacyCredentialOrigin = {
      key,
      harness: first.kind,
      identity: first.identity,
      routeIds: members.map(member => member.id),
    };
    const id = claimName(credentialIds, slugName(`${first.kind}-${first.identity}`, first.kind));
    credentialOrigins[id] = origin;

    const env: Record<string, string> = {};
    let undeclared = false;
    for (const member of members) {
      credentialOfAccount.set(member.id, id);
      const owned = new Set(HARNESS_CREDENTIAL_ENV[member.kind].filter(name => member.env[name] !== undefined));
      credentialVariables.set(member.id, owned);
      const source = credentialSourceOf(member, config.secretsFile);
      if (source.source === 'undeclared') undeclared = true;
      for (const name of owned) {
        const value = member.env[name] as string;
        if (env[name] === undefined) env[name] = value;
        else if (env[name] !== value) {
          note(
            routeOf(member).path,
            `${member.wrapper} sets ${name} differently from the other runtimes on login ${id}; the first value is kept`,
          );
        }
      }
    }

    if (Object.keys(env).length > 0) {
      credentials[id] = { harness: first.kind, store: 'environment', env };
      continue;
    }
    if (undeclared) {
      note(
        routeOf(first).path,
        `login ${id} is declared "auth: api-key" but nothing says where its key comes from, so it becomes a login that needs sign-in`,
      );
    }
    let store: CredentialStore = 'ferretry';
    if (options.isHostLogin?.(origin) === true) {
      if (hostTaken.has(first.kind)) {
        note(
          routeOf(first).path,
          `login ${id} would be a second ${first.kind} login shared with your terminal, and a machine has one — it is kept by Ferretry instead`,
        );
      } else {
        hostTaken.add(first.kind);
        store = 'host';
      }
    }
    credentials[id] = { harness: first.kind, store };
  }

  // ── Runtime names: the wrapper, kept whenever it already is one ─────────────────────────────────
  const runtimeNames = new Set<string>();
  const runtimeOfAccount = new Map<string, string>();
  for (const account of accounts) {
    const name = claimName(runtimeNames, slugName(account.wrapper, `${account.kind}-runtime`));
    runtimeOfAccount.set(account.id, name);
    if (name !== account.wrapper) {
      note(
        routeOf(account).path,
        `${account.wrapper} is named ${name} as a runtime (letters, digits and dashes only); the old name still starts it`,
      );
    }
  }

  // ── Agent permissions: skip only when EVERY agent runtime already skipped them ──────────────────
  const agentAccounts = accounts.filter(account => isAgentRuntime(account, routeOf(account).mode));
  const skips = (account: ResolvedAccount): boolean =>
    account.flags.some(flag => LEGACY_SKIP_PERMISSION_FLAGS[account.kind].includes(flag));
  const agentPermissions: AgentPermissions = agentAccounts.length > 0 && agentAccounts.every(skips) ? 'skip' : 'auto';
  if (agentPermissions === 'auto') {
    for (const account of agentAccounts.filter(skips)) {
      note(
        routeOf(account).path,
        `${account.wrapper} skipped every permission check, but not every agent runtime did, so agents use Auto mode; choose "Skip all permission checks" in Agent permissions to keep the old behaviour`,
      );
    }
  }

  // ── Components and profiles, one flat profile per distinct resolved route ───────────────────────
  const instructions = new ComponentRegistry<{ file: string }>();
  const skills = new ComponentRegistry<{ items: string[] }>();
  const settings = new ComponentRegistry<{
    harness: HarnessKind;
    file?: string;
    flags?: string[];
    env?: Record<string, string>;
    body?: SettingsObject;
  }>();
  const hooks = new ComponentRegistry<{ harness: HarnessKind; file?: string; directory?: string }>();
  const modelSets = new ComponentRegistry<{ models: string[]; default: string }>();

  const profileNames = new Set<string>();
  const profileByLayers = new Map<string, string>();
  const profiles: Record<string, { layers: LayerReferenceText[] }> = {};
  const pendingByFile = new Map<string, { harness: HarnessKind; file: string; profiles: Set<string> }>();
  const runtimes: Record<string, { credential: string; profile: string; agent: boolean }> = {};
  const runtimeOrigins: Record<string, LegacyRuntimeOrigin> = {};

  for (const account of accounts) {
    const { path, mode } = routeOf(account);
    const runtime = runtimeOfAccount.get(account.id) as string;
    const harness = account.kind;
    const delivered = deliveredFields(harness);
    const agent = isAgentRuntime(account, mode);
    const layers: LayerReferenceText[] = [];
    let mcpFile: string | undefined;

    const undelivered = (field: AssetField, value: string): void => {
      note([...path], `${field} "${value}" had no effect on ${harness} in version 1, so it is not carried`);
    };

    if (account.memory !== undefined) {
      const name = instructions.use(
        `${canonicalAssetReference(account.memory)}`,
        sharedNameFor(config.shared.memory, account.memory) ?? slugName(stemOf(account.memory), 'instructions'),
        { file: account.memory },
        harness,
      );
      layers.push(`instructions/${name}`);
    }

    const items: string[] = [];
    for (const reference of account.skills ?? []) {
      const item = skillItemOf(reference);
      if (item === undefined) {
        note(
          [...path],
          `skill "${reference}" is not a skill in the skills folder, which is the only place a skill can be selected from, so it is not carried`,
        );
      } else if (!items.includes(item)) items.push(item);
    }
    if (items.length > 0) {
      const name = skills.use(keyOf([...items].sort()), `${runtime}-skills`, { items }, harness);
      layers.push(`skills/${name}`);
    }

    for (const layer of account.settings as readonly SettingsLayer[]) {
      if (typeof layer === 'string') {
        const name = settings.use(
          `${harness}:file:${canonicalAssetReference(layer)}`,
          sharedNameFor(config.shared.settings, layer) ??
            slugName(`${harness}-${stemOf(layer)}`, `${harness}-settings`),
          { harness, file: layer },
          harness,
        );
        layers.push(`settings/${name}`);
        continue;
      }
      const name = settings.use(
        `${harness}:body:${keyOf(layer)}`,
        `${runtime}-settings`,
        { harness, body: layer },
        harness,
      );
      layers.push(`settings/${name}`);
    }

    // Launch flags and environment (K4). The permission flags and the fixed-layer flags of an agent
    // runtime come back through Agent permissions and the fixed layer, so only those are removed.
    const removed = agent ? [...LEGACY_SKIP_PERMISSION_FLAGS[harness], ...LEGACY_FIXED_LAYER_FLAGS[harness]] : [];
    const flags = account.flags.filter(flag => !removed.includes(flag));
    const owned = credentialVariables.get(account.id) ?? new Set<string>();
    const env = Object.fromEntries(sortedEntries(account.env).filter(([name]) => !owned.has(name)));
    if (flags.length > 0 || Object.keys(env).length > 0) {
      const launch = {
        harness,
        ...(flags.length === 0 ? {} : { flags }),
        ...(Object.keys(env).length === 0 ? {} : { env }),
      };
      const name = settings.use(`${harness}:launch:${keyOf(launch)}`, `${runtime}-launch`, launch, harness);
      layers.push(`settings/${name}`);
    }

    for (const [field, value] of [
      ['hooks', account.hooks],
      ['hooksDir', account.hooksDir],
    ] as const) {
      if (value === undefined) continue;
      if (!delivered.has(field)) {
        undelivered(field, value);
        continue;
      }
      const hook = field === 'hooks' ? { harness, file: value } : { harness, directory: value };
      const name = hooks.use(
        `${harness}:${field}:${canonicalAssetReference(value)}`,
        slugName(`${harness}-${stemOf(value)}`, `${harness}-hooks`),
        hook,
        harness,
      );
      layers.push(`hooks/${name}`);
    }

    if (account.mcp !== undefined) {
      if (delivered.has('mcp')) mcpFile = account.mcp;
      else undelivered('mcp', account.mcp);
    }

    const available = account.models.filter(model => model.available).map(model => model.id);
    for (const model of account.models) {
      if (!model.available) {
        note(
          [...path, 'models'],
          `model ${model.id} was declared unavailable (${model.unavailableReason}) and is left out`,
        );
      }
    }
    if (available.length > 0) {
      const chosen =
        account.defaultModel !== null && available.includes(account.defaultModel)
          ? account.defaultModel
          : (available[0] as string);
      const set = { models: available, default: chosen };
      const name = modelSets.use(keyOf(set), `${harness}-models`, set, harness);
      layers.push(`modelSets/${name}`);
    }

    if (!account.available) {
      note(
        [...path],
        `${account.wrapper} was declared unavailable (${account.unavailableReason}); runtimes have no such switch`,
      );
    }
    if (account.displayName !== account.wrapper) {
      note(
        [...path, 'displayName'],
        `display name "${account.displayName}" is not carried; a runtime is shown by its name`,
      );
    }

    const layersKey = keyOf(layers);
    let profile = profileByLayers.get(layersKey);
    if (profile === undefined || mcpFile !== undefined) {
      // A route with an MCP file gets a profile of its own, because its servers are added to it later.
      profile = claimName(profileNames, runtime);
      profiles[profile] = { layers };
      if (mcpFile === undefined) profileByLayers.set(layersKey, profile);
    }
    if (mcpFile !== undefined) {
      const fileKey = `${harness}:${canonicalAssetReference(mcpFile)}`;
      const pending = pendingByFile.get(fileKey) ?? { harness, file: mcpFile, profiles: new Set<string>() };
      pending.profiles.add(profile);
      pendingByFile.set(fileKey, pending);
    }

    runtimes[runtime] = {
      credential: credentialOfAccount.get(account.id) as string,
      profile,
      agent,
    };
    runtimeOrigins[runtime] = {
      routeId: account.id,
      wrapper: account.wrapper,
      home: account.home,
      agent: account.agent,
      variant: account.variant,
      harness,
    };
  }

  if (accounts.length > 0) {
    note(['profiles'], 'each runtime gets one flat profile holding what it used; you can split it into layers later');
  }

  // ── Advanced, and what has no place in version 2 ────────────────────────────────────────────────
  const commandNames = new Set(runtimeNames);
  const commands = config.commands.flatMap((command, index) => {
    const target = runtimeOfAccount.get(command.target);
    // A target the configuration accepted is always a declared route, so this never drops one.
    if (target === undefined) return [];
    const wrapper = claimName(commandNames, slugName(command.wrapper, `${target}-command`));
    if (wrapper !== command.wrapper) {
      note(
        ['commands', index, 'wrapper'],
        `command ${command.wrapper} is named ${wrapper} (letters, digits and dashes only)`,
      );
    }
    return [{ wrapper, runtime: target, flags: [...command.flags] }];
  });

  if (config.health.enabled) {
    note(['health', 'enabled'], "health probes are gone; a login's status comes from free usage reads instead");
  }
  for (const [harness, id] of sortedEntries(config.defaultHomes)) {
    if (id === undefined) continue;
    note(
      ['defaultHomes', harness],
      `the bare ${harness} command is no longer pointed at a runtime; your own ${harness} keeps its own setup`,
    );
  }
  for (const [harness, shared] of sortedEntries(config.sharedHistory)) {
    if (!shared) {
      note(['sharedHistory', harness], `history is now shared by every ${harness} runtime`);
    }
  }

  const settingsBodies: GeneratedSettingsBody[] = [];
  const settingsDocument: Record<
    string,
    { harness: HarnessKind; file?: string; flags?: string[]; env?: Record<string, string> }
  > = {};
  for (const { name, value } of settings.entries()) {
    const { body, ...rest } = value;
    if (body === undefined) {
      settingsDocument[name] = rest;
      continue;
    }
    const format = settingsFormatOf(value.harness);
    const file = `components/settings/${name}.${format}`;
    settingsDocument[name] = { harness: value.harness, file };
    settingsBodies.push({ component: name, harness: value.harness, file, format, content: body });
  }

  const document: AccountModelDocument = {
    version: 2,
    machine: { agentPermissions },
    credentials,
    components: {
      instructions: Object.fromEntries(
        instructions
          .entries()
          .map(({ name, value, harnesses }) => [
            name,
            harnesses.size === 1 ? { ...value, harness: [...harnesses][0] as HarnessKind } : value,
          ]),
      ),
      skills: Object.fromEntries(skills.entries().map(({ name, value }) => [name, value])),
      settings: settingsDocument,
      hooks: Object.fromEntries(hooks.entries().map(({ name, value }) => [name, value])),
      modelSets: Object.fromEntries(modelSets.entries().map(({ name, value }) => [name, value])),
    },
    profiles,
    runtimes,
    advanced: {
      ...(config.secretsFile === undefined ? {} : { secretsFile: config.secretsFile }),
      aliases: config.aliases,
      commands,
      usage: config.usage,
    },
  };

  return {
    model: AccountModelSchema.parse(document),
    runtimes: runtimeOrigins,
    credentials: credentialOrigins,
    settingsBodies,
    pendingMcp: [...pendingByFile.values()].map(pending => ({
      harness: pending.harness,
      file: pending.file,
      profiles: [...pending.profiles],
    })),
    notes,
  };
}

// ── The compatibility read ───────────────────────────────────────────────────────────────────────

/**
 * A fleet document, read whichever version it is.
 *
 * A version-1 document keeps its parsed {@link FleetConfig}, because every consumer that has not moved
 * to the new model still runs on it (§13.3 "Old and new coexist"), and carries its conversion for
 * every consumer that has.
 */
export type FleetDocument =
  | { readonly version: 1; readonly config: FleetConfig; readonly conversion: LegacyConversion }
  | { readonly version: 2; readonly model: AccountModel };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read an untrusted fleet document of either version. Throws a `ZodError` exactly as the version's own
 * schema would.
 *
 * The version is the document's `version` key: absent or `1` is version 1 (no version-1 file ever
 * wrote one), and anything else is checked against version 2, which names the value it expected.
 * An empty file is an empty version-1 fleet, exactly as today.
 */
export function readFleetDocument(raw: unknown, options: LegacyConversionOptions = {}): FleetDocument {
  if (isRecord(raw) && raw.version !== undefined && raw.version !== 1) {
    return { version: 2, model: parseAccountModel(raw) };
  }
  const { version: _version, ...legacy } = isRecord(raw) ? raw : {};
  const config = FleetConfigSchema.parse(isRecord(raw) ? legacy : (raw ?? {}));
  return { version: 1, config, conversion: convertLegacyConfig(config, options) };
}
