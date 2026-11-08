/**
 * The files the account model's catalogue reads (docs/design/account-model.md §5.3,
 * docs/config-files.md): the configuration files in effect with the revision they were read at, the
 * component documents they name, and what a document is now.
 *
 * Reads only. Every write a reviewed change makes goes through the provisioner, inside its rollback
 * boundary (the configuration documents through the all-or-none config writer first), so nothing here can
 * leave a machine half-changed.
 */

import { join, relative } from 'node:path';
import { z } from 'zod';
import type { AccountModel } from '../lib/account/schema.ts';
import { parseRuntimeIds, type RuntimeIds, runtimeIdsPath } from '../lib/account/ids.ts';
import type { AccountDocumentReading, FleetCatalogServiceDeps } from '../lib/service/catalog-service.ts';
import { type RuntimeRename, SESSION_STATUSES, type SessionStatus } from '../lib/service/foreign.ts';
import type { FleetPublication } from '../lib/service/publication.ts';
import type { RuntimeConfigWriter } from '../lib/service/ports.ts';
import {
  ABSENT_DOCUMENT_REVISION,
  type FleetDocumentWrite,
  type FleetLayout,
  type FleetModelApplyPlan,
} from '../lib/provisioning.ts';
import type { ClaudeStatuslineCommand } from '../lib/account/adapt.ts';
import type { AdapterHost, ConfigFilesPort, HostFiles, SharedHistoryPooling } from './ports.ts';
import { FileFleetProvisioner } from './file-provisioner.ts';
import { readFleetManifest } from './manifest-file.ts';

/** The largest component document the catalogue reads; a larger one is reported as unreadable. */
const MAX_COMPONENT_BYTES = 1024 * 1024;

const digest = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/** Configuration and component documents are private: they name everything a runtime runs with. */
const DOCUMENT_MODE = 0o600;

/**
 * The directories of this daemon's home that the catalogue names: the state home, the fleet folder the `fleet` root
 * names, and the manifest in it. The configuration folder is passed beside (`configDirectory`).
 */
interface FleetHomePaths {
  readonly home: string;
  readonly fleet: string;
  readonly fleetManifest: string;
}

/** Where the configuration lives. */
export interface ConfigAccountLocations {
  /** `<FY_HOME>/config`. */
  readonly configDirectory: string;
}

/**
 * The configuration in effect, as the catalogue reads it: the account model the files hold — each at
 * its last good version — and the writes that would move them to another model. `fresh` loads the directory first
 * instead of answering the last load.
 */
export async function readConfigAccountDocument(
  config: Pick<ConfigFilesPort<AccountModel>, 'inEffect' | 'load' | 'editsFor' | 'mentionsRenamed'>,
  locations: ConfigAccountLocations,
  fresh = false,
): Promise<AccountDocumentReading> {
  const loaded = fresh ? await config.load() : await config.inEffect();
  const { evaluation } = loaded;
  const model = evaluation.effective.model;
  return {
    format: evaluation.fleetFiles === 0 ? 'none' : 'present',
    model,
    revision: evaluation.fleetRevision,
    documents: (next: AccountModel, rename?: RuntimeRename): readonly FleetDocumentWrite[] =>
      [
        ...config.editsFor(loaded, next, runtimeFileMoves(rename)),
        ...(rename === undefined ? [] : config.mentionsRenamed(loaded, rename)),
      ].map(edit => ({
        path: join(locations.configDirectory, edit.path),
        content: edit.content ?? '',
        mode: DOCUMENT_MODE,
        expect: edit.expect,
        ...(edit.content === undefined ? { remove: true as const } : {}),
      })),
  };
}

/** `<FY_HOME>/config`: the configuration folder beside the fleet folder the `fleet` root names. */
export const configDirectoryOf = (home: string): string => join(home, 'config');

/** A runtime's file under `config/` (`RUNTIME_ITEMS`: `config/runtimes/<name>.yaml`). */
const runtimeConfigPath = (name: string): string => `runtimes/${name}.yaml`;

/** A renamed runtime's file, new path → old path, so it moves with the owner's comments. */
export const runtimeFileMoves = (rename: RuntimeRename | undefined): ReadonlyMap<string, string> =>
  rename === undefined ? new Map() : new Map([[runtimeConfigPath(rename.to), runtimeConfigPath(rename.from)]]);

/**
 * The account model this machine declares, or `undefined` for a machine with no fleet files yet.
 * `fresh` (the default) loads the directory first — what a decision about authority needs, such as an
 * agent-control switch that must be in effect the moment it is saved; `false` answers the last load,
 * for a reader that runs on a timer.
 */
export async function readDeclaredAccountModel(
  config: Pick<ConfigFilesPort<AccountModel>, 'inEffect' | 'load' | 'editsFor' | 'mentionsRenamed'>,
  locations: ConfigAccountLocations,
  fresh = true,
): Promise<AccountModel | undefined> {
  const reading = await readConfigAccountDocument(config, locations, fresh);
  return reading.format === 'none' ? undefined : reading.model;
}

/** What a document is now: its sha256, or the absent sentinel. Throws when it exists and cannot be read. */
export async function documentRevision(files: Pick<HostFiles, 'readBytes'>, path: string): Promise<string> {
  const bytes = await files.readBytes(path);
  return bytes === undefined ? ABSENT_DOCUMENT_REVISION : digest(bytes);
}

/**
 * The status a raw state document says, or `undefined` when it says none a reader can count. Only the status is
 * read: the catalogue counts running sessions, and parsing the whole state of every session to count them was
 * the cost the session status tally exists to remove.
 */
export function sessionStatusOf(raw: unknown): SessionStatus | undefined {
  if (typeof raw !== 'object' || raw === null || !('status' in raw)) return undefined;
  const status = SessionStatusSchema.safeParse(raw.status);
  return status.success ? status.data : undefined;
}

const SessionStatusSchema = z.enum(SESSION_STATUSES);

/** What the composition root hands the catalogue: its own collaborators, and nothing it would build twice. */
export interface FileFleetCatalogOptions {
  /** The host: its files, command lookup, provisioner calls and clock (`./ports.ts`). */
  readonly host: AdapterHost;
  readonly paths: FleetHomePaths;
  readonly userHome: string;
  readonly hostCodexHome?: string;
  /** Every session's status, as its state document says it: {@link sessionStatusOf} reads one. */
  sessionStatuses(): Promise<readonly SessionStatus[]>;
  /** The session records a runtime removal or rename reads and re-points. Absent: neither is known. */
  readonly sessionRecords?: Required<Pick<FleetCatalogServiceDeps, 'sessionRecords' | 'renameSessions'>>;
  readonly credentials: FleetCatalogServiceDeps['credentials'];
  readonly loginChanges: FleetCatalogServiceDeps['loginChanges'];
  /** Writes the configuration documents of a change. GAP(kernel): plugins have no config write port. */
  readonly configWriter: RuntimeConfigWriter;
  readonly locate: FleetCatalogServiceDeps['locate'];
  readonly machineName: () => string;
  /** What a person types to run this binary: the wrapper's history claim and statusLine run it. */
  readonly clientName: string;
  /** The configuration files: read for the model in effect, and told about every file a change writes. */
  readonly config: ConfigFilesPort<AccountModel>;
  /** The shared-history migration an apply runs. GAP(conversation): the lease store's own. */
  readonly sharedHistory: SharedHistoryPooling;
  /** Claude's statusLine command, bound to the logins plugin's `claudeStatuslineCommand(binary, own)`. GAP(logins). */
  readonly claudeStatusline: ClaudeStatuslineCommand;
  /** `<FY_HOME>/config`. */
  readonly configDirectory: string;
  /**
   * The daemon's one fleet publication: every apply runs exclusively under it, so a read of the published
   * fleet never lands between a file moved aside and its replacement (`lib/fleet/publication.ts`).
   * Required, so no composition can apply a fleet its readers are not kept out of.
   */
  readonly publication: FleetPublication;
}

/**
 * The provisioner as the catalogue and the setup use it: ONE call that lands a change's documents and its fleet.
 *
 * A document is one of three kinds, told apart by where it sits. A file of the FLEET folder (the asset tree) is written
 * by the provisioner inside its own rollback boundary with the rest of the plan. A file of the CONFIGURATION folder is
 * written first, all or none, by the config writer (`ConfigPort.writeAll`): the files are the source of truth, so they
 * land before the plan, and a plan that then fails is republished from them. Anything else is refused in a sentence and
 * nothing is changed.
 *
 * A configuration set the owner's judge HOLDS (a loosening, an added `${secret:NAME}`) is held whole: nothing of the
 * change is written, the fleet is not touched, and the sentence says so. The configuration is loaded again once a change
 * that wrote configuration returns, because readers answer from the last load.
 */
export function configThenFleet(
  inner: FleetCatalogServiceDeps['provisioner'],
  writer: RuntimeConfigWriter,
  config: Pick<ConfigFilesPort<AccountModel>, 'load'>,
  configDirectory: string,
  disk: Pick<AdapterHost['disk'], 'contains'>,
): FleetCatalogServiceDeps['provisioner'] {
  return {
    preview: async plan => await inner.preview(plan),
    apply: async (plan, documents = []) => {
      const inFleet = documents.filter(document => disk.contains(document.path));
      const inConfig = documents.filter(
        document => !disk.contains(document.path) && !relative(configDirectory, document.path).startsWith('..'),
      );
      const elsewhere = documents.filter(document => !inFleet.includes(document) && !inConfig.includes(document));
      if (elsewhere.length > 0) {
        throw new Error(
          `refusing to write ${elsewhere.map(document => document.path).join(', ')}: it is neither a file of the fleet folder nor of the configuration folder; nothing was changed`,
        );
      }
      try {
        await writer.write(inConfig);
        return await inner.apply(plan, inFleet);
      } finally {
        if (inConfig.length > 0) await config.load().catch(() => undefined);
      }
    },
  };
}

/** Whether every launcher script a plan would write under `binDirectory` already holds exactly that content. */
async function wrappersCurrent(
  files: Pick<HostFiles, 'readText'>,
  binDirectory: string,
  operations: FleetModelApplyPlan['operations'],
): Promise<boolean> {
  for (const operation of operations) {
    if (operation.kind !== 'file' || relative(binDirectory, operation.path).startsWith('..')) continue;
    const onDisk = await files.readText(operation.path).catch(() => undefined);
    if (onDisk !== operation.content) return false;
  }
  return true;
}

/**
 * The catalogue's collaborators over this machine's files.
 *
 * Its own provisioner, over the fleet root: the apply claim is a folder beside the manifest, so two provisioners in
 * one daemon still apply one at a time.
 */
export function fileFleetCatalogDeps(options: FileFleetCatalogOptions): FleetCatalogServiceDeps {
  const { host, paths, userHome, sessionRecords: records } = options;
  const layout: FleetLayout = {
    stateHome: paths.home,
    userHome,
    fleetDirectory: paths.fleet,
    binDirectory: join(paths.fleet, 'bin'),
    homesDirectory: join(paths.fleet, 'homes'),
    assetsDirectory: join(paths.fleet, 'assets'),
    manifestPath: paths.fleetManifest,
    defaultHomeDirectories: { claude: join(userHome, '.claude'), codex: join(userHome, '.codex') },
  };
  // Strict, unlike a component read: an `ids.json` that exists and cannot be read must refuse the
  // change, because planning without it would give every runtime a new id and a new directory.
  // Read between applies: mid-apply the file is moved aside, and a plan made from that gap would be
  // exactly that — every runtime re-minted — for a republish that overlapped another one.
  const ids = async (): Promise<RuntimeIds | undefined> =>
    await options.publication.reading(async () => {
      const text = await host.files.readText(runtimeIdsPath(paths.fleet));
      return text === undefined ? undefined : parseRuntimeIds(JSON.parse(text));
    });
  return {
    document: async fresh =>
      await readConfigAccountDocument(options.config, { configDirectory: options.configDirectory }, fresh),
    // Through the fleet's assets and the harness homes only (S43): any other path reads as "not there", and the
    // configuration check has already said why.
    readAsset: async path => await host.disk.readSource(path, MAX_COMPONENT_BYTES),
    documentRevision: async path => await documentRevision(host.files, path),
    ids,
    locate: options.locate,
    commandExists: command => host.commands.which(command) !== undefined,
    wrappersCurrent: async plan =>
      await options.publication.reading(
        async () => await wrappersCurrent(host.files, layout.binDirectory, plan.operations),
      ),
    sessionStatuses: async () => await options.sessionStatuses(),
    ...(records === undefined
      ? {}
      : {
          sessionRecords: async () => await records.sessionRecords(),
          renameSessions: async rename => await records.renameSessions(rename),
        }),
    machineName: options.machineName,
    credentials: options.credentials,
    loginChanges: options.loginChanges,
    configWriter: options.configWriter,
    provisioner: configThenFleet(
      new FileFleetProvisioner(
        host.disk,
        host.claimFor,
        options.sharedHistory,
        // Exclusive around the file mutation ONLY — after the claim is held, before the configuration is reloaded,
        // since a load can republish and that must queue behind this apply rather than run inside it (S67).
        async mutate => await options.publication.publishing(mutate),
      ),
      options.configWriter,
      options.config,
      options.configDirectory,
      host.disk,
    ),
    layout,
    // The published manifest, read between applies (S67): the republish asks whether anything would change.
    publishedManifest: async () =>
      await options.publication.reading(async () => await readFleetManifest(host.files, layout.manifestPath)),
    mint: () => crypto.randomUUID(),
    mintId: () => crypto.randomUUID().replaceAll('-', '').slice(0, 22),
    now: host.now,
    claudeStatusline: options.claudeStatusline,
    fyCommand: options.clientName,
    ...(options.hostCodexHome === undefined ? {} : { hostCodexHome: options.hostCodexHome }),
    // Measured on the pinned Claude (measured-facts.md); nothing is launched to find out.
    acceptsAutoPermissionMode: true,
  };
}
