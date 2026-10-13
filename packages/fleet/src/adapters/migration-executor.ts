/**
 * The migration executor — `fy fleet migrate`'s survey, dry run, apply, resume and purge
 * (docs/design/account-model.md §10.2, §10.3). The decisions are `../lib/account/migration.ts`'s; this
 * is the only side that reads credential material, and it never lets any leave.
 *
 * ## The order is the safety
 *
 * 1. **Dry run first, always.** {@link FleetMigration.migrate} takes the digest the dry run printed and
 *    refuses any other, so nothing migrates that a person did not see.
 * 2. **Back up** `config.yaml` to `config.yaml.v1`, and `ids.json`, `manifest.json` and
 *    `seed-provenance.json` into `retired/<stamp>/documents/`.
 * 3. **Per login: store, verify, then retire.** The kept copy is written into Ferretry's store (a
 *    0600 file, or on macOS the keychain item named for the store directory), READ BACK through the
 *    same store resolution every runtime will use, and compared with the copy it came from. Only then
 *    do the other copies retire: each file is MOVED into `retired/<stamp>/copies/` (0700, files 0600),
 *    never deleted, and each old keychain item is listed there for `--purge-retired`. A Codex home's
 *    `auth.json` then becomes a link to the one file. A login shared with the terminal (`store: host`)
 *    is read, never written: only the copies of it retire.
 * 4. **Write** the generated settings files, `ids.json` (old UUIDs and wrapper names) and the version-2
 *    `config.yaml`, then hand the model to the injected {@link MigrationApplyPort}, which regenerates
 *    wrappers, pools history and publishes the manifest.
 *
 * NEVER A REFRESH, NEVER A LAUNCH. Nothing here starts a harness or renews a token. Verification is a
 * read of the new store, not `claude auth status`: no harness runs, so no harness can decide to
 * refresh, and a single-use Codex token cannot rotate under a half-moved machine.
 *
 * ## Resumable, and a failure puts things back
 *
 * The approved plan and every action taken are kept in `migration/state.json`, rewritten atomically
 * after each action. A migration that was killed resumes the SAVED plan on the next run with the same
 * approval — re-planning would find the moved copies gone and decide something else — and every step
 * checks what is already on disk, so running it twice does nothing twice. A migration that FAILS
 * undoes its actions newest first: links come out, retired copies move back, what it wrote into a
 * store is removed only while it is still exactly what was written, and `config.yaml` is restored.
 * One configuration file cannot be half version 1 and half version 2, so a login that fails its
 * verification rolls the whole machine back rather than only itself, and the report says which.
 *
 * The person's own `~/.claude` / `~/.codex` are only ever READ (as `store: host`), and no file inside
 * them is ever moved, linked or written: the planner excludes them, and {@link assertNotHostLogin}
 * refuses them again here.
 */
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  CLAUDE_CREDENTIAL_FILE,
  CODEX_CREDENTIAL_FILE,
  resolveCredentialStore,
  type StoredCredentialResolution,
} from '../lib/account/credentials.ts';
import { readCodexAuthFacts } from '../lib/account/credential-status.ts';
import {
  approvedPlanOf,
  type MigrationApprovedPlan,
  MigrationApprovedPlanSchema,
  type MigrationCopyLocation,
  type MigrationCredentialDecision,
  type MigrationHomeReading,
  type MigrationHostReading,
  type MigrationLiveSession,
  type MigrationMcpFile,
  type MigrationPlan,
  type MigrationSurvey,
  planMigration,
  renderMigrationDryRun,
} from '../lib/account/migration.ts';
import { readFleetDocument } from '../lib/account/legacy.ts';
import { RUNTIME_IDS_FILE, runtimeIdsPath, serializeRuntimeIds } from '../lib/account/ids.ts';
import type { AccountModel } from '../lib/account/schema.ts';
import { type FleetConfig, FleetConfigSchema } from '../lib/config.ts';
import { classifyCredential, type CredentialMaterial } from '../lib/identity.ts';
import type { HarnessKind } from '../lib/manifest.ts';
import { expandAssetPath, expandHomePath } from '../lib/paths.ts';
import { resolveAccounts } from '../lib/profiles.ts';
import type { FleetLayout } from '../lib/provisioning.ts';
import { SEED_PROVENANCE_FILE, type FleetSeedProvenanceStore } from '../lib/seed-provenance.ts';
import { serializeSettings } from '../lib/settings.ts';
import { credentialFingerprint } from './credential-classifier.ts';
import {
  type CredentialCommand,
  DEFAULT_KEYCHAIN_SERVICE,
  FileCredentialStoreLinks,
  KEYCHAIN_ITEM_NOT_FOUND,
  keychainServices,
  keychainWriteLine,
  secureStorageKeychainService,
} from './credential-store.ts';

/** `<fleet>/migration/`: the approved plan while a migration runs, and its report once it is done. */
export const MIGRATION_DIRECTORY = 'migration';
export const MIGRATION_STATE_FILE = 'state.json';
export const MIGRATION_REPORT_FILE = 'report.json';
/** `<fleet>/retired/<stamp>/`: what a migration replaced, until `--purge-retired`. */
export const RETIRED_DIRECTORY = 'retired';
/** The version-1 configuration, kept beside the new one. */
export const LEGACY_CONFIG_BACKUP_SUFFIX = '.v1';
/** In a retired folder: the keychain items holding old copies, deleted only by a purge. */
export const RETIRED_KEYCHAIN_FILE = 'keychain.json';

const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;
const KEYCHAIN_TIMEOUT_MS = 10_000;

// ── Ports ────────────────────────────────────────────────────────────────────────────────────────

/** Reading raw credential material. Satisfied by `PlatformFleetCredentialStore`. Adapter-to-adapter only. */
export interface MigrationCredentialReader {
  material(kind: HarnessKind, home: string): Promise<CredentialMaterial>;
  storedMaterial(resolution: StoredCredentialResolution): Promise<CredentialMaterial>;
}

/** The sessions running now, by the account (route UUID) each was launched on. */
export interface MigrationSessionSource {
  live(): Promise<readonly MigrationLiveSession[]>;
}

/**
 * Regenerating wrappers, pooling history and publishing the manifest for the version-2 model: the
 * same apply every version-2 change goes through, bound by the composition site that owns it.
 */
export interface MigrationApplyPort {
  apply(model: AccountModel): Promise<void>;
}

export interface FleetMigrationDeps {
  readonly layout: FleetLayout;
  /** `<fleet>/config.yaml`. */
  readonly configPath: string;
  /** `process.platform`; `darwin` keeps Claude logins in the keychain. */
  readonly platform: string;
  readonly credentials: MigrationCredentialReader;
  /** Runs `security` on macOS. */
  readonly command: CredentialCommand;
  /** The keychain `acct` a new item is written under (`harnessKeychainAccount`). */
  readonly keychainAccount: string;
  /** The person's own Codex home (`hostCodexHome`), when it can be named. */
  readonly hostCodexHome?: string;
  readonly provenance: FleetSeedProvenanceStore;
  readonly sessions: MigrationSessionSource;
  readonly apply: MigrationApplyPort;
  readonly now: () => number;
}

// ── What it reports ──────────────────────────────────────────────────────────────────────────────

/** Where this machine is. */
export type MigrationStatus =
  | { readonly kind: 'version-1' }
  | { readonly kind: 'version-2' }
  | { readonly kind: 'in-progress'; readonly digest: string; readonly startedAt: number }
  | { readonly kind: 'no-fleet' };

export interface MigrationDryRun {
  readonly plan: MigrationPlan;
  /** The version-2 `config.yaml` that would be written. */
  readonly configText: string;
  readonly lines: readonly string[];
}

/** The provenance a finished migration leaves: which login each credential kept, and from where. */
export const MigrationReportSchema = z.strictObject({
  version: z.literal(1),
  digest: z.string(),
  startedAt: z.number(),
  finishedAt: z.number(),
  retired: z.string(),
  credentials: z.array(
    z.strictObject({
      id: z.string(),
      harness: z.string(),
      store: z.string(),
      kept: z.string(),
      retired: z.array(z.string()),
    }),
  ),
  runtimes: z.array(z.strictObject({ name: z.string(), id: z.string(), formerName: z.string().optional() })),
});
export type MigrationReport = z.infer<typeof MigrationReportSchema>;

export type MigrationOutcome =
  | { readonly kind: 'migrated'; readonly report: MigrationReport; readonly resumed: boolean }
  | { readonly kind: 'refused'; readonly reasons: readonly string[] }
  | {
      readonly kind: 'rolled-back';
      readonly reason: string;
      /** What could not be put back, each naming where the original is. */
      readonly unrestored: readonly string[];
    };

export interface MigrationPurge {
  readonly removed: readonly string[];
  readonly keychainItems: readonly string[];
  readonly kept: readonly string[];
}

// ── The saved state ──────────────────────────────────────────────────────────────────────────────

const ActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('step'), step: z.string() }),
  z.strictObject({ kind: z.literal('wrote-file'), path: z.string(), digest: z.string() }),
  z.strictObject({ kind: z.literal('wrote-keychain'), service: z.string(), digest: z.string() }),
  z.strictObject({ kind: z.literal('moved'), from: z.string(), to: z.string() }),
  z.strictObject({ kind: z.literal('linked'), path: z.string() }),
  z.strictObject({ kind: z.literal('replaced'), path: z.string(), backup: z.string() }),
]);
type Action = z.infer<typeof ActionSchema>;

const StateSchema = z.strictObject({
  version: z.literal(1),
  startedAt: z.number(),
  retired: z.string(),
  plan: MigrationApprovedPlanSchema,
  actions: z.array(ActionSchema),
});
type State = z.infer<typeof StateSchema>;

// ── Small file helpers ───────────────────────────────────────────────────────────────────────────

async function stat(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

async function readText(target: string): Promise<string | undefined> {
  return (await stat(target)) === undefined ? undefined : await readFile(target, 'utf8');
}

/** Replace a file atomically at an owner-only mode; never through a link. */
async function writePrivate(target: string, content: string, mode = PRIVATE_FILE): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY });
  if ((await stat(target))?.isSymbolicLink() === true) {
    throw new Error(`${target} is a symbolic link, so it was left as it is`);
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Move a file, across devices too: a copy that is read back before the original goes. */
async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true, mode: PRIVATE_DIRECTORY });
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  await copyFile(from, to);
  await chmod(to, PRIVATE_FILE);
  const [original, copied] = await Promise.all([readFile(from), readFile(to)]);
  if (!original.equals(copied)) throw new Error(`moving ${from} could not be confirmed, so it was left in place`);
  await unlink(from);
}

const digestText = (text: string): string => credentialFingerprint(text);

function failure(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

/** Thrown when a step finds the machine is not what the approved plan said; the run rolls back. */
class MigrationStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationStepError';
  }
}

// ── The executor ─────────────────────────────────────────────────────────────────────────────────

export class FleetMigration {
  readonly #links = new FileCredentialStoreLinks();

  constructor(private readonly deps: FleetMigrationDeps) {}

  get #fleet(): string {
    return this.deps.layout.fleetDirectory;
  }

  get #statePath(): string {
    return path.join(this.#fleet, MIGRATION_DIRECTORY, MIGRATION_STATE_FILE);
  }

  get #reportPath(): string {
    return path.join(this.#fleet, MIGRATION_DIRECTORY, MIGRATION_REPORT_FILE);
  }

  get #backupPath(): string {
    return `${this.deps.configPath}${LEGACY_CONFIG_BACKUP_SUFFIX}`;
  }

  #keychain(): boolean {
    return this.deps.platform === 'darwin';
  }

  async #state(): Promise<State | undefined> {
    const text = await readText(this.#statePath);
    if (text === undefined) return undefined;
    // A saved migration this build cannot read is never guessed at: the person is told, and nothing moves.
    const parsed = StateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`${this.#statePath} holds a migration this version cannot read; it was left as it is`);
    }
    return parsed.data;
  }

  async #saveState(state: State): Promise<void> {
    await writePrivate(this.#statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  /** Where this machine is: not set up, on version 1, half migrated, or on version 2. */
  async status(): Promise<MigrationStatus> {
    const state = await this.#state();
    if (state !== undefined) return { kind: 'in-progress', digest: state.plan.digest, startedAt: state.startedAt };
    const text = await readText(this.deps.configPath);
    if (text === undefined) return { kind: 'no-fleet' };
    const raw: unknown = Bun.YAML.parse(text);
    return readFleetDocument(raw).version === 1 ? { kind: 'version-1' } : { kind: 'version-2' };
  }

  // ── Survey ────────────────────────────────────────────────────────────────────────────────────

  /** Read the machine as the planner needs it: verdicts and digests, never material. */
  async survey(document: unknown): Promise<MigrationSurvey> {
    const { layout } = this.deps;
    const config: FleetConfig = FleetConfigSchema.parse(
      document !== null && typeof document === 'object'
        ? (({ version: _version, ...rest }) => rest)(document as Record<string, unknown>)
        : (document ?? {}),
    );
    const accounts = resolveAccounts(config);
    const host: Partial<Record<HarnessKind, MigrationHostReading>> = {};
    for (const harness of new Set(accounts.map(account => account.kind))) {
      host[harness] = await this.#hostReading(harness);
    }
    const homes: MigrationHomeReading[] = [];
    for (const account of accounts) {
      if (account.auth === 'api-key') continue;
      const home = expandHomePath(account.home, layout.userHome, layout.homesDirectory);
      homes.push(await this.#homeReading(account.id, account.kind, home));
    }
    const mcpFiles: Record<string, MigrationMcpFile> = {};
    for (const account of accounts) {
      if (account.mcp === undefined || mcpFiles[account.mcp] !== undefined) continue;
      mcpFiles[account.mcp] = await this.#mcpFile(account.mcp);
    }
    return {
      document,
      layout,
      homes,
      host,
      provenance: await this.deps.provenance.read(),
      liveSessions: await this.deps.sessions.live(),
      mcpFiles,
      keychain: this.#keychain(),
    };
  }

  async #hostReading(harness: HarnessKind): Promise<MigrationHostReading> {
    const resolution = resolveCredentialStore(
      `host-${harness}`,
      { harness, store: 'host' },
      {
        fleetRoot: this.#fleet,
        userHome: this.deps.layout.userHome,
        ...(this.deps.hostCodexHome === undefined ? {} : { hostCodexHome: this.deps.hostCodexHome }),
      },
    );
    if ('unavailable' in resolution) {
      return { harness, directory: '', state: 'missing', unavailable: resolution.unavailable };
    }
    if (resolution.store === 'environment') return { harness, directory: '', state: 'missing' };
    const directory =
      resolution.harness === 'claude' ? resolution.storageDirectory : path.dirname(resolution.canonicalFile);
    const material = await this.#safely(() => this.deps.credentials.storedMaterial(resolution));
    return {
      harness,
      directory,
      state: classifyCredential(harness, material, this.deps.now()).state,
      ...(material.outcome === 'found' ? { fingerprint: credentialFingerprint(material.blob) } : {}),
    };
  }

  async #safely(read: () => Promise<CredentialMaterial>): Promise<CredentialMaterial> {
    try {
      return await read();
    } catch (error) {
      return { outcome: 'unreadable', reason: failure(error) };
    }
  }

  async #homeReading(accountId: string, harness: HarnessKind, home: string): Promise<MigrationHomeReading> {
    const file = path.join(home, harness === 'claude' ? CLAUDE_CREDENTIAL_FILE : CODEX_CREDENTIAL_FILE);
    const information = await stat(file);
    if (harness === 'codex' && information?.isSymbolicLink() === true) {
      return { accountId, harness, home, state: 'missing', copies: [], linkedTo: await readlink(file) };
    }
    const material = await this.#safely(() => this.deps.credentials.material(harness, home));
    const reading = classifyCredential(harness, material, this.deps.now());
    const copies: MigrationCopyLocation[] = [];
    if (information?.isFile() === true) copies.push({ kind: 'file', path: file });
    if (harness === 'claude' && this.#keychain()) {
      for (const service of keychainServices(home)) {
        if (await this.#keychainItemExists(service)) copies.push({ kind: 'keychain', service });
      }
    }
    let freshness: number | undefined = reading.expiresAt;
    if (harness === 'codex') {
      const facts = readCodexAuthFacts(material);
      freshness = facts.state === 'tokens' ? (facts.lastRefreshAt ?? facts.accessExpiresAt) : undefined;
    }
    return {
      accountId,
      harness,
      home,
      state: reading.state,
      ...(reading.reason === undefined ? {} : { reason: reading.reason }),
      ...(freshness === undefined ? {} : { freshness }),
      ...(material.outcome === 'found' ? { fingerprint: credentialFingerprint(material.blob) } : {}),
      copies,
    };
  }

  async #mcpFile(reference: string): Promise<MigrationMcpFile> {
    const file = expandAssetPath(reference, this.deps.layout.userHome, this.deps.layout.assetsDirectory);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      const servers =
        parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>).mcpServers : undefined;
      if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
        return { ok: false, reason: 'it has no "mcpServers" object' };
      }
      return { ok: true, servers: servers as Record<string, unknown> };
    } catch (error) {
      return { ok: false, reason: failure(error) };
    }
  }

  async #keychainItemExists(service: string): Promise<boolean> {
    const { code } = await this.deps.command.run(
      ['security', 'find-generic-password', '-s', service],
      KEYCHAIN_TIMEOUT_MS,
    );
    return code === 0;
  }

  // ── Dry run ───────────────────────────────────────────────────────────────────────────────────

  /**
   * What a migration would do, changing nothing. Throws when there is nothing to migrate: no fleet,
   * one already on version 2, or one half migrated (whose saved plan {@link migrate} finishes).
   */
  async dryRun(): Promise<MigrationDryRun> {
    const status = await this.status();
    if (status.kind !== 'version-1') throw new Error(statusSentence(status));
    const raw: unknown = Bun.YAML.parse((await readText(this.deps.configPath)) ?? '') ?? {};
    const plan = planMigration(await this.survey(raw));
    const configText = renderConfig(plan.model);
    return { plan, configText, lines: renderMigrationDryRun(plan, configText) };
  }

  // ── Migrate ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Migrate this machine, or finish a migration that was interrupted. `approve` is the digest the dry
   * run printed; any other is refused, so a machine never changes in a way nobody was shown.
   */
  async migrate(approve: string): Promise<MigrationOutcome> {
    let state = await this.#state();
    let resumed = true;
    if (state !== undefined) {
      if (state.plan.digest !== approve) {
        return {
          kind: 'refused',
          reasons: [
            `a migration approved as ${state.plan.digest} is half done; approve that one to finish it before anything else`,
          ],
        };
      }
    } else {
      const { plan } = await this.dryRun();
      if (plan.digest !== approve) {
        return {
          kind: 'refused',
          reasons: [
            `this machine has changed since the dry run you approved (${approve}); run the dry run again (it is now ${plan.digest})`,
          ],
        };
      }
      if (plan.blockers.length > 0) return { kind: 'refused', reasons: plan.blockers.map(blocker => blocker.message) };
      const live = await this.#liveOn(approvedPlanOf(plan));
      if (live.length > 0) return { kind: 'refused', reasons: live };
      const startedAt = Math.trunc(this.deps.now());
      state = {
        version: 1,
        startedAt,
        retired: path.join(this.#fleet, RETIRED_DIRECTORY, `${startedAt}`),
        plan: approvedPlanOf(plan),
        actions: [],
      };
      await this.#saveState(state);
      resumed = false;
    }

    if (resumed) {
      const live = await this.#liveOn(state.plan);
      if (live.length > 0) return { kind: 'refused', reasons: live };
    }

    try {
      await this.#run(state);
    } catch (error) {
      const unrestored = await this.#rollback(state);
      return { kind: 'rolled-back', reason: failure(error), unrestored };
    }
    const report = this.#report(state);
    await writePrivate(this.#reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await rm(this.#statePath, { force: true });
    return { kind: 'migrated', report, resumed };
  }

  /** Running sessions on a login the plan moves, each named (§10.3.2). */
  async #liveOn(plan: MigrationApprovedPlan): Promise<string[]> {
    const affected = new Map<string, string>();
    for (const runtime of plan.runtimes) {
      const credential = plan.credentials.find(decision => decision.id === runtime.credential);
      if (credential !== undefined && credential.store !== 'environment') affected.set(runtime.id, credential.id);
    }
    return (await this.deps.sessions.live())
      .filter(session => affected.has(session.accountId))
      .map(
        session =>
          `login ${affected.get(session.accountId)} is in use by running session ${session.session}; stop it and run the migration again`,
      );
  }

  async #record(state: State, action: Action): Promise<void> {
    state.actions.push(action);
    await this.#saveState(state);
  }

  #done(state: State, step: string): boolean {
    return state.actions.some(action => action.kind === 'step' && action.step === step);
  }

  async #step(state: State, step: string, work: () => Promise<void>): Promise<void> {
    if (this.#done(state, step)) return;
    await work();
    await this.#record(state, { kind: 'step', step });
  }

  async #run(state: State): Promise<void> {
    const { plan } = state;
    await this.#step(state, 'backup', () => this.#backup(state));
    for (const credential of plan.credentials) {
      await this.#step(state, `store:${credential.id}`, () => this.#store(state, credential));
      await this.#step(state, `verify:${credential.id}`, () => this.#verify(credential));
      await this.#step(state, `retire:${credential.id}`, () => this.#retire(state, credential));
      await this.#step(state, `link:${credential.id}`, () => this.#link(state, credential));
    }
    await this.#step(state, 'bodies', () => this.#bodies(state));
    await this.#step(state, 'ids', () =>
      this.#replace(state, runtimeIdsPath(this.#fleet), serializeRuntimeIds(plan.ids)),
    );
    await this.#step(state, 'config', () => this.#replace(state, this.deps.configPath, renderConfig(plan.model)));
    await this.#step(state, 'apply', () => this.deps.apply.apply(plan.model));
    await this.#step(state, 'provenance', () => this.#retireProvenance(state));
  }

  async #backup(state: State): Promise<void> {
    const documents = path.join(state.retired, 'documents');
    await mkdir(documents, { recursive: true, mode: PRIVATE_DIRECTORY });
    const config = await readText(this.deps.configPath);
    if (config === undefined) throw new MigrationStepError(`${this.deps.configPath} is gone`);
    const previous = await readText(this.#backupPath);
    if (previous !== undefined && previous !== config) {
      // An earlier attempt's backup that a rollback left behind: kept, under the folder of this one.
      await moveFile(this.#backupPath, path.join(documents, `config.yaml${LEGACY_CONFIG_BACKUP_SUFFIX}.previous`));
    }
    if (previous !== config) await writePrivate(this.#backupPath, config);
    for (const name of [RUNTIME_IDS_FILE, 'manifest.json', SEED_PROVENANCE_FILE, 'config.yaml']) {
      const source = name === 'config.yaml' ? this.deps.configPath : path.join(this.#fleet, name);
      if ((await stat(source))?.isFile() === true) await copyFile(source, path.join(documents, name));
    }
  }

  #storeResolution(credential: MigrationCredentialDecision): StoredCredentialResolution | undefined {
    const resolution = resolveCredentialStore(
      credential.id,
      { harness: credential.harness, store: credential.store },
      {
        fleetRoot: this.#fleet,
        userHome: this.deps.layout.userHome,
        ...(this.deps.hostCodexHome === undefined ? {} : { hostCodexHome: this.deps.hostCodexHome }),
      },
    );
    return 'unavailable' in resolution || resolution.store === 'environment' ? undefined : resolution;
  }

  /** Write the kept copy into Ferretry's store, unless it is already there. Never into a `host` store. */
  async #store(state: State, credential: MigrationCredentialDecision): Promise<void> {
    if (credential.source.kind !== 'copy') return;
    const resolution = this.#storeResolution(credential);
    if (resolution === undefined || resolution.store !== 'ferretry') return;
    const source = credential.source;
    this.#assertNotHostLogin(source.home, credential.harness);
    const stored = await this.#safely(() => this.deps.credentials.storedMaterial(resolution));
    if (stored.outcome === 'found' && credentialFingerprint(stored.blob) === source.fingerprint) return;
    if (stored.outcome !== 'absent') {
      throw new MigrationStepError(
        `Ferretry's store for login ${credential.id} already holds a different login, so nothing was written over it`,
      );
    }
    const material = await this.deps.credentials.material(credential.harness, source.home);
    if (material.outcome !== 'found' || credentialFingerprint(material.blob) !== source.fingerprint) {
      throw new MigrationStepError(
        `the copy of login ${credential.id} in ${source.home} changed after the dry run; run the dry run again`,
      );
    }
    if (resolution.ownedDirectory !== undefined) {
      await mkdir(resolution.ownedDirectory, { recursive: true, mode: PRIVATE_DIRECTORY });
      await chmod(resolution.ownedDirectory, PRIVATE_DIRECTORY);
    }
    if (resolution.harness === 'claude' && this.#keychain()) {
      const service = secureStorageKeychainService(resolution.secureStorage);
      await this.#writeKeychain(service, material.blob);
      await this.#record(state, { kind: 'wrote-keychain', service, digest: source.fingerprint });
      return;
    }
    const file = resolution.harness === 'claude' ? resolution.credentialFile : resolution.canonicalFile;
    await writePrivate(file, material.blob);
    await this.#record(state, { kind: 'wrote-file', path: file, digest: source.fingerprint });
  }

  async #writeKeychain(service: string, blob: string): Promise<void> {
    const line = keychainWriteLine(this.deps.keychainAccount, service, blob);
    if (line === undefined) {
      throw new MigrationStepError(
        'the keychain write was refused, because it could not be made without exposing the login',
      );
    }
    const { code } = await this.deps.command.run(['security', '-i'], KEYCHAIN_TIMEOUT_MS, line);
    if (code !== 0) throw new MigrationStepError(`the keychain write failed (exit ${code})`);
  }

  /** Read the new store the way every runtime will, and compare it with the copy it came from. */
  async #verify(credential: MigrationCredentialDecision): Promise<void> {
    const { source } = credential;
    if (source.kind === 'environment' || source.kind === 'empty') return;
    // Your own login that is not signed in has nothing to read back, and the planner retires no
    // usable copy of it (a newer copy beside it blocks the migration instead).
    if (source.kind === 'host' && !source.signedIn) return;
    const resolution = this.#storeResolution(credential);
    if (resolution === undefined) {
      throw new MigrationStepError(`login ${credential.id} has no store this machine can reach`);
    }
    const material = await this.#safely(() => this.deps.credentials.storedMaterial(resolution));
    const reading = classifyCredential(credential.harness, material, this.deps.now());
    if (material.outcome !== 'found' || (reading.state !== 'valid' && reading.state !== 'refreshable')) {
      throw new MigrationStepError(
        `login ${credential.id} could not be read back from its new store (${reading.state}), so no copy was retired`,
      );
    }
    if (credential.source.kind === 'copy' && credentialFingerprint(material.blob) !== credential.source.fingerprint) {
      throw new MigrationStepError(
        `login ${credential.id} read back from its new store is not the copy that was moved, so no copy was retired`,
      );
    }
  }

  /** Move every retiring copy into the retired folder; list keychain items for a purge. */
  async #retire(state: State, credential: MigrationCredentialDecision): Promise<void> {
    const items: string[] = [];
    for (const item of credential.retire) {
      if (item.copy.kind === 'keychain') {
        if (item.copy.service !== DEFAULT_KEYCHAIN_SERVICE) items.push(item.copy.service);
        continue;
      }
      this.#assertNotHostLogin(item.home, credential.harness);
      const destination = path.join(state.retired, 'copies', item.accountId, path.basename(item.copy.path));
      const here = await stat(item.copy.path);
      if (here === undefined) continue;
      if (here.isSymbolicLink()) continue;
      await moveFile(item.copy.path, destination);
      await this.#record(state, { kind: 'moved', from: item.copy.path, to: destination });
    }
    if (items.length > 0) {
      const file = path.join(state.retired, RETIRED_KEYCHAIN_FILE);
      const listed = JSON.parse((await readText(file)) ?? '[]') as string[];
      await writePrivate(file, `${JSON.stringify([...new Set([...listed, ...items])].toSorted(), null, 2)}\n`);
    }
  }

  /** Point each Codex home's `auth.json` at the one file. */
  async #link(state: State, credential: MigrationCredentialDecision): Promise<void> {
    if (credential.link.length === 0) return;
    const resolution = this.#storeResolution(credential);
    if (resolution === undefined || resolution.harness !== 'codex') return;
    for (const home of credential.link) {
      this.#assertNotHostLogin(home, 'codex');
      if ((await stat(home))?.isDirectory() !== true) continue;
      const outcome = await this.#links.linkCodex({
        path: path.join(home, CODEX_CREDENTIAL_FILE),
        target: resolution.canonicalFile,
      });
      if (!outcome.ok) throw new MigrationStepError(outcome.reason);
      if (outcome.change !== 'unchanged') {
        await this.#record(state, { kind: 'linked', path: path.join(home, CODEX_CREDENTIAL_FILE) });
      }
    }
  }

  async #bodies(state: State): Promise<void> {
    for (const body of state.plan.settingsBodies) {
      const file = expandAssetPath(body.file, this.deps.layout.userHome, this.deps.layout.assetsDirectory);
      const content = serializeSettings(body.content, body.format);
      const existing = await readText(file);
      if (existing === content) continue;
      if (existing !== undefined) {
        throw new MigrationStepError(`${file} already exists with other content, so it was left as it is`);
      }
      await writePrivate(file, content);
      await this.#record(state, { kind: 'wrote-file', path: file, digest: digestText(content) });
    }
  }

  /** Replace a document, keeping what was there so a rollback can put it back. */
  async #replace(state: State, target: string, content: string): Promise<void> {
    const existing = await readText(target);
    if (existing === content) return;
    if (existing !== undefined) {
      const backup = path.join(state.retired, 'replaced', `${path.basename(target)}.${randomUUID()}`);
      await mkdir(path.dirname(backup), { recursive: true, mode: PRIVATE_DIRECTORY });
      await copyFile(target, backup);
      await writePrivate(target, content);
      await this.#record(state, { kind: 'replaced', path: target, backup });
      return;
    }
    await writePrivate(target, content);
    await this.#record(state, { kind: 'wrote-file', path: target, digest: digestText(content) });
  }

  /** The seed records described copies that no longer exist; they retire with them. */
  async #retireProvenance(state: State): Promise<void> {
    const file = path.join(this.#fleet, SEED_PROVENANCE_FILE);
    if ((await stat(file))?.isFile() !== true) return;
    const destination = path.join(state.retired, 'documents', `${SEED_PROVENANCE_FILE}.retired`);
    await moveFile(file, destination);
    await this.#record(state, { kind: 'moved', from: file, to: destination });
  }

  /** Refuse any write, move or link inside the person's own harness directory. */
  #assertNotHostLogin(target: string, harness: HarnessKind): void {
    const own =
      harness === 'claude'
        ? path.join(this.deps.layout.userHome, '.claude')
        : (this.deps.hostCodexHome ?? path.join(this.deps.layout.userHome, '.codex'));
    const relative = path.relative(path.resolve(own), path.resolve(target));
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new MigrationStepError(`${target} is your own ${harness} login, which a migration never changes`);
    }
  }

  #report(state: State): MigrationReport {
    const moved = state.actions.flatMap(action => (action.kind === 'moved' ? [action] : []));
    return {
      version: 1,
      digest: state.plan.digest,
      startedAt: state.startedAt,
      finishedAt: Math.trunc(this.deps.now()),
      retired: state.retired,
      credentials: state.plan.credentials.map(credential => ({
        id: credential.id,
        harness: credential.harness,
        store: credential.store,
        kept:
          credential.source.kind === 'host'
            ? `your own login in ${credential.source.directory}`
            : credential.source.kind === 'copy'
              ? `the copy from ${credential.source.wrapper} (${credential.source.home})`
              : credential.source.kind === 'empty'
                ? 'nothing; needs sign-in'
                : 'its environment variables',
        retired: credential.retire.flatMap(item =>
          item.copy.kind === 'keychain'
            ? [`keychain item "${item.copy.service}" (until purged)`]
            : moved.filter(action => action.from === (item.copy as { path: string }).path).map(action => action.to),
        ),
      })),
      runtimes: state.plan.runtimes.map(runtime => ({
        name: runtime.name,
        id: runtime.id,
        ...(runtime.wrapper === runtime.name ? {} : { formerName: runtime.wrapper }),
      })),
    };
  }

  // ── Rollback ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Undo every action, newest first, and say what could not be undone. Nothing is deleted that is not
   * still exactly what this migration wrote, so a login a harness renewed meanwhile is kept and named.
   */
  async #rollback(state: State): Promise<string[]> {
    const unrestored: string[] = [];
    for (const action of state.actions.toReversed()) {
      try {
        await this.#undo(action, unrestored);
      } catch (error) {
        unrestored.push(failure(error));
      }
    }
    if (unrestored.length === 0) {
      await rm(this.#statePath, { force: true });
      await rm(state.retired, { recursive: true, force: true });
    } else {
      // The record of every action is the map of where everything is, so it is kept beside the report.
      await writePrivate(
        path.join(this.#fleet, MIGRATION_DIRECTORY, `rollback-${state.startedAt}.json`),
        `${JSON.stringify({ actions: state.actions, unrestored }, null, 2)}\n`,
      ).catch(() => undefined);
      await rm(this.#statePath, { force: true });
    }
    return unrestored;
  }

  async #undo(action: Action, unrestored: string[]): Promise<void> {
    if (action.kind === 'step') return;
    if (action.kind === 'linked') {
      if ((await stat(action.path))?.isSymbolicLink() === true) await unlink(action.path);
      return;
    }
    if (action.kind === 'moved') {
      if ((await stat(action.from)) !== undefined) {
        unrestored.push(
          `${action.from} was not put back, because something is there now; the original is at ${action.to}`,
        );
        return;
      }
      await moveFile(action.to, action.from);
      return;
    }
    if (action.kind === 'replaced') {
      await writePrivate(action.path, await readFile(action.backup, 'utf8'));
      return;
    }
    if (action.kind === 'wrote-file') {
      const text = await readText(action.path);
      if (text === undefined) return;
      if (digestText(text) !== action.digest) {
        unrestored.push(`${action.path} changed after the migration wrote it, so it was kept`);
        return;
      }
      await unlink(action.path);
      return;
    }
    const { code, stdout } = await this.deps.command.run(
      ['security', 'find-generic-password', '-s', action.service, '-w'],
      KEYCHAIN_TIMEOUT_MS,
    );
    if (code === KEYCHAIN_ITEM_NOT_FOUND) return;
    if (code !== 0 || credentialFingerprint(stdout.trim()) !== action.digest) {
      unrestored.push(`keychain item "${action.service}" changed after the migration wrote it, so it was kept`);
      return;
    }
    await this.deps.command.run(['security', 'delete-generic-password', '-s', action.service], KEYCHAIN_TIMEOUT_MS);
  }

  // ── Purge ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Delete what finished migrations retired: the moved copies, the old documents, and the keychain
   * items they listed. Never while a migration is half done, never the bare keychain item (the
   * person's own Claude login), and never an item a current login is kept in.
   */
  async purgeRetired(): Promise<MigrationPurge> {
    if ((await this.#state()) !== undefined) {
      throw new Error('a migration is half done; finish it before purging what earlier ones retired');
    }
    const root = path.join(this.#fleet, RETIRED_DIRECTORY);
    if ((await stat(root))?.isDirectory() !== true) return { removed: [], keychainItems: [], kept: [] };
    const protectedItems = new Set([DEFAULT_KEYCHAIN_SERVICE, ...(await this.#currentKeychainItems())]);
    const removed: string[] = [];
    const keychainItems: string[] = [];
    const kept: string[] = [];
    for (const name of (await readdir(root)).toSorted()) {
      const folder = path.join(root, name);
      const listed = JSON.parse((await readText(path.join(folder, RETIRED_KEYCHAIN_FILE))) ?? '[]') as unknown;
      let complete = true;
      for (const service of Array.isArray(listed) ? listed : []) {
        if (typeof service !== 'string' || protectedItems.has(service)) continue;
        const { code } = await this.deps.command.run(
          ['security', 'delete-generic-password', '-s', service],
          KEYCHAIN_TIMEOUT_MS,
        );
        if (code === 0 || code === KEYCHAIN_ITEM_NOT_FOUND) keychainItems.push(service);
        else {
          complete = false;
          kept.push(`keychain item "${service}" could not be deleted (exit ${code})`);
        }
      }
      if (!complete) {
        kept.push(folder);
        continue;
      }
      await rm(folder, { recursive: true, force: true });
      removed.push(folder);
    }
    return { removed, keychainItems, kept };
  }

  /** Every keychain item a version-2 login on this machine is kept in now. */
  async #currentKeychainItems(): Promise<string[]> {
    const text = await readText(this.deps.configPath);
    if (text === undefined) return [];
    const document = readFleetDocument(Bun.YAML.parse(text));
    if (document.version !== 2) return [];
    return Object.entries(document.model.credentials).flatMap(([id, credential]) => {
      if (credential.harness !== 'claude' || credential.store === 'environment') return [];
      const resolution = this.#storeResolution({
        id,
        harness: 'claude',
        store: credential.store,
        source: { kind: 'environment' },
        retire: [],
        link: [],
        runtimes: [],
      });
      return resolution?.harness === 'claude' ? [secureStorageKeychainService(resolution.secureStorage)] : [];
    });
  }
}

/** The version-2 `config.yaml`, as written. */
export function renderConfig(model: AccountModel): string {
  return `${Bun.YAML.stringify(model, null, 2).replace(/\n*$/u, '')}\n`;
}

function statusSentence(status: MigrationStatus): string {
  if (status.kind === 'no-fleet') return 'this machine has no fleet to migrate; set it up instead';
  if (status.kind === 'version-2') return 'this machine already uses the new account format';
  if (status.kind === 'in-progress') {
    return `a migration approved as ${status.digest} is half done; approve it again to finish it`;
  }
  return 'this machine uses the old account format';
}
