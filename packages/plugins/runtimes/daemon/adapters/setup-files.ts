/**
 * The files a machine's setup reads (docs/design/account-model.md §4.3, §4.7): the person's own
 * harness setup, folders read as text, and the asset tree's skill items.
 *
 * Reads only: every write the setup service makes goes through the provisioner, inside its rollback
 * boundary.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type {
  CloneConfigFiles,
  FleetSetupServiceDeps,
  FolderReading,
  SetupCatalogDeps,
} from '../lib/service/setup-service.ts';
import { HostHarnessScanner } from './host-harness-scan.ts';
import type { AdapterHost, ConfigFileService, HostFiles } from './ports.ts';

/** The largest file a folder read carries; a larger one is skipped and named. */
const MAX_FOLDER_FILE_BYTES = 256 * 1024;
/** The most files one folder read takes; the rest are skipped and named. */
export const MAX_FOLDER_FILES = 500;

/** Names a folder read never enters: version control and the harness's own bundled skills. */
const SKIPPED_ENTRIES: ReadonlySet<string> = new Set(['.git', '.system', 'node_modules']);

/**
 * One folder, every regular file in it read as UTF-8 text, relative to the folder. A link, a file
 * that is not text or is too large, and anything past the file limit is skipped with the reason,
 * never followed and never truncated. A folder that does not exist reads as empty.
 */
export async function readTextFolder(
  files: Pick<HostFiles, 'lstat' | 'list' | 'readBytes'>,
  root: string,
): Promise<FolderReading> {
  const found: { path: string; content: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const walk = async (relative: string): Promise<void> => {
    const names = await files.list(join(root, relative));
    if (names === undefined) return;
    for (const name of names.toSorted()) {
      if (SKIPPED_ENTRIES.has(name)) continue;
      const path = relative === '' ? name : `${relative}/${name}`;
      const entry = await files.lstat(join(root, path));
      if (entry === undefined) continue;
      if (entry.kind === 'directory') {
        await walk(path);
        continue;
      }
      if (entry.kind !== 'file') {
        skipped.push({ path, reason: 'it is a link or a special file' });
        continue;
      }
      if (found.length >= MAX_FOLDER_FILES) {
        skipped.push({ path, reason: 'the folder has too many files' });
        continue;
      }
      if (entry.size > MAX_FOLDER_FILE_BYTES) {
        skipped.push({ path, reason: 'it is too large' });
        continue;
      }
      try {
        const bytes = await files.readBytes(join(root, path));
        if (bytes === undefined) continue;
        found.push({ path, content: decoder.decode(bytes) });
      } catch {
        skipped.push({ path, reason: 'it is not text' });
      }
    }
  };
  await walk('');
  return { files: found, skipped };
}

/** The skill items a skills store holds: one folder per item. Absent reads as none. */
export async function skillItemsIn(
  files: Pick<HostFiles, 'lstat' | 'list'>,
  directory: string,
): Promise<readonly string[]> {
  const names = await files.list(directory);
  if (names === undefined) return [];
  const items: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if ((await files.lstat(join(directory, name)))?.kind === 'directory') items.push(name);
  }
  return items.toSorted();
}

/**
 * The configuration files a copy merges settings into, over the daemon's one {@link ConfigFileService}: the very
 * service `PUT /v1/config/file` writes through, so a copy is validated, refused if the file moved, and held when
 * it loosens exactly as an edit is. It writes as the owner (`'owner'`): the route that reached it is a person's.
 *
 * GAP(kernel): that service is the kernel's config layer; plugins have no config write port.
 *
 * @pending runtimes: the settings merge of a copy needs the config layer's file service
 */
export function cloneConfigFilesOver(service: ConfigFileService): CloneConfigFiles {
  return {
    file: async path => {
      const view = await service.file(path);
      return { exists: view.exists, text: view.text, etag: view.etag };
    },
    effective: async () => {
      const { effective } = (await service.inEffect()).evaluation;
      return { warden: effective.warden, learning: effective.learning, voice: effective.voice };
    },
    validate: async (path, text) =>
      (await service.validate(path, text)).map(issue => ({
        severity: issue.severity,
        message: issue.message,
        ...(issue.line === undefined ? {} : { line: issue.line }),
      })),
    write: async (path, text, ifMatch, mayLoosen) => {
      const written = await service.write(path, text, ifMatch, mayLoosen, 'owner');
      return { outcome: written.outcome };
    },
  };
}

/** What the composition root hands the setup service: its own collaborators, never a second copy. */
export interface FileFleetSetupOptions {
  /** The host: its files, command lookup, record store and the provisioner's apply claim (`./ports.ts`). */
  readonly host: AdapterHost;
  /** The catalogue's collaborators, so both surfaces read and write one machine the same way. */
  readonly catalog: SetupCatalogDeps;
  /** `CLAUDE_CONFIG_DIR` / `CODEX_HOME` as this daemon inherited them. */
  readonly claudeConfigDir?: string;
  readonly codexHome?: string;
  /** Safe Logins contract facts; host sign-in files stay opaque. */
  readonly logins: Pick<import('@ferretry/plugin-logins/contract').LoginsApi, 'list'>;
  readonly tools: FleetSetupServiceDeps['tools'];
  /** The configuration files a copy merges settings into; absent, a copy carrying one is refused. */
  readonly configFiles?: CloneConfigFiles;
  /** This daemon's id as it reports itself; absent until pairing identity is open. */
  readonly daemonId: () => string | undefined;
  /** The secret store's management side. */
  readonly secrets: {
    list(): Promise<readonly { readonly name: string; readonly createdAt: string; readonly updatedAt: string }[]>;
    put(name: string, value: string): Promise<unknown>;
  };
}

const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/** The largest host document the import reads; anything larger is reported, never truncated. */
const MAX_HOST_DOCUMENT_BYTES = 1024 * 1024;

/** The setup service's collaborators over this machine's files. */
export function fileFleetSetupDeps(options: FileFleetSetupOptions): FleetSetupServiceDeps {
  const { catalog, host } = options;
  const keyWriter = host.texts;
  // The claim every fleet apply takes, keyed the one way the provisioner keys it (beside the manifest).
  const applyLock = host.claimFor(catalog.layout.manifestPath);
  // One read-modify-write of the clone record while holding the fleet apply claim. An apply publishes this same
  // file inside that claim, so while it is held no apply can land between the read and the write: the change is
  // made from what the last apply left, and the next apply's own revision check refuses a plan older than it.
  // Two updates in this daemon take the claim one after the other, so neither reads what the other is about to write.
  const exclusively = async (
    path: string,
    change: (current: string | undefined) => string | undefined,
  ): Promise<boolean> => {
    const token = await applyLock.acquire();
    let wrote = false;
    let failure: { readonly error: unknown } | undefined;
    try {
      const next = change((await keyWriter.read(path)) ?? undefined);
      if (next !== undefined) {
        await keyWriter.write(path, next);
        wrote = true;
      }
    } catch (error) {
      failure = { error };
    }
    const residue = await applyLock.release(token);
    if (failure !== undefined) throw failure.error;
    // A claim that could not be cleared blocks every later apply; say so rather than lose it.
    if (residue !== undefined) {
      throw new Error(`the record update finished, but the exclusive apply claim at ${residue} could not be cleared`);
    }
    return wrote;
  };
  const layout = catalog.layout;
  const scanner = new HostHarnessScanner({
    files: host.files,
    userHome: layout.userHome,
    ...(options.claudeConfigDir === undefined ? {} : { claudeConfigDir: options.claudeConfigDir }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    // A harness through the daemon's one rule, never a second detector; an MCP command on `PATH`.
    commands: {
      resolve: name => (name === 'claude' || name === 'codex' ? catalog.locate(name) : host.commands.which(name)),
    },
    logins: options.logins,
    maxDocumentBytes: MAX_HOST_DOCUMENT_BYTES,
  });
  return {
    catalog,
    ...(options.configFiles === undefined ? {} : { configFiles: options.configFiles }),
    scan: async () => await scanner.scan(),
    tools: options.tools,
    secrets: {
      names: async () => (await options.secrets.list()).map(secret => secret.name),
      held: async () =>
        (await options.secrets.list()).map(({ name, createdAt, updatedAt }) => ({ name, createdAt, updatedAt })),
      put: async (name, value) => {
        await options.secrets.put(name, value);
      },
    },
    readFolder: async path => await readTextFolder(host.files, path),
    skillItems: async () => await skillItemsIn(host.files, join(layout.assetsDirectory, 'skills')),
    digest: sha256,
    daemonId: options.daemonId,
    randomBytes: length => new Uint8Array(randomBytes(length)),
    exportKeys: {
      read: async path => (await keyWriter.read(path)) ?? undefined,
      write: async (path, text) => {
        await keyWriter.write(path, text);
      },
    },
    cloneBase: {
      read: async path => (await keyWriter.read(path)) ?? undefined,
      // Under the fleet apply claim: one at a time, and never between an apply's read and its publish.
      update: exclusively,
    },
  };
}
