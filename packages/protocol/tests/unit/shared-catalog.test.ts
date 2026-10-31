import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import * as install from '../../src/lib/catalog-install.ts';
import * as catalog from '../../src/lib/shared-catalog.ts';
import {
  CATALOG_MANIFEST_SIGNATURE_LABEL,
  CATALOG_SKILL_FILE_MAX_BYTES,
  catalogDigestOf,
  catalogManifestSignedBytes,
  catalogSecretPlaceholders,
  CatalogLabelSchema,
  CatalogMcpSetupSchema,
  CatalogSkillSchema,
  readSharedCatalogFile,
  SHARED_CATALOG_FILE_MAX_BYTES,
  SharedCatalogFileSchema,
  SharedCatalogItemSchema,
  SharedCatalogManifestSchema,
} from '../../src/lib/shared-catalog.ts';
import * as review from '../../src/lib/shared-catalog-review.ts';

const PUBLISHER = `fy_daemon_${'P'.repeat(43)}`;
const CATALOG = `cat_${'c'.repeat(22)}`;
const SKILL_ID = `itm_${'s'.repeat(22)}`;
const MCP_ID = `itm_${'m'.repeat(22)}`;
const DIGEST = `sha256:${'0'.repeat(64)}`;
const AT = '2026-10-31T09:00:00.000Z';
const SPKI = 'A'.repeat(59);
const SIG = 'B'.repeat(86);
/** Right-to-left override and left-to-right isolate, by code point so the source holds neither. */
const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);

const skillItem = (
  files: readonly { path: string; content: string }[] = [{ path: 'SKILL.md', content: '# pdf\n' }],
) => ({
  format: 'ferretry-catalog-item',
  version: 1,
  publisher: PUBLISHER,
  catalogId: CATALOG,
  itemId: SKILL_ID,
  itemVersion: 2,
  name: 'pdf-tools',
  summary: 'Split, merge and OCR PDFs',
  kind: 'skill',
  skill: { files },
});

const mcpItem = (mcp: unknown) => ({
  format: 'ferretry-catalog-item',
  version: 1,
  publisher: PUBLISHER,
  catalogId: CATALOG,
  itemId: MCP_ID,
  itemVersion: 1,
  name: 'github',
  summary: 'GitHub issues',
  kind: 'mcp',
  mcp,
});

const COMMAND = {
  transport: 'command',
  command: 'npx',
  args: ['-y', '@acme/github-mcp@1.4.2', '--read-only'],
  env: { GITHUB_TOKEN: '${secret:GITHUB_TOKEN}', LOG_LEVEL: 'info' },
};

const entry = (itemId: string, kind: string, name: string, version: number) => ({
  itemId,
  kind,
  name,
  summary: kind === 'skill' ? 'Split, merge and OCR PDFs' : 'GitHub issues',
  version,
  digest: DIGEST,
  size: 100,
  publishedAt: AT,
});

const manifest = (overrides: Record<string, unknown> = {}) => ({
  format: 'ferretry-catalog-manifest',
  version: 1,
  publisher: PUBLISHER,
  publisherName: 'kirin-box',
  catalogId: CATALOG,
  name: "Kirin's skills",
  description: 'Things I use.\nAll of them.',
  visibility: 'members',
  revision: 3,
  issuedAt: AT,
  items: [entry(SKILL_ID, 'skill', 'pdf-tools', 2), entry(MCP_ID, 'mcp', 'github', 1)],
  withdrawn: [],
  ...overrides,
});

const file = (items: readonly unknown[], overrides: Record<string, unknown> = {}) => ({
  format: 'ferretry-catalog-file',
  version: 1,
  exportedAt: AT,
  signedManifest: { manifest: manifest(overrides), spki: SPKI, sig: SIG },
  items,
});

describe('shared catalog schemas', () => {
  it('accepts a skill, an MCP setup, a manifest and a file — and returns exactly what it was given', () => {
    // A signature covers the canonical JSON of the PARSED document, so no schema may transform one.
    const cases: readonly (readonly [z.ZodType, unknown])[] = [
      [SharedCatalogItemSchema, skillItem()],
      [SharedCatalogItemSchema, mcpItem(COMMAND)],
      [
        SharedCatalogItemSchema,
        mcpItem({ transport: 'url', url: 'https://mcp.example.com/v1', auth: 'oauth', oauth: { clientId: 'abc' } }),
      ],
      [SharedCatalogManifestSchema, manifest()],
      [SharedCatalogFileSchema, file([skillItem(), mcpItem(COMMAND)])],
    ];
    for (const [schema, value] of cases) expect(schema.parse(value)).toEqual(value as never);
  });

  it('refuses spaces at the ends of a label rather than trimming them', () => {
    expect(CatalogLabelSchema.safeParse(' kirin-box').success).toBe(false);
    expect(CatalogLabelSchema.safeParse('kirin-box ').success).toBe(false);
  });

  it('refuses control and text-direction characters in a label, and line breaks outside a description', () => {
    for (const label of [`Anthropic${RLO}slliks`, 'a\u0000b', 'a\nb', `x${LRI}y`]) {
      expect(CatalogLabelSchema.safeParse(label).success).toBe(false);
    }
    expect(SharedCatalogManifestSchema.safeParse(manifest({ description: `a${RLO}b` })).success).toBe(false);
    expect(SharedCatalogManifestSchema.safeParse(manifest({ description: '' })).success).toBe(true);
  });

  it('refuses an unknown field anywhere', () => {
    expect(SharedCatalogItemSchema.safeParse({ ...skillItem(), extra: 1 }).success).toBe(false);
    expect(SharedCatalogItemSchema.safeParse(mcpItem({ ...COMMAND, clientSecret: 'x' })).success).toBe(false);
    expect(
      SharedCatalogItemSchema.safeParse(
        mcpItem({
          transport: 'url',
          url: 'https://x.example',
          auth: 'oauth',
          oauth: { clientId: 'a', clientSecret: '${secret:X}' },
        }),
      ).success,
    ).toBe(false);
  });
});

describe('skill bundle rules', () => {
  const refuses = (files: readonly { path: string; content: string }[]) =>
    expect(CatalogSkillSchema.safeParse({ files }).success).toBe(false);
  const md = { path: 'SKILL.md', content: '#' };

  it('needs SKILL.md at the root', () => refuses([{ path: 'README.md', content: '' }]));

  it('refuses a path that is not one plain relative path', () => {
    for (const path of [
      '/etc/passwd',
      '../x',
      'a/../b',
      './x',
      'a//b',
      'a/./b',
      'a/',
      '~/x',
      '$HOME/x',
      'a\\b',
      'a\u0000b',
    ]) {
      refuses([md, { path, content: '' }]);
    }
  });

  it('refuses the same file twice, spelled once or in two cases or normalisations', () => {
    refuses([md, md]);
    refuses([md, { path: 'skill.md', content: '' }]);
    refuses([md, { path: 'café.md', content: '' }, { path: 'café.md', content: '' }]);
  });

  it('refuses a path that is both a file and a folder', () => {
    refuses([md, { path: 'scripts', content: '' }, { path: 'scripts/run.sh', content: '' }]);
  });

  it('bounds each file, the whole skill, the count and the depth', () => {
    refuses([md, { path: 'big.txt', content: 'x'.repeat(CATALOG_SKILL_FILE_MAX_BYTES + 1) }]);
    // Bytes, not characters: 2 bytes per é.
    refuses([md, { path: 'wide.txt', content: 'é'.repeat(CATALOG_SKILL_FILE_MAX_BYTES / 2 + 1) }]);
    refuses([
      md,
      ...Array.from({ length: 9 }, (_, index) => ({
        path: `f${index}.txt`,
        content: 'x'.repeat(CATALOG_SKILL_FILE_MAX_BYTES),
      })),
    ]);
    refuses([md, ...Array.from({ length: 200 }, (_, index) => ({ path: `f${index}.txt`, content: '' }))]);
    refuses([md, { path: Array.from({ length: 17 }, () => 'd').join('/'), content: '' }]);
    expect(
      CatalogSkillSchema.safeParse({ files: [md, { path: 'scripts/split.sh', content: '#!/bin/sh' }] }).success,
    ).toBe(true);
  });
});

describe('MCP setup rules', () => {
  const refuses = (setup: unknown) => expect(CatalogMcpSetupSchema.safeParse(setup).success).toBe(false);

  it('lets a secret travel only as a whole environment value', () => {
    refuses({ ...COMMAND, env: { AUTH: 'Bearer ${secret:GITHUB_TOKEN}' } });
    refuses({ ...COMMAND, args: ['--token', '${secret:GITHUB_TOKEN}'] });
    refuses({ ...COMMAND, command: '${secret:X}' });
    refuses({ transport: 'url', url: 'https://x.example/${secret:X}' });
  });

  it('refuses any other substitution, which would expand the installer’s own environment', () => {
    refuses({ ...COMMAND, env: { TOKEN: '${GITHUB_TOKEN}' } });
    refuses({ ...COMMAND, env: { TOKEN: '${GITHUB_TOKEN:-x}' } });
    refuses({ ...COMMAND, args: ['${HOME}/.ssh/id_ed25519'] });
    refuses({ ...COMMAND, env: { TOKEN: '${secret:lower}' } });
  });

  it('refuses what looks like a raw key, by the MCP forms’ own rule', () => {
    refuses({ ...COMMAND, env: { GITHUB_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    refuses({ ...COMMAND, env: { API_KEY: 'abcdefghijklmnopqrstuvwxyz' } });
    refuses({ ...COMMAND, args: ['sk-live-abc'] });
  });

  it('refuses an address that is not plain http(s), or that carries a user name or password', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/plain,x',
      'ftp://x.example',
      'https://user:pw@x.example/',
      'https://u@x.example',
    ]) {
      refuses({ transport: 'url', url });
    }
    refuses({ transport: 'url', url: 'http://x.example', auth: 'oauth' });
    refuses({ transport: 'url', url: 'https://x.example', oauth: { clientId: 'a' } });
    expect(CatalogMcpSetupSchema.safeParse({ transport: 'url', url: 'https://x.example/a@b' }).success).toBe(true);
  });

  it('refuses args or env on a server reached at an address, and an address on a command', () => {
    refuses({ transport: 'url', url: 'https://x.example', args: [] });
    refuses({ ...COMMAND, url: 'https://x.example' });
  });

  it('lists the placeholders an installer must fill, once each', () => {
    const item = SharedCatalogItemSchema.parse(
      mcpItem({
        ...COMMAND,
        env: { B_TOKEN: '${secret:SHARED}', A_TOKEN: '${secret:SHARED}', C: '${secret:OTHER}', D: 'x' },
      }),
    );
    expect(catalogSecretPlaceholders(item)).toEqual(['SHARED', 'OTHER']);
    expect(catalogSecretPlaceholders(SharedCatalogItemSchema.parse(skillItem()))).toEqual([]);
  });
});

describe('manifest rules', () => {
  it('refuses an item listed twice, two items of one kind with one name, and a listed item also withdrawn', () => {
    const skill = entry(SKILL_ID, 'skill', 'pdf-tools', 2);
    expect(SharedCatalogManifestSchema.safeParse(manifest({ items: [skill, skill] })).success).toBe(false);
    expect(
      SharedCatalogManifestSchema.safeParse(manifest({ items: [skill, entry(MCP_ID, 'skill', 'pdf-tools', 1)] }))
        .success,
    ).toBe(false);
    expect(SharedCatalogManifestSchema.safeParse(manifest({ withdrawn: [{ itemId: SKILL_ID, at: AT }] })).success).toBe(
      false,
    );
    // One name may be both a skill and an MCP server: they land in different places.
    expect(
      SharedCatalogManifestSchema.safeParse(manifest({ items: [skill, entry(MCP_ID, 'mcp', 'pdf-tools', 1)] })).success,
    ).toBe(true);
  });

  it('refuses a revision below 1 and a malformed key or signature', () => {
    expect(SharedCatalogManifestSchema.safeParse(manifest({ revision: 0 })).success).toBe(false);
    const signed = { manifest: manifest(), spki: SPKI, sig: SIG };
    expect(catalog.SignedCatalogManifestSchema.safeParse({ ...signed, spki: 'A'.repeat(58) }).success).toBe(false);
    expect(catalog.SignedCatalogManifestSchema.safeParse({ ...signed, sig: `${'B'.repeat(85)}=` }).success).toBe(false);
  });
});

describe('catalog file', () => {
  it('refuses an item the manifest does not list, at another version, from another catalog, or carried twice', () => {
    const refuses = (items: readonly unknown[]) =>
      expect(SharedCatalogFileSchema.safeParse(file(items)).success).toBe(false);
    refuses([{ ...skillItem(), itemId: `itm_${'x'.repeat(22)}` }]);
    refuses([{ ...skillItem(), itemVersion: 1 }]);
    refuses([{ ...skillItem(), catalogId: `cat_${'d'.repeat(22)}` }]);
    refuses([{ ...skillItem(), publisher: `fy_daemon_${'Q'.repeat(43)}` }]);
    refuses([{ ...skillItem(), name: 'other' }]);
    refuses([skillItem(), skillItem()]);
    expect(SharedCatalogFileSchema.safeParse(file([])).success).toBe(true);
  });

  it('reads a file, and says in a sentence why it will not', () => {
    expect(readSharedCatalogFile(JSON.stringify(file([skillItem()]))).ok).toBe(true);
    const reasons = [
      '{',
      '{"format":"ferretry-clone"}',
      JSON.stringify(file([{ ...skillItem(), itemVersion: 1 }])),
    ].map(text => {
      const read = readSharedCatalogFile(text);
      return read.ok ? '' : read.reason;
    });
    expect(reasons[0]).toContain('not JSON');
    expect(reasons[1]).toBe('This is not a catalog file.');
    expect(reasons[2]).toContain('not the version the signed manifest lists');
  });

  it('refuses a file larger than its bound before parsing it', () => {
    const read = readSharedCatalogFile(' '.repeat(SHARED_CATALOG_FILE_MAX_BYTES + 1));
    expect(read.ok ? '' : read.reason).toContain('larger than 32 MiB');
  });
});

describe('the bytes a signature covers', () => {
  it('is the label, one zero byte and the 32-byte digest', () => {
    const digest = new Uint8Array(32).fill(7);
    const bytes = catalogManifestSignedBytes(digest);
    const label = new TextEncoder().encode(CATALOG_MANIFEST_SIGNATURE_LABEL);
    expect(bytes.length).toBe(label.length + 33);
    expect(Array.from(bytes.slice(0, label.length))).toEqual(Array.from(label));
    expect(bytes[label.length]).toBe(0);
    expect(Array.from(bytes.slice(label.length + 1))).toEqual(Array.from(digest));
  });

  it('spells a digest as sha256: and lower-case hex', () => {
    expect(catalogDigestOf(new Uint8Array(32).fill(0xab))).toBe(`sha256:${'ab'.repeat(32)}`);
  });
});

describe('no schema has a field for a secret value, a code or a private key', () => {
  /**
   * Every property name any catalog or install schema declares, at any depth — except a field that is a
   * closed enum (a warning's `code`), which can hold none of its own words.
   */
  const fieldNames = (schema: z.ZodType): readonly string[] => {
    const names: string[] = [];
    const closed = (property: unknown): boolean =>
      typeof property === 'object' && property !== null && ('enum' in property || 'const' in property);
    const stack: unknown[] = [z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' })];
    while (stack.length > 0) {
      const node = stack.pop();
      if (typeof node !== 'object' || node === null) continue;
      const record = node as Record<string, unknown>;
      if (typeof record.properties === 'object' && record.properties !== null)
        names.push(
          ...Object.entries(record.properties as Record<string, unknown>)
            .filter(([, property]) => !closed(property))
            .map(([key]) => key),
        );
      stack.push(...Object.values(record));
    }
    return names;
  };

  it('holds for every exported schema', () => {
    const schemas = [...Object.entries(catalog), ...Object.entries(review), ...Object.entries(install)].filter(
      ([name, value]) => name.endsWith('Schema') && value instanceof z.ZodType,
    );
    expect(schemas.length).toBeGreaterThan(20);
    // Names, placeholders and bindings of names to names are fine; a value, a code or a private key is not.
    const allowed = new Set(['secrets', 'secretBindings', 'spki', 'sig']);
    const forbidden = /secret|token|password|passwd|code|private|credential|value|seed|apikey/iu;
    const offenders = schemas.flatMap(([name, schema]) =>
      fieldNames(schema as z.ZodType)
        .filter(field => !allowed.has(field) && forbidden.test(field))
        .map(field => `${name}.${field}`),
    );
    expect(offenders).toEqual([]);
  });
});
