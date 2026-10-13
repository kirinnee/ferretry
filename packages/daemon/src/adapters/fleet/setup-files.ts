/**
 * The files and processes a machine's setup reads (docs/design/account-model.md §4.3, §4.7, §10.3):
 * the person's own harness setup, folders read as text, the asset tree's skill items, and the
 * migration executor bound to this daemon's credential store.
 *
 * Reads only, except the migration, which is the migration executor's own; every other write the
 * setup service makes goes through the provisioner, inside its rollback boundary.
 */
import {
  FileSeedProvenanceStore,
  FleetMigration,
  HostHarnessScanner,
  type CredentialCommand,
  type MigrationCredentialReader,
  seedProvenancePath,
  type StoredCredentialMaterialReader,
} from '@ferretry/fleet/adapters';
import type { SessionStatus } from '@ferretry/protocol';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { countRunningSessions } from '../../lib/fleet/catalog-service.ts';
import type {
  FleetSetupServiceDeps,
  FolderReading,
  SetupCatalogDeps,
  SetupModelApply,
} from '../../lib/fleet/setup-service.ts';
import type { ToolInstallService } from '../../lib/fleet/tool-install.ts';

/** The largest file a folder read carries; a larger one is skipped and named. */
export const MAX_FOLDER_FILE_BYTES = 256 * 1024;
/** The most files one folder read takes; the rest are skipped and named. */
export const MAX_FOLDER_FILES = 500;

/** Names a folder read never enters: version control and the harness's own bundled skills. */
const SKIPPED_ENTRIES: ReadonlySet<string> = new Set(['.git', '.system', 'node_modules']);

const missing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * One folder, every regular file in it read as UTF-8 text, relative to the folder. A link, a file
 * that is not text or is too large, and anything past the file limit is skipped with the reason,
 * never followed and never truncated. A folder that does not exist reads as empty.
 */
export async function readTextFolder(root: string): Promise<FolderReading> {
  const files: { path: string; content: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const walk = async (relative: string): Promise<void> => {
    let entries: string[];
    try {
      entries = (await readdir(join(root, relative))).toSorted();
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const name of entries) {
      if (SKIPPED_ENTRIES.has(name)) continue;
      const path = relative === '' ? name : `${relative}/${name}`;
      const entry = await lstat(join(root, path));
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path, reason: 'it is a link or a special file' });
        continue;
      }
      if (files.length >= MAX_FOLDER_FILES) {
        skipped.push({ path, reason: 'the folder has too many files' });
        continue;
      }
      if (entry.size > MAX_FOLDER_FILE_BYTES) {
        skipped.push({ path, reason: 'it is too large' });
        continue;
      }
      try {
        files.push({ path, content: decoder.decode(await readFile(join(root, path))) });
      } catch {
        skipped.push({ path, reason: 'it is not text' });
      }
    }
  };
  await walk('');
  return { files, skipped };
}

/** The skill items a skills store holds: one folder per item. Absent reads as none. */
export async function skillItemsIn(directory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .toSorted();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/** What the composition root hands the setup service: its own collaborators, never a second copy. */
export interface FileFleetSetupOptions {
  /** The catalogue's collaborators, so both surfaces read and write one machine the same way. */
  readonly catalog: SetupCatalogDeps;
  readonly platform: string;
  /** `CLAUDE_CONFIG_DIR` / `CODEX_HOME` as this daemon inherited them. */
  readonly claudeConfigDir?: string;
  readonly codexHome?: string;
  /** The platform credential store: reads a login, never hands one out of this adapter. */
  readonly credentials: StoredCredentialMaterialReader & MigrationCredentialReader;
  readonly command: CredentialCommand;
  readonly keychainAccount: string;
  readonly tools: Pick<ToolInstallService, 'plans' | 'install'>;
  /** The secret store's management side. */
  readonly secrets: {
    list(): Promise<readonly { readonly name: string }[]>;
    put(name: string, value: string): Promise<unknown>;
  };
  /** Every session's config and state documents, raw. */
  sessions(): Promise<readonly { readonly config: unknown; readonly state: unknown }[]>;
}

const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/** The largest host document the import reads; anything larger is reported, never truncated. */
const MAX_HOST_DOCUMENT_BYTES = 1024 * 1024;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The setup service's collaborators over this machine's files. */
export function fileFleetSetupDeps(options: FileFleetSetupOptions): FleetSetupServiceDeps {
  const { catalog } = options;
  const layout = catalog.layout;
  const scanner = new HostHarnessScanner({
    userHome: layout.userHome,
    ...(options.claudeConfigDir === undefined ? {} : { claudeConfigDir: options.claudeConfigDir }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    // A harness through the daemon's one rule, never a second detector; an MCP command on `PATH`.
    commands: {
      resolve: name => (name === 'claude' || name === 'codex' ? catalog.locate(name) : (Bun.which(name) ?? undefined)),
    },
    credentials: options.credentials,
    now: () => catalog.now(),
    maxDocumentBytes: MAX_HOST_DOCUMENT_BYTES,
  });
  return {
    catalog,
    scan: async () => await scanner.scan(),
    tools: options.tools,
    secrets: {
      names: async () => (await options.secrets.list()).map(secret => secret.name),
      put: async (name, value) => {
        await options.secrets.put(name, value);
      },
    },
    readFolder: readTextFolder,
    skillItems: async () => await skillItemsIn(join(layout.assetsDirectory, 'skills')),
    migration: (apply: SetupModelApply) =>
      new FleetMigration({
        layout,
        configPath: join(layout.fleetDirectory, 'config.yaml'),
        platform: options.platform,
        credentials: options.credentials,
        command: options.command,
        keychainAccount: options.keychainAccount,
        ...(catalog.hostCodexHome === undefined ? {} : { hostCodexHome: catalog.hostCodexHome }),
        provenance: new FileSeedProvenanceStore(seedProvenancePath(layout.fleetDirectory)),
        sessions: {
          live: async () =>
            (await options.sessions()).flatMap(({ config, state }) => {
              if (!isRecord(config) || !isRecord(state)) return [];
              const status = state.status as SessionStatus;
              if (typeof config.agent !== 'string' || typeof config.id !== 'string') return [];
              return countRunningSessions([status]) === 1 ? [{ session: config.id, accountId: config.agent }] : [];
            }),
        },
        apply,
        now: () => catalog.now(),
      }),
    digest: sha256,
  };
}
