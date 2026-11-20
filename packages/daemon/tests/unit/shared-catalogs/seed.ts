/** A catalogs store as the service leaves it, built from first principles (not by publishing through the service). */
import type { CatalogSkill, SharedCatalogItem } from '@ferretry/protocol';
import type { CatalogsDocument, StoredSharedItem } from '../../../src/lib/shared-catalogs/document.ts';
import {
  canonicalOrRefuse,
  fileCountOf,
  freezeItem,
  sharedCopy,
  skillOf,
} from '../../../src/lib/shared-catalogs/freeze.ts';
import { mcpSetupOf } from '../../../src/lib/shared-catalogs/mcp-source.ts';
import { crypto, harnessServer, type Rig, SKILL_MD, SKILL_PATH, stdio } from './support.ts';

const T = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
export const SEED_CATALOG = `cat_${'B'.repeat(22)}`;
export const SEED_OTHER = `cat_${'C'.repeat(22)}`;
export const SEED_SKILL = `itm_${'S'.repeat(22)}`;
const SEED_MCP = `itm_${'M'.repeat(22)}`;
export const SEED_ALONE = `itm_${'L'.repeat(22)}`;
/** An MCP setup that carries a harness, which only a fleet component does. */
const SEED_HARNESS = `itm_${'H'.repeat(22)}`;

export interface Seed {
  readonly document: CatalogsDocument;
  /** Digest → canonical text, the shared copies the store keeps beside the document. */
  readonly blobs: ReadonlyMap<string, string>;
}

/** Two catalogs: one with a skill (two versions), an MCP setup (withdrawn) and a live MCP; one with a single MCP. */
export async function seededStore(r: Rig): Promise<Seed> {
  const publisher = (r.identity as NonNullable<Rig['identity']>).daemonId;
  const blobs = new Map<string, string>();
  const versionOf = async (
    catalogId: string,
    itemId: string,
    version: number,
    name: string,
    body: Parameters<typeof freezeItem>[0]['body'],
    day: number,
    harness?: 'claude' | 'codex' | 'generic',
    sourceId = `id-${name}`,
  ): Promise<StoredSharedItem['versions'][number]> => {
    const summary = body.kind === 'skill' ? 'Does the demo thing' : `${name} summary`;
    const item: SharedCatalogItem = freezeItem({
      publisher,
      catalogId,
      itemId,
      itemVersion: version,
      name,
      summary,
      body,
      ...(harness === undefined ? {} : { harness }),
    });
    const own = await canonicalOrRefuse(crypto, item);
    const shared = await canonicalOrRefuse(crypto, sharedCopy(item));
    blobs.set(shared.digest, shared.text);
    const fileCount = fileCountOf(item);
    return {
      version,
      publishedAt: T(day),
      summary,
      source:
        body.kind === 'skill'
          ? { kind: 'skill' as const, path: '/home/me/.claude/skills/demo/SKILL.md' }
          : { kind: 'mcp' as const, id: sourceId, name },
      contentDigest: shared.digest,
      size: shared.size,
      ...(fileCount === undefined ? {} : { fileCount }),
      bindings: { [catalogId]: { digest: own.digest, size: own.size } },
    };
  };
  const skill = (notes: string) =>
    ({
      kind: 'skill' as const,
      skill: skillOf([
        { path: 'SKILL.md', content: SKILL_MD },
        { path: 'notes.txt', content: notes },
      ]) as CatalogSkill,
    }) as const;
  const mcp = (name: string, server = stdio(name)) => {
    const converted = mcpSetupOf(server);
    if (!converted.ok) throw new Error('fixture');
    return { kind: 'mcp' as const, mcp: converted.setup };
  };
  const item = (
    itemId: string,
    kind: 'skill' | 'mcp',
    name: string,
    ownSummary: boolean,
    versions: StoredSharedItem['versions'],
    harness?: 'claude',
  ): StoredSharedItem => ({
    itemId,
    kind,
    name,
    ...(harness === undefined ? {} : { harness }),
    ownSummary,
    createdAt: (versions[0] as { publishedAt: string }).publishedAt,
    current: (versions[versions.length - 1] as { version: number }).version,
    versions,
  });
  const document: CatalogsDocument = {
    schemaVersion: 3,
    items: [
      item(SEED_SKILL, 'skill', 'demo', false, [
        await versionOf(SEED_CATALOG, SEED_SKILL, 1, 'demo', skill('notes'), 2),
        await versionOf(SEED_CATALOG, SEED_SKILL, 2, 'demo', skill('new notes'), 4),
      ]),
      item(SEED_MCP, 'mcp', 'files', true, [await versionOf(SEED_CATALOG, SEED_MCP, 1, 'files', mcp('files'), 3)]),
      item(SEED_ALONE, 'mcp', 'files', true, [await versionOf(SEED_OTHER, SEED_ALONE, 1, 'files', mcp('files'), 3)]),
      item(
        SEED_HARNESS,
        'mcp',
        'docs',
        true,
        [
          await versionOf(
            SEED_OTHER,
            SEED_HARNESS,
            1,
            'docs',
            mcp('docs', harnessServer('docs')),
            3,
            'claude',
            harnessServer('docs').id,
          ),
        ],
        'claude',
      ),
    ],
    catalogs: [
      {
        id: SEED_CATALOG,
        name: 'Team tools',
        description: 'for us',
        publisherName: 'studio',
        visibility: 'members',
        revision: 6,
        issuedAt: T(5),
        createdAt: T(1),
        entries: [
          { itemId: SEED_SKILL, addedAt: T(2) },
          { itemId: SEED_MCP, addedAt: T(3), withdrawnAt: T(5) },
        ],
      },
      {
        id: SEED_OTHER,
        name: 'Other',
        description: '',
        publisherName: 'studio',
        visibility: 'members',
        revision: 2,
        issuedAt: T(3),
        createdAt: T(1),
        entries: [
          { itemId: SEED_ALONE, addedAt: T(3) },
          { itemId: SEED_HARNESS, addedAt: T(3) },
        ],
      },
    ],
  };
  return { document, blobs };
}

/** Puts a store under a rig: the document and its shared copies, with the sources the items were frozen from. */
export function install(r: Rig, seed: Seed): void {
  r.documents.document = seed.document;
  r.servers = [...r.servers, harnessServer('docs')];
  r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'notes.txt': 'new notes' });
  for (const [digest, text] of seed.blobs) r.blobs.blobs.set(digest, text);
}
