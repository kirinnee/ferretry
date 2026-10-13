/**
 * The files the account model's catalogue reads (docs/design/account-model.md §5.3): `config.yaml`
 * with the digest it was read at, the component documents it names, and what a document is now.
 *
 * Reads only. Every write a reviewed change makes goes through the provisioner, inside its rollback
 * boundary, so nothing here can leave a machine half-changed.
 */
import {
  ABSENT_DOCUMENT_REVISION,
  claudeStatuslineCommand,
  type FleetLayout,
  parseAccountConfigText,
  parseAccountModel,
  parseRuntimeIds,
  type RuntimeIds,
  runtimeIdsPath,
  SharedHistoryMigration,
} from '@ferretry/fleet';
import { FileFleetProvisioner, FileSharedHistoryFileSystem } from '@ferretry/fleet/adapters';
import { SessionStateSchema } from '@ferretry/protocol';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountDocumentReading, FleetCatalogServiceDeps } from '../../lib/fleet/catalog-service.ts';
import type { FoundationPaths } from '../../lib/paths.ts';

/** The largest component document the catalogue reads; a larger one is reported as unreadable. */
const MAX_COMPONENT_BYTES = 1024 * 1024;

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const digest = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/**
 * The machine's configuration, and no document as an empty model. Throws when the file exists and
 * cannot be read or parsed — and `RetiredFleetConfigError` when it is still in the old account format,
 * which is refused rather than converted, and left exactly as it is.
 */
export async function readAccountDocument(path: string): Promise<AccountDocumentReading> {
  let raw: Uint8Array;
  try {
    raw = await readFile(path);
  } catch (error) {
    if (missing(error)) {
      return { format: 'none', model: parseAccountModel({ version: 2 }), revision: ABSENT_DOCUMENT_REVISION };
    }
    throw error;
  }
  const model = parseAccountConfigText(new TextDecoder().decode(raw), path);
  return { format: 'version-2', model, revision: digest(raw) };
}

/** One component document's text, or `undefined` when it is absent, not a file, too large or unreadable. */
export async function readComponentText(path: string): Promise<string | undefined> {
  try {
    const entry = await stat(path);
    if (!entry.isFile() || entry.size > MAX_COMPONENT_BYTES) return undefined;
    return await readFile(path, 'utf8');
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

/** What the composition root hands the catalogue: its own collaborators, and nothing it would build twice. */
export interface FileFleetCatalogOptions {
  readonly paths: Pick<FoundationPaths, 'home' | 'fleet' | 'fleetManifest'>;
  readonly userHome: string;
  readonly hostCodexHome?: string;
  /** Every session's state document, raw. */
  sessionStates(): Promise<readonly unknown[]>;
  readonly credentials: FleetCatalogServiceDeps['credentials'];
  readonly confirmChange: FleetCatalogServiceDeps['confirmChange'];
  readonly locate: FleetCatalogServiceDeps['locate'];
  readonly machineName: () => string;
  /** What a person types to run this binary: the wrapper's history claim and statusLine run it. */
  readonly clientName: string;
}

/**
 * The catalogue's collaborators over this machine's files.
 *
 * Its own provisioner, over this daemon's state home and the user's home: the apply claim is a file
 * beside the manifest, so two provisioners in one daemon still apply one at a time.
 */
export function fileFleetCatalogDeps(options: FileFleetCatalogOptions): FleetCatalogServiceDeps {
  const { paths, userHome } = options;
  const allowedRoots = [paths.home, userHome];
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
    document: async () => await readAccountDocument(join(paths.fleet, 'config.yaml')),
    readAsset: readComponentText,
    documentRevision,
    ids,
    locate: options.locate,
    commandExists: command => Bun.which(command) !== null,
    sessionStatuses: async () =>
      (await options.sessionStates()).flatMap(raw => {
        const state = SessionStateSchema.safeParse(raw);
        return state.success ? [state.data.status] : [];
      }),
    machineName: options.machineName,
    credentials: options.credentials,
    confirmChange: options.confirmChange,
    provisioner: new FileFleetProvisioner(
      allowedRoots,
      new SharedHistoryMigration(new FileSharedHistoryFileSystem(allowedRoots)),
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
