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

  it('never repeats a file-supplied name in the sentence it refuses with', () => {
    const long = `${'a'.repeat(250)}${RLO}${'b'.repeat(250)}`;
    const read = readSharedCatalogFile(JSON.stringify(file([skillItem([{ path: `${long}/SKILL.md`, content: 'x' }])])));
    const reason = read.ok ? '' : read.reason;
    expect(reason).toContain('a name in this path uses a character other than A-Z, a-z, 0-9, ., _ and -');
    expect(reason).not.toContain(RLO);
    expect(reason).not.toContain(long);
    expect(reason.length).toBeLessThan(600);
  });

  it('writes a hidden character in the field path as its marker, and bounds the path', () => {
    const key = `bad${RLO}key`;
    const document = { ...file([skillItem()]), [key]: 1 };
    const read = readSharedCatalogFile(JSON.stringify(document));
    const reason = read.ok ? '' : read.reason;
    expect(reason).not.toContain(RLO);
    const long = readSharedCatalogFile(JSON.stringify({ ...file([skillItem()]), [`${'k'.repeat(300)}${RLO}`]: 1 }));
    const bounded = long.ok ? '' : long.reason;
    expect(bounded).not.toContain(RLO);
    expect(bounded.length).toBeLessThan(400);
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

describe('what the security review found (PR #1166)', () => {
  /** By code point, so this source holds no invisible character itself. */
  const at = (...points: number[]) => String.fromCodePoint(...points);

  it('refuses every invisible character in a label, not only the direction overrides', () => {
    for (const hidden of [
      0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x2028, 0x2029, 0xe0041, 0x3164, 0x115f, 0xfe0f, 0x034f,
    ]) {
      expect([hidden.toString(16), CatalogLabelSchema.safeParse(`An${at(hidden)}thropic`).success]).toEqual([
        hidden.toString(16),
        false,
      ]);
    }
    expect(CatalogLabelSchema.safeParse('a\nb').success).toBe(false);
    expect(CatalogLabelSchema.safeParse('Kirin’s skills · kirin-box').success).toBe(true);
  });

  it('allows only plain ASCII names in a skill, and refuses .git, Windows device names and a trailing dot', () => {
    const md = { path: 'SKILL.md', content: '#' };
    for (const path of [
      '.git/config',
      'sub/.GIT/hooks/pre-commit',
      `SKILL${at(0x200b)}.md`,
      'a b.md',
      'notes.',
      'CON',
      'con.txt',
      'lpt1/x',
      'SKILL.md::$DATA',
      'aσ.md',
      'x'.repeat(256),
    ]) {
      expect([path, CatalogSkillSchema.safeParse({ files: [md, { path, content: '' }] }).success]).toEqual([
        path,
        false,
      ]);
    }
    // Two names one case-insensitive file system treats as one.
    expect(
      CatalogSkillSchema.safeParse({ files: [md, { path: 'A.md', content: '' }, { path: 'a.md', content: '' }] })
        .success,
    ).toBe(false);
    for (const path of ['.gitignore', 'scripts/run.sh', 'a_b-c.d.md', 'console.md', 'x'.repeat(255)]) {
      expect([path, CatalogSkillSchema.safeParse({ files: [md, { path, content: '' }] }).success]).toEqual([
        path,
        true,
      ]);
    }
  });

  it('refuses hidden characters in a command, an argument, a value, an address and a client id', () => {
    const rlo = at(0x202e);
    for (const setup of [
      { ...COMMAND, command: `np${rlo}x` },
      { ...COMMAND, args: [`a${rlo}b`] },
      { ...COMMAND, env: { LOG_LEVEL: `in${at(0x200b)}fo` } },
      { transport: 'url', url: `https://evil.example/${rlo}google.com` },
      { transport: 'url', url: 'https://\u0000x' },
      { transport: 'url', url: 'https://x.example', auth: 'oauth', oauth: { clientId: `a${rlo}` } },
    ]) {
      expect(CatalogMcpSetupSchema.safeParse(setup).success).toBe(false);
    }
    // A line break in an argument is shown quoted by the review, so it may travel.
    expect(CatalogMcpSetupSchema.safeParse({ ...COMMAND, args: ['line one\nline two'] }).success).toBe(true);
  });

  it('refuses a key hidden inside a value, an argument or an address — a heuristic, said as one', () => {
    for (const setup of [
      { transport: 'url', url: 'https://x.example/?token=sk-abcdefghijklmnopqrstuvwxyz' },
      { transport: 'url', url: 'https://x.example/mcp?api_key=abcdef0123456789abcdef' },
      { ...COMMAND, args: ['--token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] },
      { ...COMMAND, args: ['--api-key', 'abcdef0123456789abcdef'] },
      { ...COMMAND, env: { API_KEY: 'Bearer sk-abcdefghijklmnopqrstuvwxyz' } },
      { ...COMMAND, env: { HEADERS: 'Authorization: Bearer abcdef0123456789abcdef' } },
    ]) {
      expect([JSON.stringify(setup), CatalogMcpSetupSchema.safeParse(setup).success]).toEqual([
        JSON.stringify(setup),
        false,
      ]);
    }
    // Ordinary flags and values pass: the heuristic needs a key-like prefix, or a long value after a secret-sounding word.
    for (const args of [
      ['--read-only', '--title', 'a long title for this server'],
      ['--token-file', '/run/token'],
    ]) {
      expect(CatalogMcpSetupSchema.safeParse({ ...COMMAND, args }).success).toBe(true);
    }
  });

  it('binds the harness an item says it is for to its manifest line', () => {
    const claude = { ...skillItem(), harness: 'claude' };
    expect(SharedCatalogFileSchema.safeParse(file([claude])).success).toBe(false);
    const listed = manifest({ items: [{ ...entry(SKILL_ID, 'skill', 'pdf-tools', 2), harness: 'claude' }] });
    expect(
      SharedCatalogFileSchema.safeParse({
        ...file([claude]),
        signedManifest: { manifest: listed, spki: SPKI, sig: SIG },
      }).success,
    ).toBe(true);
  });

  it('refuses a file larger than its bound by its length alone, before measuring its bytes', () => {
    const read = readSharedCatalogFile('x'.repeat(SHARED_CATALOG_FILE_MAX_BYTES + 1));
    expect(read.ok ? '' : read.reason).toContain('larger than 32 MiB');
  });
});

describe('a placeholder is a name, not a key', () => {
  it('accepts a long, secret-sounding placeholder name', () => {
    expect(
      CatalogMcpSetupSchema.safeParse({ ...COMMAND, env: { GITHUB_TOKEN: '${secret:GITHUB_TOKEN_READONLY_FOR_CI}' } })
        .success,
    ).toBe(true);
  });
});

describe('what the second security review found (PR #1166)', () => {
  const md = { path: 'SKILL.md', content: '#' };
  const carries = (paths: readonly string[]) =>
    CatalogSkillSchema.safeParse({ files: [md, ...paths.map(path => ({ path, content: 'x' }))] }).success;

  it('refuses a folder laid out as a bare git repository, at the root or below', () => {
    expect(carries(['r/HEAD', 'r/config', 'r/objects/info', 'r/refs/heads/main'])).toBe(false);
    expect(carries(['HEAD', 'objects/x', 'refs/y'])).toBe(false);
    expect(carries(['a/b/head', 'a/b/OBJECTS/x', 'a/b/refs/y'])).toBe(false);
    // Each part alone is an ordinary file name.
    expect(carries(['r/HEAD', 'r/objects/x'])).toBe(true);
    expect(carries(['docs/refs/list.md', 'docs/objects/a.md', 'HEAD'])).toBe(true);
  });

  it('refuses a name that starts with a dash, and the braille blank and Mongolian selectors in a label', () => {
    expect(carries(['-rf'])).toBe(false);
    expect(carries(['a/-n.md'])).toBe(false);
    for (const point of [0x2800, 0x180b, 0x180c, 0x180d, 0x180f]) {
      expect(CatalogLabelSchema.safeParse(`a${String.fromCodePoint(point)}b`).success).toBe(false);
    }
  });

  it('reads whole words, not substrings, for a name that announces a key', () => {
    for (const setup of [
      { transport: 'url', url: 'https://mcp.example.com/auth/callback-handler-v2' },
      { transport: 'url', url: 'https://example.com/oauth/authorize/mcp-server-endpoint' },
      { transport: 'url', url: 'https://api.example.com/v1/keys/list-all-the-things' },
      { transport: 'url', url: 'https://api.example.com/v1?author=someone-with-a-long-handle' },
      { ...COMMAND, args: ['--author', 'someone-with-a-long-handle'] },
      { ...COMMAND, args: ['--keyboard-layout', 'international-english'] },
    ]) {
      expect([JSON.stringify(setup), CatalogMcpSetupSchema.safeParse(setup).success]).toEqual([
        JSON.stringify(setup),
        true,
      ]);
    }
    for (const setup of [
      { transport: 'url', url: 'https://x.example/?access_token=abcdef0123456789abcdef' },
      { ...COMMAND, args: ['--access-token', 'abcdef0123456789abcdef'] },
    ]) {
      expect(CatalogMcpSetupSchema.safeParse(setup).success).toBe(false);
    }
  });
});

describe('the signed version list', () => {
  const offered = (version: number) => ({
    version,
    digest: DIGEST,
    size: 5,
    publishedAt: AT,
    summary: 'a summary',
  });
  const list = (over: Record<string, unknown> = {}) => ({
    format: 'ferretry-catalog-versions',
    version: 1,
    publisher: PUBLISHER,
    catalogId: CATALOG,
    itemId: SKILL_ID,
    revision: 3,
    issuedAt: AT,
    current: 3,
    offered: [offered(2), offered(3)],
    ...over,
  });
  const parses = (value: unknown) => catalog.SharedCatalogItemVersionsSchema.safeParse(value).success;

  it('should hold the versions oldest first, once each, with the current one among them', () => {
    expect(parses(list())).toBe(true);
    expect(parses(list({ offered: [offered(3), offered(2)] }))).toBe(false);
    expect(parses(list({ offered: [offered(2), offered(2), offered(3)] }))).toBe(false);
    expect(parses(list({ current: 4 }))).toBe(false);
    expect(parses(list({ offered: [] }))).toBe(false);
    expect(parses(list({ offered: [offered(0)], current: 0 }))).toBe(false);
  });

  it('should hold at most as many versions as one item keeps, and nothing it does not name', () => {
    const many = Array.from({ length: catalog.CATALOG_VERSIONS_MAX_OFFERED }, (_, index) => offered(index + 1));
    expect(parses(list({ offered: many, current: many.length }))).toBe(true);
    expect(parses(list({ offered: [...many, offered(many.length + 1)], current: many.length }))).toBe(false);
    expect(parses(list({ extra: 1 }))).toBe(false);
    expect(parses(list({ format: 'ferretry-catalog-manifest' }))).toBe(false);
  });

  it('should be signed by a key and a signature, nothing else', () => {
    const signed = { versions: list(), spki: SPKI, sig: SIG };
    expect(catalog.SignedCatalogItemVersionsSchema.safeParse(signed).success).toBe(true);
    expect(catalog.SignedCatalogItemVersionsSchema.safeParse({ ...signed, extra: 1 }).success).toBe(false);
  });

  it('should sign its own label, one zero byte and the 32-byte digest, a different label than a manifest’s', () => {
    const digest = new Uint8Array(32).fill(9);
    const bytes = catalog.catalogVersionsSignedBytes(digest);
    const label = new TextEncoder().encode(catalog.CATALOG_VERSIONS_SIGNATURE_LABEL);
    expect(catalog.CATALOG_VERSIONS_SIGNATURE_LABEL).toBe('ferretry-catalog-versions-v1');
    expect(Array.from(bytes.slice(0, label.length))).toEqual(Array.from(label));
    expect(bytes[label.length]).toBe(0);
    expect(Array.from(bytes.slice(label.length + 1))).toEqual(Array.from(digest));
    expect(Array.from(bytes)).not.toEqual(Array.from(catalogManifestSignedBytes(digest)));
  });
});
