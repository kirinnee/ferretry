import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import type { DaemonIdentity } from '@ferretry/relay';
import { type CatalogsDocument, EMPTY_CATALOGS_DOCUMENT } from '../../../src/lib/shared-catalogs/document.ts';
import type { McpSourceServer } from '../../../src/lib/shared-catalogs/mcp-source.ts';
import type {
  CatalogBlobStore,
  CatalogDocumentStore,
  CatalogIdentitySource,
  RawCatalogs,
} from '../../../src/lib/shared-catalogs/ports.ts';
import { type SharedCatalogDeps, SharedCatalogService } from '../../../src/lib/shared-catalogs/service.ts';
import type {
  SkillFileRead,
  SkillTreeEntry,
  SkillTreeListing,
  SkillTreePort,
} from '../../../src/lib/shared-catalogs/skill-source.ts';

export const crypto = new WebCryptoRelayCrypto();

function toPem(der: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n');
}

async function newIdentity(): Promise<DaemonIdentity> {
  const pair = (await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  return crypto.importDaemonIdentity(toPem(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey)));
}

class MemoryDocuments implements CatalogDocumentStore {
  writes = 0;
  /** What the file holds: a v1 text, a v2 document, or nothing. */
  raw: RawCatalogs = { version: 'none' };
  /** `catalogs.v1.json`, as the upgrade wrote it. */
  backup: string | undefined;
  /** Makes `write` throw, as a full disk would. */
  failWrites = false;
  /** Makes `writeBackupV1` throw. */
  failBackup = false;
  /** Every write to the stores, in order, shared with the blobs. */
  constructor(readonly events: string[] = []) {}

  get document(): CatalogsDocument {
    return this.raw.version === 2 ? this.raw.doc : EMPTY_CATALOGS_DOCUMENT;
  }
  set document(document: CatalogsDocument) {
    this.raw = { version: 2, doc: document };
  }
  async readRaw(): Promise<RawCatalogs> {
    return this.raw;
  }
  async write(document: CatalogsDocument): Promise<void> {
    this.events.push('document');
    if (this.failWrites) throw new Error('disk full');
    this.writes += 1;
    this.document = document;
  }
  async writeBackupV1(text: string): Promise<void> {
    this.events.push('backup');
    if (this.failBackup) throw new Error('disk full');
    this.backup = text;
  }
}

class MemoryBlobs implements CatalogBlobStore {
  constructor(readonly events: string[] = []) {}
  readonly blobs = new Map<string, string>();
  async put(digest: string, text: string): Promise<void> {
    if (!this.blobs.has(digest)) this.blobs.set(digest, text);
    this.events.push(`blob:${digest}`);
  }
  async get(digest: string): Promise<string | undefined> {
    return this.blobs.get(digest);
  }
}

/** A folder tree held in memory: `path` → text, a symlink marker, or raw bytes. */
export class MemoryTree implements SkillTreePort {
  readonly folders = new Map<string, Map<string, Uint8Array | 'symlink' | 'other' | 'deep' | 'hardlink'>>();
  truncated = false;

  set(
    manifestPath: string,
    files: Record<string, string | Uint8Array | 'symlink' | 'other' | 'deep' | 'hardlink'>,
  ): void {
    this.folders.set(
      manifestPath,
      new Map(
        Object.entries(files).map(([path, value]) => [
          path,
          typeof value === 'string' && !['symlink', 'other', 'deep', 'hardlink'].includes(value)
            ? new TextEncoder().encode(value)
            : (value as Uint8Array | 'symlink' | 'other' | 'deep' | 'hardlink'),
        ]),
      ),
    );
  }

  async list(manifestPath: string): Promise<SkillTreeListing | undefined> {
    const folder = this.folders.get(manifestPath);
    if (folder === undefined) return undefined;
    const entries: SkillTreeEntry[] = [...folder].map(([path, value]) =>
      value instanceof Uint8Array ? { path, type: 'file', size: value.length } : { path, type: value, size: 0 },
    );
    return { entries, truncated: this.truncated };
  }

  async read(manifestPath: string, relativePath: string, maxBytes: number): Promise<SkillFileRead> {
    const value = this.folders.get(manifestPath)?.get(relativePath);
    if (!(value instanceof Uint8Array)) return { ok: false, reason: 'unreadable' };
    return value.length > maxBytes ? { ok: false, reason: 'too_big' } : { ok: true, bytes: value };
  }
}

export const SKILL_PATH = '/home/me/.claude/skills/demo/SKILL.md';
export const SKILL_MD = '---\nname: demo\ndescription: Does the demo thing\n---\nBody\n';

export const stdio = (name: string, env: Record<string, string> = {}): McpSourceServer => ({
  id: `id-${name}`,
  name,
  scope: 'user',
  harness: 'claude',
  source: '/home/me/.claude.json',
  declaration: { name, transport: 'stdio', command: 'npx', args: ['-y', name], env },
});

export interface Rig {
  readonly service: SharedCatalogService;
  readonly documents: MemoryDocuments;
  readonly blobs: MemoryBlobs;
  readonly events: string[];
  readonly tree: MemoryTree;
  readonly clock: { ms: number };
  skills: { path: string; name: string }[];
  servers: McpSourceServer[];
  identity: DaemonIdentity | undefined;
  /** The host name the identity source reports; a catalog keeps the one it was made under. */
  readonly publisher: { name: string };
}

export async function rig(overrides: Partial<SharedCatalogDeps> = {}): Promise<Rig> {
  const events: string[] = [];
  const documents = new MemoryDocuments(events);
  const blobs = new MemoryBlobs(events);
  const tree = new MemoryTree();
  tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'notes.txt': 'notes' });
  const clock = { ms: Date.UTC(2026, 0, 1) };
  const state: Rig = {
    documents,
    blobs,
    events,
    tree,
    clock,
    skills: [{ path: SKILL_PATH, name: 'demo' }],
    servers: [stdio('files')],
    identity: await newIdentity(),
    publisher: { name: 'studio' },
  } as Rig;
  const source: CatalogIdentitySource = {
    identity: async () => state.identity,
    publisherName: () => state.publisher.name,
  };
  const service = new SharedCatalogService({
    documents,
    blobs,
    skillTree: tree,
    skills: { list: async () => state.skills },
    mcp: { servers: async () => state.servers },
    identity: source,
    crypto,
    now: () => clock.ms,
    ...overrides,
  });
  return Object.assign(state, { service });
}
