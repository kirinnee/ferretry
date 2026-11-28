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
import { HostHarnessScanner, MAX_SKILL_FILE_BYTES, MAX_SKILL_TOTAL_BYTES } from './host-harness-scan.ts';
import type { AdapterHost, ConfigFileService, HostFiles } from './ports.ts';
import { isSupportedKind } from '../lib/harness-kind.ts';

/** The largest file a folder read carries; a larger one is skipped and named. */
const MAX_FOLDER_FILE_BYTES = MAX_SKILL_FILE_BYTES;
/** The most bytes one folder read takes in all (the per-file cap times the file cap is 125 MiB); the rest are skipped and named. */
export const MAX_FOLDER_TOTAL_BYTES = MAX_SKILL_TOTAL_BYTES;
/** The most files one folder read takes; the rest are skipped and named. */
export const MAX_FOLDER_FILES = 500;

/** The most names (files, folders, links) one folder read looks at; the walk stops there and the rest are named as skipped. */
export const MAX_FOLDER_ENTRIES = 5_000;
/** The deepest folder one folder read enters; a deeper one is skipped and named. */
export const MAX_FOLDER_DEPTH = 12;

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
  let total = 0;
  let looked = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    const names = await files.list(join(root, relative));
    if (names === undefined) return;
    for (const name of names.toSorted()) {
      if (SKIPPED_ENTRIES.has(name)) continue;
      const path = relative === '' ? name : `${relative}/${name}`;
      if (looked >= MAX_FOLDER_ENTRIES) {
        // One line for the walk's end, not one per name: the folder is wider or deeper than an import reads.
        if (looked === MAX_FOLDER_ENTRIES) skipped.push({ path, reason: 'the folder has too many entries to read' });
        looked += 1;
        return;
      }
      looked += 1;
      const entry = await files.lstat(join(root, path));
      if (entry === undefined) continue;
      if (entry.kind === 'directory') {
        if (depth >= MAX_FOLDER_DEPTH) skipped.push({ path, reason: 'it is nested too deep' });
        else await walk(path, depth + 1);
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
      if (total + entry.size > MAX_FOLDER_TOTAL_BYTES) {
        skipped.push({ path, reason: 'the folder is larger than an import takes' });
        continue;
      }
      try {
        // The size the listing gave is only a first look: a file can grow after it, so the read itself is bounded, one byte
        // past the cap, and what is charged is what was read.
        const bytes = await files.readBytes(join(root, path), MAX_FOLDER_FILE_BYTES + 1);
        if (bytes === undefined) continue;
        if (bytes.length > MAX_FOLDER_FILE_BYTES) {
          skipped.push({ path, reason: 'it is too large' });
          continue;
        }
        if (total + bytes.length > MAX_FOLDER_TOTAL_BYTES) {
          skipped.push({ path, reason: 'the folder is larger than an import takes' });
          continue;
        }
        total += bytes.length;
        found.push({ path, content: decoder.decode(bytes) });
      } catch {
        skipped.push({ path, reason: 'it is not text' });
      }
    }
  };
  await walk('', 0);
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
 * GAP(runtimes): that service is the kernel's config layer, which writes only a plugin's OWN files; a merge that writes
 * other plugins' files is the cross-owner writer the owner deferred (!A525 item 10).
 *
 * @pending runtimes/runtimes-fleets-catalogue-setup: the settings merge of a copy writes other plugins' files
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
  /** The environment this daemon inherited: each harness's home variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) is read from it by its kit's `homeEnv`. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Safe Logins contract facts; host sign-in files stay opaque. */
  readonly logins: Pick<import('@ferretry/plugin-logins/contract').LoginsApi, 'list'>;
  readonly tools: FleetSetupServiceDeps['tools'];
  /** Where an imported component another plugin owns is written: that plugin's own door. Absent: none is written. */
  readonly components?: FleetSetupServiceDeps['components'];
  /** Logins' door for an imported harness `env`; absent, the `env` is left out of every login and the result says so. */
  readonly loginEnvImport?: FleetSetupServiceDeps['loginEnvImport'];
  /** The configuration files a copy merges settings into; absent, a copy carrying one is refused. */
  readonly configFiles?: CloneConfigFiles;
  /** This daemon's id as it reports itself; absent until pairing identity is open. */
  readonly daemonId: () => string | undefined;
  /** The secret store's management side. */
  readonly secrets: {
    list(): Promise<readonly { readonly name: string; readonly createdAt: string; readonly updatedAt: string }[]>;
    put(name: string, value: string): Promise<unknown>;
    /** Whether the Vault holds exactly this value under this name from an earlier import's own filing: one boolean. */
    filedSame?(name: string, value: string): Promise<boolean>;
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
    kits: () => catalog.kits?.(),
    files: host.files,
    userHome: layout.userHome,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    // A harness through the daemon's one rule, never a second detector; an MCP command on `PATH`.
    commands: {
      resolve: name => (isSupportedKind(name) ? catalog.locate(name) : host.commands.which(name)),
    },
    logins: options.logins,
    maxDocumentBytes: MAX_HOST_DOCUMENT_BYTES,
  });
  return {
    catalog,
    ...(options.configFiles === undefined ? {} : { configFiles: options.configFiles }),
    scan: async () => await scanner.scan(),
    tools: options.tools,
    ...(options.components === undefined ? {} : { components: options.components }),
    ...(options.loginEnvImport === undefined ? {} : { loginEnvImport: options.loginEnvImport }),
    secrets: {
      names: async () => (await options.secrets.list()).map(secret => secret.name),
      held: async () =>
        (await options.secrets.list()).map(({ name, createdAt, updatedAt }) => ({ name, createdAt, updatedAt })),
      put: async (name, value) => {
        await options.secrets.put(name, value);
      },
      ...(options.secrets.filedSame === undefined
        ? {}
        : { filedSame: options.secrets.filedSame.bind(options.secrets) }),
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
