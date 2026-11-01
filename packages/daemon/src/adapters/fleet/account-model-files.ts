/**
 * The files the account model's catalogue reads (docs/design/account-model.md §5.3,
 * docs/config-files.md): the configuration files in effect with the revision they were read at, the
 * component documents they name, and what a document is now.
 *
 * Reads only. Every write a reviewed change makes goes through the provisioner, inside its rollback
 * boundary, so nothing here can leave a machine half-changed — and every configuration file that write
 * carries is acknowledged first, so the daemon never mistakes the owner's own reviewed change for an
 * unconfirmed loosening.
 */

import { lstat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  ABSENT_DOCUMENT_REVISION,
  type AccountModel,
  type StateHomeFence,
  claudeStatuslineCommand,
  type FleetDocumentWrite,
  type FleetLayout,
  type FleetModelApplyPlan,
  fleetFileEdits,
  parseRuntimeIds,
  RETIRED_FLEET_CONFIG_FILE,
  RetiredFleetConfigError,
  type RuntimeIds,
  type RuntimeRename,
  renamedRuntimeMentions,
  runtimeIdsPath,
  SharedHistoryMigration,
} from '@ferretry/fleet';
import {
  FileFleetProvisioner,
  FileSharedHistoryFileSystem,
  readFencedSource,
  resolveSourceFence,
} from '@ferretry/fleet/adapters';
import { configFilePath, type SessionStatus, SessionStatusSchema } from '@ferretry/protocol';
import type { ConfigFilesService } from '../../lib/config-files/index.ts';
import type { AccountDocumentReading, FleetCatalogServiceDeps } from '../../lib/fleet/catalog-service.ts';
import { exclusiveProvisioner, type FleetPublication } from '../../lib/fleet/publication.ts';
import type { FoundationPaths } from '../../lib/paths.ts';

/** The largest component document the catalogue reads; a larger one is reported as unreadable. */
const MAX_COMPONENT_BYTES = 1024 * 1024;

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const digest = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/** Configuration and component documents are private: they name everything a runtime runs with. */
const DOCUMENT_MODE = 0o600;

/** Where the configuration lives, and where the retired single file would be. */
export interface ConfigAccountLocations {
  /** `<FY_HOME>/config`. */
  readonly configDirectory: string;
  /** `<FY_HOME>/fleet`, where a retired `config.yaml` would still be. */
  readonly fleetDirectory: string;
}

/** Whether a path exists at all, a link included — a retired file is refused even as a link. */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/**
 * The configuration in effect, as the catalogue reads it: the account model the files hold — each at
 * its last good version — and the writes that would move them to another model. Throws
 * `RetiredFleetConfigError` while a retired `fleet/config.yaml` is still there: it is refused rather
 * than converted, and left exactly as it is. `fresh` loads the directory first instead of answering
 * the last load.
 */
export async function readConfigAccountDocument(
  config: Pick<ConfigFilesService, 'inEffect' | 'load'>,
  locations: ConfigAccountLocations,
  fresh = false,
): Promise<AccountDocumentReading> {
  const retired = join(locations.fleetDirectory, RETIRED_FLEET_CONFIG_FILE);
  if (await present(retired)) throw new RetiredFleetConfigError(retired);
  const { evaluation, files } = fresh ? await config.load() : await config.inEffect();
  const model = evaluation.effective.model;
  return {
    format: evaluation.fleetFiles === 0 ? 'none' : 'version-2',
    model,
    revision: evaluation.fleetRevision,
    documents: (next: AccountModel, rename?: RuntimeRename): readonly FleetDocumentWrite[] =>
      [
        ...fleetFileEdits(model, next, files, runtimeFileMoves(rename)),
        ...(rename === undefined ? [] : renamedRuntimeMentions(evaluation.effective, files, rename)),
      ].map(edit => ({
        path: join(locations.configDirectory, edit.path),
        content: edit.content ?? '',
        mode: DOCUMENT_MODE,
        expect: edit.expect,
        ...(edit.content === undefined ? { remove: true as const } : {}),
      })),
  };
}

/** A renamed runtime's file, new path → old path, so it moves with the owner's comments. */
export const runtimeFileMoves = (rename: RuntimeRename | undefined): ReadonlyMap<string, string> =>
  rename === undefined
    ? new Map()
    : new Map([
        [configFilePath({ kind: 'runtime', name: rename.to }), configFilePath({ kind: 'runtime', name: rename.from })],
      ]);

/**
 * The account model this machine declares, or `undefined` for a machine with no fleet files yet.
 * `fresh` (the default) loads the directory first — what a decision about authority needs, such as an
 * agent-control switch that must be in effect the moment it is saved; `false` answers the last load,
 * for a reader that runs on a timer.
 */
export async function readDeclaredAccountModel(
  config: Pick<ConfigFilesService, 'inEffect' | 'load'>,
  locations: ConfigAccountLocations,
  fresh = true,
): Promise<AccountModel | undefined> {
  const reading = await readConfigAccountDocument(config, locations, fresh);
  return reading.format === 'none' ? undefined : reading.model;
}

/**
 * The component-source fence over this daemon's own directories, as configured: no component may read, copy
 * or link a document inside them, the fleet's asset tree excepted (docs/secrets.md#what-the-state-home-fence-refuses).
 */
export const componentSourceFence = (
  paths: Pick<FoundationPaths, 'home' | 'state' | 'config' | 'fleet'>,
): StateHomeFence => ({
  homes: [paths.home, paths.state, paths.config],
  open: [join(paths.fleet, 'assets')],
});

/**
 * One component document's text, or `undefined` when it is absent, not a file, too large, unreadable — or
 * behind the fence, which reads exactly like a document that is not there: the configuration check has
 * already said why (an error at the field), and a body that is never read is never in a runtime.
 */
export async function readComponentText(path: string, fence: StateHomeFence): Promise<string | undefined> {
  try {
    return await readFencedSource(await resolveSourceFence(fence), path, MAX_COMPONENT_BYTES);
  } catch {
    return undefined;
  }
}

/** What a document is now: its sha256, or the absent sentinel. Throws when it exists and cannot be read. */
export async function documentRevision(path: string): Promise<string> {
  try {
    return digest(await readFile(path));
  } catch (error) {
    if (missing(error)) return ABSENT_DOCUMENT_REVISION;
    throw error;
  }
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

/** What the composition root hands the catalogue: its own collaborators, and nothing it would build twice. */
export interface FileFleetCatalogOptions {
  readonly paths: Pick<FoundationPaths, 'home' | 'state' | 'config' | 'fleet' | 'fleetManifest'>;
  readonly userHome: string;
  readonly hostCodexHome?: string;
  /** Every session's status, as its state document says it: {@link sessionStatusOf} reads one. */
  sessionStatuses(): Promise<readonly SessionStatus[]>;
  /** The session records a runtime removal or rename reads and re-points. Absent: neither is known. */
  readonly sessionRecords?: Required<Pick<FleetCatalogServiceDeps, 'sessionRecords' | 'renameSessions'>>;
  readonly credentials: FleetCatalogServiceDeps['credentials'];
  readonly locate: FleetCatalogServiceDeps['locate'];
  readonly machineName: () => string;
  /** What a person types to run this binary: the wrapper's history claim and statusLine run it. */
  readonly clientName: string;
  /** The configuration files: read for the model in effect, and told about every file a change writes. */
  readonly config: Pick<ConfigFilesService, 'inEffect' | 'load' | 'acknowledge' | 'acknowledgeRemoval'>;
  /** `<FY_HOME>/config`. */
  readonly configDirectory: string;
  /**
   * The state home's key files and folders, known to the provisioner's guard by identity so a bind mount of one of
   * them into a runtime is refused (docs/agent-tools.md#component-destinations).
   */
  readonly pinned?: readonly string[];
  /**
   * The daemon's one fleet publication: every apply runs exclusively under it, so a read of the published
   * fleet never lands between a file moved aside and its replacement (`lib/fleet/publication.ts`).
   * Required, so no composition can apply a fleet its readers are not kept out of.
   */
  readonly publication: FleetPublication;
}

/**
 * The provisioner, with every configuration file an apply writes acknowledged first: the owner
 * reviewed exactly that text, so it is in effect as soon as it lands rather than held as an edit
 * nobody confirmed. Acknowledging a text that a refused apply then never writes is harmless — it is
 * accepted only if those exact bytes appear.
 *
 * The configuration is loaded again once an apply that wrote configuration files returns, because
 * readers answer from the last load: the catalogue reads the model straight after its own change, and
 * must find the files it just wrote rather than wait for the watcher to settle on them.
 */
function acknowledgingProvisioner(
  inner: FleetCatalogServiceDeps['provisioner'],
  config: Pick<ConfigFilesService, 'acknowledge' | 'acknowledgeRemoval' | 'load'>,
  configDirectory: string,
): FleetCatalogServiceDeps['provisioner'] {
  return {
    preview: async plan => await inner.preview(plan),
    apply: async (plan, documents = []) => {
      const configFiles = documents.filter(document => !relative(configDirectory, document.path).startsWith('..'));
      for (const document of configFiles) {
        const path = relative(configDirectory, document.path);
        if (document.remove === true) config.acknowledgeRemoval(path);
        else config.acknowledge(path, document.content);
      }
      try {
        return await inner.apply(plan, documents);
      } finally {
        if (configFiles.length > 0) await config.load();
      }
    },
  };
}

/** Whether every launcher script a plan would write under `binDirectory` already holds exactly that content. */
async function wrappersCurrent(binDirectory: string, operations: FleetModelApplyPlan['operations']): Promise<boolean> {
  for (const operation of operations) {
    if (operation.kind !== 'file' || relative(binDirectory, operation.path).startsWith('..')) continue;
    const onDisk = await readFile(operation.path, 'utf8').catch(() => undefined);
    if (onDisk !== operation.content) return false;
  }
  return true;
}

/**
 * The catalogue's collaborators over this machine's files.
 *
 * Its own provisioner, over this daemon's state home and the user's home: the apply claim is a file
 * beside the manifest, so two provisioners in one daemon still apply one at a time.
 */
export function fileFleetCatalogDeps(options: FileFleetCatalogOptions): FleetCatalogServiceDeps {
  const { paths, userHome, sessionRecords: records } = options;
  const allowedRoots = [paths.home, userHome];
  const sourceFence = {
    ...componentSourceFence(paths),
    ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
  };
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
  const ids = async (): Promise<RuntimeIds | undefined> => {
    let text: string;
    try {
      text = await readFile(runtimeIdsPath(paths.fleet), 'utf8');
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    return parseRuntimeIds(JSON.parse(text));
  };
  return {
    document: async fresh =>
      await readConfigAccountDocument(
        options.config,
        { configDirectory: options.configDirectory, fleetDirectory: paths.fleet },
        fresh,
      ),
    readAsset: async path => await readComponentText(path, sourceFence),
    documentRevision,
    ids,
    locate: options.locate,
    commandExists: command => Bun.which(command) !== null,
    wrappersCurrent: async plan => await wrappersCurrent(layout.binDirectory, plan.operations),
    sessionStatuses: async () => await options.sessionStatuses(),
    ...(records === undefined
      ? {}
      : {
          sessionRecords: async () => await records.sessionRecords(),
          renameSessions: async rename => await records.renameSessions(rename),
        }),
    machineName: options.machineName,
    credentials: options.credentials,
    // Exclusive around the file provisioner ONLY: the acknowledging wrapper reloads the configuration
    // afterwards, and a load can republish — which must queue behind this apply, not run inside it.
    provisioner: acknowledgingProvisioner(
      exclusiveProvisioner(
        new FileFleetProvisioner(
          allowedRoots,
          new SharedHistoryMigration(new FileSharedHistoryFileSystem(allowedRoots, sourceFence)),
          {},
          sourceFence,
        ),
        options.publication,
      ),
      options.config,
      options.configDirectory,
    ),
    layout,
    mint: () => crypto.randomUUID(),
    mintId: () => crypto.randomUUID().replaceAll('-', '').slice(0, 22),
    now: () => Date.now(),
    claudeStatusline: own => claudeStatuslineCommand(options.clientName, own),
    fyCommand: options.clientName,
    ...(options.hostCodexHome === undefined ? {} : { hostCodexHome: options.hostCodexHome }),
    // Measured on the pinned Claude (measured-facts.md); nothing is launched to find out.
    acceptsAutoPermissionMode: true,
  };
}
