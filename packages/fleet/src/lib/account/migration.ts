/**
 * Migration — a version-1 install as the version-2 one it becomes (docs/design/account-model.md §10).
 *
 * `./legacy.ts` is the mapping, and this module never restates it: the configuration it plans is the
 * conversion `convertLegacyConfig` returns, and every note the conversion makes is in the dry run.
 * What this adds is what the mapping cannot know, because it is about what is ON DISK:
 *
 * - **Which login each credential keeps.** Today's homes hold COPIED credentials — several homes
 *   holding one refresh token — and version 2 keeps a credential exactly once (C1). So each version-1
 *   group becomes one credential, and exactly one copy survives as it:
 *   - the person's own login (`store: host`) when it is readable and seed provenance says EVERY copy
 *     in the group is still the unchanged copy a first run took of it — the copies then retire;
 *   - otherwise the FRESHEST copy (Claude: the latest access-token expiry; Codex: the latest
 *     `last_refresh`, which under single-use rotation is the only one still alive), moved into
 *     Ferretry's store, and only then the others retire.
 * - **What is refused.** A copy that could not be read makes "the freshest" a guess, and a wrong
 *   guess signs somebody out, so the whole migration waits until it can be read. A live session on an
 *   affected login is refused too (§9.2): the harness could be writing the copy being moved.
 * - **Where each runtime's ids come from.** A runtime keeps its route's UUID and its old config
 *   directory (`ids.json` R6, §10.2.5), and its old wrapper name keeps starting it.
 *
 * NEVER A REFRESH. Nothing here, and nothing the executor does, renews a token: a refresh rotates a
 * single-use Codex token, and a rotation during a migration signs out every copy not yet moved.
 * Freshness is read from what each copy already says about itself.
 *
 * Pure: the readings come from the executor (`../../adapters/migration-executor.ts`), which is the
 * only side that ever holds credential material. Nothing here receives a token, only verdicts,
 * instants and opaque digests.
 */
import { z } from 'zod';
import { type FleetConfig, FleetConfigSchema } from '../config.ts';
import { type HarnessKind, HarnessKindSchema } from '../manifest.ts';
import { expandHomePath } from '../paths.ts';
import type { CredentialState } from '../identity.ts';
import { resolveAccounts } from '../profiles.ts';
import type { FleetLayout } from '../provisioning.ts';
import { decideSeedProvenance, type FleetSeedProvenanceRecord } from '../seed-provenance.ts';
import { parseRuntimeIds, RUNTIME_IDS_VERSION, type RuntimeIdEntry } from './ids.ts';
import {
  convertLegacyConfig,
  type LegacyConversion,
  type LegacyConversionNote,
  type LegacyCredentialOrigin,
  slugName,
} from './legacy.ts';
import {
  type AccountModel,
  AccountModelSchema,
  type CredentialStore,
  CredentialStoreSchema,
  type LayerReferenceText,
  type McpComponent,
  McpComponentSchema,
} from './schema.ts';

// ── What the executor surveys ────────────────────────────────────────────────────────────────────

/**
 * What one version-1 home holds, as verdicts. The material stays in the executor.
 *
 * `freshness` is the instant that decides which copy survives — see the module note — and is absent
 * when the copy says nothing about it.
 */
export interface MigrationHomeReading {
  /** The route's UUID. */
  readonly accountId: string;
  readonly harness: HarnessKind;
  /** Absolute config directory. */
  readonly home: string;
  readonly state: CredentialState;
  readonly reason?: string;
  readonly freshness?: number;
  /** The opaque digest of the copy, for the provenance comparison and the read-back. */
  readonly fingerprint?: string;
  /** Every place a copy of this home's credential exists, each retired after the move. */
  readonly copies: readonly MigrationCopyLocation[];
  /** A Codex `auth.json` that is already a link (a resumed migration): not a copy, nothing to retire. */
  readonly linkedTo?: string;
}

/** The person's own login for one harness, read through `store: host` (C3). */
export interface MigrationHostReading {
  readonly harness: HarnessKind;
  /** The directory the login lives in, for the report. */
  readonly directory: string;
  readonly state: CredentialState;
  readonly fingerprint?: string;
  /** Why the host login could not be used, when it cannot (a Codex host on keyring storage, G5). */
  readonly unavailable?: string;
}

/** A session the daemon says is running, so its login is not moved under it. */
export interface MigrationLiveSession {
  readonly session: string;
  readonly accountId: string;
}

/** An MCP list file version 1 referenced, as the executor read it. */
export type MigrationMcpFile =
  | { readonly ok: true; readonly servers: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };

export interface MigrationSurvey {
  /** The version-1 document, untrusted (its `config.yaml`, or the backup a resumed migration kept). */
  readonly document: unknown;
  readonly layout: FleetLayout;
  readonly homes: readonly MigrationHomeReading[];
  readonly host: Readonly<Partial<Record<HarnessKind, MigrationHostReading>>>;
  readonly provenance: readonly FleetSeedProvenanceRecord[];
  readonly liveSessions: readonly MigrationLiveSession[];
  /** Each `PendingMcpList` file, by the reference version 1 spelled it with. */
  readonly mcpFiles: Readonly<Record<string, MigrationMcpFile>>;
  /** Whether this machine keeps Claude logins in the keychain (macOS). */
  readonly keychain: boolean;
}

// ── What the plan says ───────────────────────────────────────────────────────────────────────────
//
// Each decision is a schema as well as a type, because the executor saves the APPROVED plan and a
// resumed migration finishes that plan rather than re-planning a half-moved machine — which would
// find the moved copies gone and decide something else.

const Text = z.string().min(1);

/** Where one credential copy sits: a file, or (macOS Claude) a keychain item named for a home. */
export const MigrationCopyLocationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: Text }),
  z.strictObject({ kind: z.literal('keychain'), service: Text }),
]);
export type MigrationCopyLocation = z.infer<typeof MigrationCopyLocationSchema>;

/** One copy that stops being a login: moved to `retired/` (or, for a keychain item, listed for purge). */
export const MigrationRetirementSchema = z.strictObject({
  accountId: Text,
  wrapper: Text,
  home: Text,
  copy: MigrationCopyLocationSchema,
});
export type MigrationRetirement = z.infer<typeof MigrationRetirementSchema>;

/** Which login a credential keeps, and why. */
export const MigrationCredentialSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host'), directory: z.string(), signedIn: z.boolean(), reason: Text }),
  z.strictObject({
    kind: z.literal('copy'),
    accountId: Text,
    wrapper: Text,
    home: Text,
    fingerprint: Text,
    reason: Text,
  }),
  z.strictObject({ kind: z.literal('empty'), reason: Text }),
  z.strictObject({ kind: z.literal('environment') }),
]);
export type MigrationCredentialSource = z.infer<typeof MigrationCredentialSourceSchema>;

export const MigrationCredentialDecisionSchema = z.strictObject({
  id: Text,
  harness: HarnessKindSchema,
  store: CredentialStoreSchema,
  source: MigrationCredentialSourceSchema,
  retire: z.array(MigrationRetirementSchema),
  /** Codex homes whose `auth.json` becomes a link to the one file (§8.2.1). */
  link: z.array(Text),
  /** The runtimes that use it, by name. */
  runtimes: z.array(Text),
});
export type MigrationCredentialDecision = z.infer<typeof MigrationCredentialDecisionSchema>;

export const MigrationRuntimeDecisionSchema = z.strictObject({
  name: Text,
  id: Text,
  /** The wrapper it was launched as; it keeps resolving when it differs from `name`. */
  wrapper: Text,
  credential: Text,
  agent: z.boolean(),
  /** Its config directory, absolute. Nothing moves. */
  home: Text,
});
export type MigrationRuntimeDecision = z.infer<typeof MigrationRuntimeDecisionSchema>;

/** A settings body the conversion turned into a file (`GeneratedSettingsBody`). */
export const MigrationSettingsBodySchema = z.strictObject({
  component: Text,
  harness: HarnessKindSchema,
  file: Text,
  format: z.enum(['json', 'toml']),
  content: z.record(z.string(), z.unknown()),
});

/**
 * What a person approved, kept by the executor until the migration finishes: everything it needs to
 * do, and nothing it would have to re-read from a machine it is halfway through changing.
 */
export const MigrationApprovedPlanSchema = z.strictObject({
  digest: Text,
  model: z.unknown().transform(value => AccountModelSchema.parse(value)),
  ids: z.unknown().transform(value => parseRuntimeIds(value)),
  credentials: z.array(MigrationCredentialDecisionSchema),
  runtimes: z.array(MigrationRuntimeDecisionSchema),
  historyPooled: z.array(HarnessKindSchema),
  settingsBodies: z.array(MigrationSettingsBodySchema),
});
export type MigrationApprovedPlan = z.infer<typeof MigrationApprovedPlanSchema>;

/** Why the migration cannot run now, each naming what to do about it. */
export interface MigrationBlocker {
  readonly message: string;
}

export interface MigrationPlan extends MigrationApprovedPlan {
  readonly conversion: LegacyConversion;
  /** Every note: the conversion's, then this module's own. */
  readonly notes: readonly LegacyConversionNote[];
  readonly blockers: readonly MigrationBlocker[];
}

/** The part of a plan the executor saves and a resumed migration finishes. */
export function approvedPlanOf(plan: MigrationPlan): MigrationApprovedPlan {
  return {
    digest: plan.digest,
    model: plan.model,
    ids: plan.ids,
    credentials: plan.credentials,
    runtimes: plan.runtimes,
    historyPooled: plan.historyPooled,
    settingsBodies: plan.settingsBodies,
  };
}

// ── Decisions ────────────────────────────────────────────────────────────────────────────────────

const USABLE: ReadonlySet<CredentialState> = new Set(['valid', 'refreshable']);

const sameDirectory = (left: string, right: string): boolean =>
  left.replace(/\/+$/u, '') === right.replace(/\/+$/u, '');

/**
 * The copy that survives, or `undefined` when none is usable: the latest freshness, then a valid one
 * over a merely renewable one, then the route id, so the same survey always names the same copy.
 */
export function freshestCopy(homes: readonly MigrationHomeReading[]): MigrationHomeReading | undefined {
  const usable = homes.filter(home => USABLE.has(home.state) && home.fingerprint !== undefined);
  return usable.toSorted(
    (left, right) =>
      (right.freshness ?? -1) - (left.freshness ?? -1) ||
      Number(right.state === 'valid') - Number(left.state === 'valid') ||
      (left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0),
  )[0];
}

/**
 * Whether every copy in a group is still the unchanged copy a first run took of the person's own
 * login (§10.2.1). Absence of a record is never evidence (`../seed-provenance.ts`), so a copy with no
 * record — or one whose home changed since — answers no.
 */
export function everyCopyIsSeeded(
  homes: readonly MigrationHomeReading[],
  provenance: readonly FleetSeedProvenanceRecord[],
): boolean {
  const withCopies = homes.filter(home => home.copies.length > 0);
  if (withCopies.length === 0) return false;
  const records = new Map(provenance.map(record => [record.accountId, record]));
  return withCopies.every(home => {
    const record = records.get(home.accountId);
    if (record === undefined || record.seededFrom !== `host:${home.harness}`) return false;
    return decideSeedProvenance(record, home.fingerprint)?.state === 'seeded_copy';
  });
}

const freshnessWord = (harness: HarnessKind): string =>
  harness === 'claude' ? 'the latest expiry' : 'the latest refresh';

interface GroupFacts {
  readonly origin: LegacyCredentialOrigin;
  readonly homes: readonly MigrationHomeReading[];
  /** A home that IS the person's own harness directory: its login is theirs and never moves. */
  readonly hostHome: boolean;
}

const sortedKeys = <V>(record: Readonly<Record<string, V>>): string[] => Object.keys(record).toSorted();

/** A stable digest text: insertion order never changes it. */
function stableText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${sortedKeys(record)
      .filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableText(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digestOf(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(stableText(value)).digest('hex').slice(0, 16);
}

/** MCP servers read from one file, as components, or the note saying why one was not carried. */
function mcpComponentsOf(
  file: string,
  harness: HarnessKind,
  read: MigrationMcpFile | undefined,
  note: (message: string) => void,
): Record<string, McpComponent> {
  if (read === undefined || !read.ok) {
    note(`MCP servers in "${file}" could not be read (${read?.ok === false ? read.reason : 'not found'}), so none are carried; add them again as MCP servers`);
    return {};
  }
  const servers: Record<string, McpComponent> = {};
  for (const name of sortedKeys(read.servers)) {
    const { type: _transport, ...server } = (read.servers[name] ?? {}) as Record<string, unknown>;
    const parsed = McpComponentSchema.safeParse({ ...server, harness });
    if (parsed.success) servers[name] = parsed.data;
    else note(`MCP server "${name}" in "${file}" is not one a runtime can start or reach, so it is not carried`);
  }
  return servers;
}

/** The conversion's model with each pending MCP file's servers added as components and layers. */
function withMcpServers(
  conversion: LegacyConversion,
  files: Readonly<Record<string, MigrationMcpFile>>,
  note: (path: readonly (string | number)[], message: string) => void,
): AccountModel {
  const mcp: Record<string, McpComponent> = { ...conversion.model.components.mcp };
  const profiles: Record<string, { layers: LayerReferenceText[] }> = Object.fromEntries(
    Object.entries(conversion.model.profiles).map(([name, profile]) => [name, { layers: [...profile.layers] }]),
  );
  const taken = new Set(Object.keys(mcp));
  for (const pending of conversion.pendingMcp) {
    const servers = mcpComponentsOf(pending.file, pending.harness, files[pending.file], message =>
      note(['mcp', pending.file], message),
    );
    for (const [server, component] of Object.entries(servers)) {
      let name = slugName(server, 'mcp-server');
      // One server name per file and harness; the same name from another file or harness gets `-2`.
      for (let suffix = 2; taken.has(name) && JSON.stringify(mcp[name]) !== JSON.stringify(component); suffix++) {
        name = `${slugName(server, 'mcp-server')}-${suffix}`;
      }
      taken.add(name);
      mcp[name] = component;
      for (const profile of pending.profiles) {
        const layers = profiles[profile]?.layers;
        if (layers !== undefined && !layers.includes(`mcp/${name}`)) layers.push(`mcp/${name}`);
      }
    }
  }
  return AccountModelSchema.parse({ ...conversion.model, components: { ...conversion.model.components, mcp }, profiles });
}

/**
 * Plan the migration of one surveyed machine. Pure and total for any version-1 document the schema
 * accepts; throws the schema's `ZodError` for one it refuses.
 */
export function planMigration(survey: MigrationSurvey): MigrationPlan {
  const config: FleetConfig = FleetConfigSchema.parse(
    survey.document !== null && typeof survey.document === 'object'
      ? (({ version: _version, ...rest }) => rest)(survey.document as Record<string, unknown>)
      : (survey.document ?? {}),
  );
  const { layout } = survey;
  const blockers: MigrationBlocker[] = [];
  const notes: LegacyConversionNote[] = [];
  const note = (path: readonly (string | number)[], message: string): void => {
    notes.push({ path, message });
  };

  const homeOf = new Map(survey.homes.map(home => [home.accountId, home]));
  const accounts = resolveAccounts(config);
  const wrapperOf = new Map(accounts.map(account => [account.id, account.wrapper]));
  const absoluteHome = new Map(
    accounts.map(account => [account.id, expandHomePath(account.home, layout.userHome, layout.homesDirectory)]),
  );
  const hostDirectory = (harness: HarnessKind): string | undefined =>
    survey.host[harness]?.directory ?? layout.defaultHomeDirectories[harness];

  // Pass one: what each group holds, so the host decision can be made before the mapping runs.
  const factsByKey = new Map<string, GroupFacts>();
  const factsOf = (origin: LegacyCredentialOrigin): GroupFacts => {
    const known = factsByKey.get(origin.key);
    if (known !== undefined) return known;
    const homes = origin.routeIds.flatMap(id => {
      const reading = homeOf.get(id);
      return reading === undefined ? [] : [reading];
    });
    const directory = hostDirectory(origin.harness);
    const hostHome =
      directory !== undefined &&
      origin.routeIds.some(id => sameDirectory(absoluteHome.get(id) ?? '', directory));
    const facts = { origin, homes, hostHome };
    factsByKey.set(origin.key, facts);
    return facts;
  };
  const hostUsable = (harness: HarnessKind): boolean => {
    const host = survey.host[harness];
    return host !== undefined && host.unavailable === undefined && USABLE.has(host.state) && host.fingerprint !== undefined;
  };
  const isHostLogin = (origin: LegacyCredentialOrigin): boolean => {
    const facts = factsOf(origin);
    if (facts.hostHome) return true;
    return hostUsable(origin.harness) && everyCopyIsSeeded(facts.homes, survey.provenance);
  };

  const conversion = convertLegacyConfig(config, { isHostLogin });
  notes.push(...conversion.notes);
  const model = withMcpServers(conversion, survey.mcpFiles, note);

  // ── Runtimes and ids ──────────────────────────────────────────────────────────────────────────
  const runtimes: MigrationRuntimeDecision[] = [];
  const idEntries: Record<string, RuntimeIdEntry> = {};
  for (const name of sortedKeys(conversion.runtimes)) {
    const origin = conversion.runtimes[name];
    const runtime = model.runtimes[name];
    if (origin === undefined || runtime === undefined) continue;
    idEntries[name] = {
      id: origin.routeId,
      formerNames: origin.wrapper === name ? [] : [origin.wrapper],
      home: origin.home,
    };
    runtimes.push({
      name,
      id: origin.routeId,
      wrapper: origin.wrapper,
      credential: runtime.credential,
      agent: runtime.agent,
      home: absoluteHome.get(origin.routeId) ?? origin.home,
    });
  }
  const ids = parseRuntimeIds({ version: RUNTIME_IDS_VERSION, runtimes: idEntries });

  // ── Credentials ───────────────────────────────────────────────────────────────────────────────
  const live = new Map<string, string[]>();
  for (const session of survey.liveSessions) {
    live.set(session.accountId, [...(live.get(session.accountId) ?? []), session.session]);
  }
  const runtimeNamesOf = (credential: string): string[] =>
    runtimes.filter(runtime => runtime.credential === credential).map(runtime => runtime.name);

  const credentials: MigrationCredentialDecision[] = [];
  for (const id of sortedKeys(conversion.credentials)) {
    const origin = conversion.credentials[id] as LegacyCredentialOrigin;
    const credential = model.credentials[id];
    if (credential === undefined) continue;
    const facts = factsOf(origin);
    const users = runtimeNamesOf(id);
    const sessions = origin.routeIds.flatMap(route => live.get(route) ?? []);
    if (sessions.length > 0 && credential.store !== 'environment') {
      blockers.push({
        message: `login ${id} is in use by running session${sessions.length === 1 ? '' : 's'} ${sessions.join(', ')}; stop ${sessions.length === 1 ? 'it' : 'them'} and run the migration again`,
      });
    }
    const hostDir = hostDirectory(origin.harness);
    const retirable = facts.homes.filter(
      home => !(hostDir !== undefined && sameDirectory(home.home, hostDir)) && home.copies.length > 0,
    );
    const retire = (homes: readonly MigrationHomeReading[]): MigrationRetirement[] =>
      homes.flatMap(home =>
        home.copies.map(copy => ({
          accountId: home.accountId,
          wrapper: wrapperOf.get(home.accountId) ?? home.accountId,
          home: home.home,
          copy,
        })),
      );
    const linkHomes = (store: CredentialStore): string[] =>
      origin.harness === 'codex' && store !== 'environment'
        ? facts.homes
            .filter(home => !(hostDir !== undefined && sameDirectory(home.home, hostDir)))
            .map(home => home.home)
        : [];

    if (credential.store === 'environment') {
      credentials.push({
        id,
        harness: origin.harness,
        store: 'environment',
        source: { kind: 'environment' },
        retire: [],
        link: [],
        runtimes: users,
      });
      continue;
    }

    const unreadable = facts.homes.filter(home => home.state === 'unreadable');
    for (const home of unreadable) {
      blockers.push({
        message: `the login copy in ${home.home} (${wrapperOf.get(home.accountId) ?? home.accountId}) could not be read${home.reason === undefined ? '' : ` (${home.reason})`}, so the freshest copy of login ${id} cannot be chosen safely; make it readable (unlock the keychain, fix its permissions) and run the migration again`,
      });
    }

    if (credential.store === 'host') {
      const host = survey.host[origin.harness];
      const fresher = freshestCopy(retirable);
      if (
        facts.hostHome &&
        fresher?.fingerprint !== undefined &&
        fresher.fingerprint !== host?.fingerprint &&
        (fresher.freshness ?? -1) > (facts.homes.find(home => hostDir !== undefined && sameDirectory(home.home, hostDir))?.freshness ?? -1)
      ) {
        // Retiring it would throw away the live login; writing it over the person's own would be
        // Ferretry changing their terminal's login. Neither is a migration's decision.
        blockers.push({
          message: `the copy in ${fresher.home} (${wrapperOf.get(fresher.accountId) ?? fresher.accountId}) is newer than your own ${origin.harness} login in ${hostDir ?? 'your home'}, which login ${id} shares; sign your own ${origin.harness} in again, or remove that runtime, and run the migration again`,
        });
      }
      if (facts.hostHome && !hostUsable(origin.harness)) {
        note(
          ['credentials', id],
          `login ${id} is your own ${origin.harness} login, which is not signed in; it stays where it is and needs sign-in`,
        );
      }
      const directory = hostDir ?? '';
      credentials.push({
        id,
        harness: origin.harness,
        store: 'host',
        source: {
          kind: 'host',
          directory,
          signedIn: hostUsable(origin.harness),
          reason: facts.hostHome
            ? `a runtime already used your own ${origin.harness} directory, so the login stays shared with your terminal`
            : `every copy is still the unchanged copy taken from your own ${origin.harness} login, so Ferretry shares that login instead of keeping copies`,
        },
        retire: retire(retirable),
        link: linkHomes('host'),
        runtimes: users,
      });
      continue;
    }

    if (facts.hostHome) {
      // The mapping refused a second `host` for this harness (C4) — moving a login out of the
      // person's own directory would sign their terminal out, so this is refused instead.
      blockers.push({
        message: `login ${id} lives in your own ${origin.harness} directory, but another login is already shared with your terminal; give one of them its own home first`,
      });
    }
    const kept = freshestCopy(facts.homes);
    const source: MigrationCredentialSource =
      kept === undefined || kept.fingerprint === undefined
        ? {
            kind: 'empty',
            reason:
              facts.homes.length === 0
                ? 'no runtime of this login had a config directory to read'
                : 'no copy holds a usable login',
          }
        : {
            kind: 'copy',
            accountId: kept.accountId,
            wrapper: wrapperOf.get(kept.accountId) ?? kept.accountId,
            home: kept.home,
            fingerprint: kept.fingerprint,
            reason:
              facts.homes.filter(home => USABLE.has(home.state)).length === 1
                ? 'the only usable copy'
                : `the freshest copy (${freshnessWord(origin.harness)})`,
          };
    if (source.kind === 'empty') {
      note(['credentials', id], `login ${id} has no usable copy (${source.reason}); it needs sign-in after the migration`);
    }
    credentials.push({
      id,
      harness: origin.harness,
      store: 'ferretry',
      source,
      retire: retire(retirable),
      link: linkHomes('ferretry'),
      runtimes: users,
    });
  }

  for (const decision of credentials) {
    if (decision.harness === 'claude' && survey.keychain) {
      const items = decision.retire.filter(item => item.copy.kind === 'keychain');
      if (items.length > 0) {
        note(
          ['credentials', decision.id],
          `${items.length} keychain item${items.length === 1 ? '' : 's'} holding old copies of login ${decision.id} stay until you purge retired logins`,
        );
      }
    }
  }

  const historyPooled = (['claude', 'codex'] as const).filter(
    harness => !config.sharedHistory[harness] && runtimes.some(runtime => model.credentials[runtime.credential]?.harness === harness),
  );

  const approved = {
    model,
    ids,
    credentials,
    runtimes,
    historyPooled,
    settingsBodies: conversion.settingsBodies.map(body => ({ ...body, content: { ...body.content } })),
  };
  return { ...approved, digest: digestOf(approved), conversion, notes, blockers };
}

// ── The dry run ──────────────────────────────────────────────────────────────────────────────────

const STORE_WORDS: Readonly<Record<CredentialStore, string>> = {
  host: 'shared with your terminal',
  ferretry: 'kept by Ferretry',
  environment: 'set by environment',
};

const describeCopy = (copy: MigrationCopyLocation): string =>
  copy.kind === 'file' ? copy.path : `keychain item "${copy.service}"`;

const pathText = (path: readonly (string | number)[]): string =>
  path.length === 0 ? '' : ` [${path.map(String).join('.')}]`;

/**
 * The dry run, as lines for a terminal or a browser: every login and which copy it keeps and why,
 * every copy that retires, every runtime with its old and new names, the history that becomes shared,
 * every note the conversion made, what blocks it, and the new `config.yaml`.
 */
export function renderMigrationDryRun(plan: MigrationPlan, configText: string): readonly string[] {
  const lines: string[] = [];
  lines.push('Migrating this machine to the new account format');
  lines.push('');
  lines.push('Logins:');
  for (const credential of plan.credentials) {
    lines.push(`  ${credential.id} (${credential.harness}, ${STORE_WORDS[credential.store]})`);
    const { source } = credential;
    if (source.kind === 'host') lines.push(`    keeps: your own login in ${source.directory} — ${source.reason}`);
    else if (source.kind === 'copy') {
      lines.push(`    keeps: the copy from ${source.wrapper} (${source.home}) — ${source.reason}; it moves into Ferretry's store`);
    } else if (source.kind === 'empty') lines.push(`    keeps: nothing — ${source.reason}; needs sign-in`);
    else lines.push('    keeps: its environment variables; nothing to move');
    for (const item of credential.retire) lines.push(`    retires: ${describeCopy(item.copy)} (${item.wrapper})`);
    for (const home of credential.link) lines.push(`    links: ${home}/auth.json to the one login file`);
    lines.push(`    used by: ${credential.runtimes.length === 0 ? 'no runtime' : credential.runtimes.join(', ')}`);
  }
  lines.push('');
  lines.push('Runtimes:');
  for (const runtime of plan.runtimes) {
    const renamed = runtime.wrapper === runtime.name ? '' : ` (was ${runtime.wrapper}, which still starts it)`;
    lines.push(
      `  ${runtime.name}${renamed} — login ${runtime.credential}${runtime.agent ? ', launched as an agent' : ''}; its settings folder stays at ${runtime.home}`,
    );
  }
  lines.push('');
  lines.push(
    plan.historyPooled.length === 0
      ? 'History: already shared.'
      : `History: ${plan.historyPooled.join(' and ')} conversations become shared by every runtime of that tool.`,
  );
  if (plan.notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const entry of plan.notes) lines.push(`  - ${entry.message}${pathText(entry.path)}`);
  }
  if (plan.blockers.length > 0) {
    lines.push('');
    lines.push('Cannot migrate yet:');
    for (const blocker of plan.blockers) lines.push(`  - ${blocker.message}`);
  }
  lines.push('');
  lines.push('The new config.yaml:');
  for (const line of configText.replace(/\n$/u, '').split('\n')) lines.push(`  ${line}`);
  lines.push('');
  lines.push(`Plan ${plan.digest}. Nothing has been changed.`);
  return lines;
}

