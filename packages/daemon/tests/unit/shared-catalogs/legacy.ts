/** A catalogs store as the version 1 daemon left it, built from first principles (not from the migration). */
import { readFileSync } from 'node:fs';
import type { CatalogSkill, SharedCatalogItem } from '@ferretry/protocol';
import type { CatalogsDocumentV1 } from '../../../src/lib/shared-catalogs/document-v1.ts';
import { canonicalOrRefuse, freezeItem, NORMALISED_ITEM_ID, skillOf } from '../../../src/lib/shared-catalogs/freeze.ts';
import { mcpSetupOf } from '../../../src/lib/shared-catalogs/mcp-source.ts';
import { crypto, harnessServer, type Rig, SKILL_MD, SKILL_PATH, stdio } from './support.ts';

const T = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
export const LEGACY_CATALOG = `cat_${'B'.repeat(22)}`;
export const LEGACY_OTHER = `cat_${'C'.repeat(22)}`;
export const LEGACY_SKILL = `itm_${'S'.repeat(22)}`;
export const LEGACY_MCP = `itm_${'M'.repeat(22)}`;
export const LEGACY_ALONE = `itm_${'L'.repeat(22)}`;
/** An MCP setup that carries a harness, which only a fleet component does. */
export const LEGACY_HARNESS = `itm_${'H'.repeat(22)}`;

export interface Legacy {
  readonly document: CatalogsDocumentV1;
  readonly text: string;
  /** Digest → canonical text, the frozen files a version 1 daemon had on disk. */
  readonly blobs: ReadonlyMap<string, string>;
  /** Every item as each version 1 manifest lists it, latest version of each live item. */
  readonly items: ReadonlyMap<string, readonly SharedCatalogItem[]>;
}

/** Two catalogs: one with a skill (two versions), an MCP setup (withdrawn) and a live MCP; one with a single MCP. */
export async function legacyState(r: Rig): Promise<Legacy> {
  const publisher = (r.identity as NonNullable<Rig['identity']>).daemonId;
  const blobs = new Map<string, string>();
  const frozen = new Map<string, SharedCatalogItem[]>();
  const versionOf = async (
    catalogId: string,
    itemId: string,
    version: number,
    name: string,
    body: Parameters<typeof freezeItem>[0]['body'],
    day: number,
    harness?: 'claude' | 'codex' | 'generic',
    sourceId = `id-${name}`,
  ) => {
    const summary = body.kind === 'skill' ? 'Does the demo thing' : `${name} summary`;
    const item = freezeItem({
      publisher,
      catalogId,
      itemId,
      itemVersion: version,
      name,
      summary,
      body,
      ...(harness === undefined ? {} : { harness }),
    });
    const copy = await canonicalOrRefuse(crypto, item);
    blobs.set(copy.digest, copy.text);
    frozen.set(itemId, [...(frozen.get(itemId) ?? []), item]);
    return {
      version,
      digest: copy.digest,
      contentDigest: (await canonicalOrRefuse(crypto, { ...item, itemId: NORMALISED_ITEM_ID, itemVersion: 1 })).digest,
      size: copy.size,
      publishedAt: T(day),
      summary,
      source:
        body.kind === 'skill'
          ? { kind: 'skill' as const, path: '/home/me/.claude/skills/demo/SKILL.md' }
          : { kind: 'mcp' as const, id: sourceId, name },
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
  const document: CatalogsDocumentV1 = {
    schemaVersion: 1,
    catalogs: [
      {
        id: LEGACY_CATALOG,
        name: 'Team tools',
        description: 'for us',
        publisherName: 'studio',
        visibility: 'members',
        revision: 6,
        issuedAt: T(5),
        createdAt: T(1),
        items: [
          {
            itemId: LEGACY_SKILL,
            kind: 'skill',
            name: 'demo',
            ownSummary: false,
            versions: [
              await versionOf(LEGACY_CATALOG, LEGACY_SKILL, 1, 'demo', skill('notes'), 2),
              await versionOf(LEGACY_CATALOG, LEGACY_SKILL, 2, 'demo', skill('new notes'), 4),
            ],
          },
          {
            itemId: LEGACY_MCP,
            kind: 'mcp',
            name: 'files',
            ownSummary: true,
            withdrawnAt: T(5),
            versions: [await versionOf(LEGACY_CATALOG, LEGACY_MCP, 1, 'files', mcp('files'), 3)],
          },
        ],
      },
      {
        id: LEGACY_OTHER,
        name: 'Other',
        description: '',
        publisherName: 'studio',
        visibility: 'members',
        revision: 2,
        issuedAt: T(3),
        createdAt: T(1),
        items: [
          {
            itemId: LEGACY_ALONE,
            kind: 'mcp',
            name: 'files',
            ownSummary: true,
            versions: [await versionOf(LEGACY_OTHER, LEGACY_ALONE, 1, 'files', mcp('files'), 3)],
          },
          {
            itemId: LEGACY_HARNESS,
            kind: 'mcp',
            name: 'docs',
            ownSummary: true,
            harness: 'claude',
            versions: [
              await versionOf(
                LEGACY_OTHER,
                LEGACY_HARNESS,
                1,
                'docs',
                mcp('docs', harnessServer('docs')),
                3,
                'claude',
                harnessServer('docs').id,
              ),
            ],
          },
        ],
      },
    ],
  };
  return { document, text: `${JSON.stringify(document, undefined, 2)}\n`, blobs, items: frozen };
}

/**
 * What origin/main's version 1 service answered for this very store, with the fixed test identity (see
 * `golden/README.md`): a file written once by the old code, so the byte identity is held to the old daemon
 * and not to a copy of its logic kept here.
 */
export const GOLDEN: Readonly<Record<string, unknown>> = JSON.parse(
  readFileSync(new URL('./golden/main-output.json', import.meta.url), 'utf8'),
);

/** The store text and frozen files the golden answers were made from. */
export const GOLDEN_STATE = JSON.parse(readFileSync(new URL('./golden/v1-state.json', import.meta.url), 'utf8')) as {
  readonly text: string;
  readonly blobs: Readonly<Record<string, string>>;
};

/** Puts a version 1 store under a rig: the file as text and its frozen files, as an upgrade finds them. */
export function install(r: Rig, legacy: Legacy): void {
  r.documents.raw = { version: 1, doc: legacy.document, text: legacy.text };
  r.servers = [...r.servers, harnessServer('docs')];
  r.tree.set(SKILL_PATH, { 'SKILL.md': SKILL_MD, 'notes.txt': 'new notes' });
  for (const [digest, text] of legacy.blobs) r.blobs.blobs.set(digest, text);
}
