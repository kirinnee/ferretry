import { afterEach, beforeEach, expect, test } from 'bun:test';
import { LocalSkillInstallStateSchema } from '@ferretry/plugin-skills/contract';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  catalogsStep,
  V5_CATALOG_BLOBS,
  V5_CATALOG_INSTALLS,
  V5_CATALOG_LINK_KEYS,
  V5_CATALOG_LINKS,
  V5_CATALOG_MEMBER_PASSKEYS,
  V5_CATALOG_MEMBERS,
  V5_CATALOG_SHARES,
  V5_CATALOGS,
  V5_SKILL_INSTALLS,
} from '../../src/steps/catalogs.ts';
import { STEPS } from '../../src/steps/index.ts';
import { vaultStep } from '../../src/steps/secrets.ts';
import { AT, fixture } from './ferret-fixture.ts';

const REPO = resolve(import.meta.dir, '../../../..');

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

// ── FAKE ids, digests and keys only ───────────────────────────────────────────────────────────────────────────────

const id = (prefix: string, fill: string) => `${prefix}${fill.repeat(22)}`;
const CAT = id('cat_', 'C');
const ITEM = id('itm_', 'I');
const MEMBER = id('mbr_', 'M');
const MEMBER_B = id('mbr_', 'N');
const KEY = id('mk_', 'K');
const SHARE = id('shr_', 'S');
const LINK = id('lnk_', 'L');
const ONE_TIME = id('lnk_', 'O');
const INSTALL = id('cin_', 'A');
const LOCAL = id('lsi_', 'Q');
const DAEMON = `fy_daemon_${'D'.repeat(43)}`;
const LATER = '2026-11-02T00:00:00.000Z';
const RUNTIME_ID = '11111111-1111-4111-8111-111111111111';

/** A frozen version: its file is named by the SHA-256 of its exact bytes. */
const BLOB_TEXT = '{"fake":"frozen skill version","files":[]}\n';
const BLOB_HEX = new Bun.CryptoHasher('sha256').update(BLOB_TEXT).digest('hex');
const BOUND = `sha256:${'b'.repeat(64)}`;

const catalogs = (schemaVersion = 3) => ({
  schemaVersion,
  defaultCatalogId: CAT,
  items: [
    {
      itemId: ITEM,
      kind: 'skill',
      name: 'fake-skill',
      harness: 'claude',
      ownSummary: false,
      createdAt: AT,
      current: 1,
      versions: [
        {
          version: 1,
          publishedAt: AT,
          summary: 'A fake skill',
          source: { kind: 'skill', path: '/fake/skills/fake-skill' },
          contentDigest: `sha256:${BLOB_HEX}`,
          size: BLOB_TEXT.length,
          fileCount: 1,
          bindings: { [CAT]: { digest: BOUND, size: 120 } },
        },
      ],
    },
  ],
  catalogs: [
    {
      id: CAT,
      name: 'Fake catalog',
      description: '',
      publisherName: 'Fake machine',
      visibility: 'members',
      revision: 4,
      issuedAt: AT,
      createdAt: AT,
      entries: [{ itemId: ITEM, addedAt: AT }],
    },
  ],
});

const link = (linkId: string, extra: Record<string, unknown>) => ({
  linkId,
  itemId: ITEM,
  name: 'fake-skill',
  itemKind: 'skill',
  version: 1,
  state: 'live',
  createdAt: AT,
  opens: 2,
  publisher: DAEMON,
  storeOrigin: 'https://links.example.com',
  emitsStoreOrigin: false,
  sequence: 1,
  issuedAt: AT,
  notAfter: LATER,
  servedSince: AT,
  ...extra,
});
const links = {
  schemaVersion: 1,
  links: [
    link(LINK, { kind: 'public', bundleId: 'B'.repeat(22), keyRef: LINK }),
    link(ONE_TIME, { kind: 'one-time', bundleId: 'C'.repeat(22), expiresAt: LATER }),
  ],
};

const members = (labels: readonly string[] = ['Fake Friend']) => ({
  schemaVersion: 1,
  members: labels.map((label, index) => ({
    memberId: index === 0 ? MEMBER : MEMBER_B,
    label,
    catalogIds: [CAT],
    createdAt: AT,
    keys:
      index === 0
        ? [
            {
              keyId: KEY,
              memberKey: 'FAKE-MEMBER-PUBLIC-KEY',
              boxKey: 'FAKE-BOX-PUBLIC-KEY',
              clientName: 'Fake browser',
              joinedAt: AT,
              passkeyCount: 1,
            },
          ]
        : [],
  })),
});
const shares = {
  schemaVersion: 1,
  shares: [
    {
      shareId: SHARE,
      codeSha256: 'c'.repeat(64),
      memberId: MEMBER,
      memberLabel: 'Fake Friend',
      memberKind: 'new',
      catalogIds: [CAT],
      createdAt: AT,
      expiresAt: LATER,
      uses: 'single',
      used: 1,
      state: 'used',
      usedBy: [{ clientName: 'Fake browser', keyId: KEY, at: AT }],
      successes: [1],
    },
  ],
};
const memberPasskeys = {
  schemaVersion: 1,
  passkeys: [
    {
      credentialId: 'FAKE-CREDENTIAL',
      deviceId: KEY,
      algorithm: -7,
      publicKeySpki: 'FAKE-SPKI',
      signCount: 3,
      origin: 'https://app.example.com',
      createdAt: AT,
    },
  ],
};
const provenance = {
  publisher: DAEMON,
  publisherName: 'Fake machine',
  catalogId: CAT,
  catalogName: 'Fake catalog',
  itemId: ITEM,
  kind: 'skill',
  name: 'fake-skill',
  version: 1,
  digest: BOUND,
};
const catalogInstalls = {
  schemaVersion: 1,
  installs: [
    {
      installId: INSTALL,
      installedAt: AT,
      provenance,
      target: { scope: 'runtime', runtime: 'old-name', profile: 'default' },
      destination: 'the skill fake-skill in profile default',
      key: 'fleet:skills/fake-skill',
      files: [{ path: 'fake-skill/SKILL.md', sha256: 'd'.repeat(64) }],
      secretBindings: { FAKE_PLACEHOLDER: 'FAKE_SECRET_NAME' },
      componentSha256: 'e'.repeat(64),
    },
  ],
  publishers: { [DAEMON]: AT },
  pins: { [CAT]: DAEMON },
  revisions: { [CAT]: 4 },
};
const localInstalls = {
  schemaVersion: 1,
  installs: [
    {
      installId: LOCAL,
      installedAt: AT,
      name: 'fake-skill',
      origin: { kind: 'account', owner: 'old-name', harness: 'claude', path: '/fake/home/.claude/skills/x/SKILL.md' },
      provenance,
      target: { scope: 'project', projectRoot: '/work/project', harness: 'claude' },
      destination: '/work/project/.claude/skills/fake-skill/',
      key: 'project:/work/project/.claude/skills/fake-skill',
      files: [{ path: 'SKILL.md', sha256: 'f'.repeat(64) }],
      root: '/work/project',
      folder: '.claude/skills/fake-skill',
    },
  ],
};

/** v4's link-key sealing (`FileLinkKeyVault.put`): AES-256-GCM, a 96-bit IV, AAD `catalog-link:<linkId>`, no instants. */
async function sealLinkKey(key: CryptoKey, linkId: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`catalog-link:${linkId}`) },
    key,
    new TextEncoder().encode(value),
  );
  return { iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(new Uint8Array(sealed)).toString('base64') };
}

const FAKE_LINK_KEY = 'FAKE-LINK-KEY-NOT-REAL';

async function sealedHome(): Promise<void> {
  const keyText = `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}\n`;
  const key = await crypto.subtle.importKey('raw', Buffer.from(keyText.trim(), 'base64'), 'AES-GCM', false, [
    'encrypt',
  ]);
  await mkdir(join(f.from, 'state/catalogs'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, 'state/secrets.key'), keyText, { mode: 0o600 });
  // Written exactly as v4's `#write` does: pretty JSON and a newline.
  await writeFile(
    join(f.from, 'state/catalogs/link-keys.json'),
    `${JSON.stringify({ v: 1, cipher: 'AES-256-GCM', entries: { [LINK]: await sealLinkKey(key, LINK, FAKE_LINK_KEY) } }, undefined, 2)}\n`,
    { mode: 0o600 },
  );
}

async function fullHome(): Promise<void> {
  await sealedHome();
  await f.put('state/catalogs/catalogs.json', catalogs());
  await mkdir(join(f.from, 'state/catalogs/blobs'), { mode: 0o700 });
  await writeFile(join(f.from, `state/catalogs/blobs/${BLOB_HEX}.json`), BLOB_TEXT, { mode: 0o600 });
  await f.put('state/catalogs/links.json', links);
  await f.put('state/catalogs/members.json', members());
  await f.put('state/catalogs/shares.json', shares);
  await f.put('state/catalogs/member-passkeys.json', memberPasskeys);
  await f.put('state/catalogs/member-unlocks.json', { schemaVersion: 1, daemonId: DAEMON, unlocks: [] });
  await f.put('state/catalogs/catalogs.v2.json', { FAKE: 'backup' });
  await f.put('state/catalog-installs.json', catalogInstalls);
  await f.put('state/catalog-install-prefs.json', { schemaVersion: 1, installs: { [INSTALL]: { hold: true } } });
  await f.put('state/local-skill-installs.json', localInstalls);
  await f.put('fleet/ids.json', {
    version: 1,
    runtimes: { 'new-name': { id: RUNTIME_ID, formerNames: ['old-name'] } },
  });
}

const written = async (path: string) => {
  const text = await readFile(join(f.to, path), 'utf8');
  const value = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(value)[0]).toBe('format');
  expect((await stat(join(f.to, path))).mode & 0o777).toBe(0o600);
  return value;
};
const exists = async (path: string) => (await stat(join(f.to, path)).catch(() => undefined)) !== undefined;
const without = <T extends { schemaVersion: number }>(v4: T) => {
  const { schemaVersion: _v, ...body } = v4;
  return { format: 1, ...body };
};

test('the step takes the catalogs slot, between Warden and Settings', () => {
  const ids = STEPS.map(step => step.id);
  expect(ids.indexOf('catalogs')).toBe(ids.indexOf('warden') + 1);
  expect(ids.indexOf('catalogs')).toBe(ids.indexOf('settings') - 1);
  expect(STEPS.find(step => step.id === 'catalogs')).toBe(catalogsStep);
});

test('every catalog file keeps every value; only the envelope changes and the blobs are the same bytes', async () => {
  await fullHome();
  const report = await catalogsStep.run(f.ctx());
  expect(report.status).toBe('converted');

  expect(await written(V5_CATALOGS)).toEqual(without(catalogs()));
  expect(await written(V5_CATALOG_LINKS)).toEqual(without(links));
  expect(await written(V5_CATALOG_MEMBERS)).toEqual(without(members()));
  expect(await written(V5_CATALOG_SHARES)).toEqual(without(shares));
  expect(await written(V5_CATALOG_MEMBER_PASSKEYS)).toEqual(without(memberPasskeys));
  expect(await readFile(join(f.to, V5_CATALOG_BLOBS, `${BLOB_HEX}.json`), 'utf8')).toBe(BLOB_TEXT);
  // The pins, publishers and revisions are kept: nothing auto-updates; a former runtime name is the current one.
  expect(await written(V5_CATALOG_INSTALLS)).toEqual({
    ...without(catalogInstalls),
    installs: [
      { ...catalogInstalls.installs[0], target: { scope: 'runtime', runtime: 'new-name', profile: 'default' } },
    ],
  });

  // Not carried: live member unlocks, the hold/skip choices and the backups.
  for (const name of ['member-unlocks.json', 'catalogs.v2.json', 'catalog-install-prefs.json'])
    expect(await exists(join('state/catalogs', name))).toBe(false);
  expect(report.notCarried.map(item => item.what).join('\n')).toContain('member-unlocks.json');
  expect(report.note).toContain('1 install hold/skip choice(s) not carried');

  expect(report.kept).toEqual([
    { what: 'catalogs', count: 1 },
    { what: 'catalog items', count: 1 },
    { what: 'item versions', count: 1 },
    { what: 'frozen item versions (byte for byte)', count: 1 },
    { what: 'link keys (sealed, moved unopened)', count: 1 },
    { what: 'links', count: 2 },
    { what: 'members', count: 1 },
    { what: 'member browsers', count: 1 },
    { what: 'shares (code hashes only)', count: 1 },
    { what: 'member passkeys', count: 1 },
    { what: 'catalog installs (each at its pinned version)', count: 1 },
    { what: 'catalog publisher pins', count: 1 },
    { what: 'local skill copies', count: 1 },
  ]);
  expect(report.sealed).toEqual([
    { file: V5_CATALOG_LINK_KEYS, bytes: (await stat(join(f.to, V5_CATALOG_LINK_KEYS))).size },
  ]);
  expect(JSON.stringify(report)).not.toContain('FAKE-');
});

test('local skill copies land in Skills with v5 harness names and current runtime names', async () => {
  await fullHome();
  expect((await catalogsStep.run(f.ctx())).status).toBe('converted');
  const value = LocalSkillInstallStateSchema.parse(await written(V5_SKILL_INSTALLS));
  const [install] = localInstalls.installs;
  expect(value).toEqual({
    format: 1,
    installs: [
      {
        ...install!,
        origin: { ...install!.origin, owner: 'new-name', harness: 'claude-code' },
        target: { scope: 'project', projectRoot: '/work/project', harness: 'claude-code' },
      } as never,
    ],
  });
});

test('the link keys move unopened and v5’s own sealed-document reader opens them with the moved vault key', async () => {
  await fullHome();
  const before = await readFile(join(f.from, 'state/catalogs/link-keys.json'), 'utf8');
  expect((await vaultStep.run(f.ctx())).status).toBe('converted');
  expect((await catalogsStep.run(f.ctx())).status).toBe('converted');
  // The v4 file is untouched; the moved one has the same entry strings under `format: 1`.
  expect(await readFile(join(f.from, 'state/catalogs/link-keys.json'), 'utf8')).toBe(before);
  const moved = JSON.parse(await readFile(join(f.to, V5_CATALOG_LINK_KEYS), 'utf8'));
  const v4 = JSON.parse(before);
  expect(moved).toEqual({ format: 1, cipher: 'AES-256-GCM', entries: v4.entries });

  // v5's REAL reader, in a subprocess that imports nothing from this tool: the kernel state port over the disk, the
  // Vault's FileSecretKey over state/vault/vault.key, and KernelSealedDocuments with the link keys' declaration.
  const script = join(f.root, 'open-link-keys.ts');
  await writeFile(
    script,
    `
const [repo, home, linkId] = process.argv.slice(2);
const { state } = await import(repo + '/packages/core/kernel/host/index.ts');
const vault = await import(repo + '/packages/core/vault/contract/index.ts');
const { kernelSealedFiles } = await import(repo + '/packages/core/vault/daemon/adapters/secrets/kernel-sealed-files.ts');
const { FileSecretKey } = await import(repo + '/packages/core/vault/daemon/adapters/secrets/webcrypto-secret-cipher.ts');
const { KernelSealedDocuments } = await import(repo + '/packages/core/vault/daemon/adapters/secrets/kernel-sealed-documents.ts');
const manifest = (await import(repo + '/packages/plugins/catalogs/manifest.ts')).default;
const declared = manifest.data.state.find(def => def.name === 'link-keys');
const def = vault.defineSealedDocument({ name: 'link-keys', path: 'link-keys.json', additionalData: 'catalog-link:', stamped: false });
const same = ['store', 'path', 'format', 'mode'].every(key => declared[key] === def.state[key]);
const fs = state.createNodeHostFs();
const vaultPort = state.createStatePort({ home, pluginId: 'vault', fs, files: [vault.VaultFile, vault.VaultKeyFile] });
const catalogsPort = state.createStatePort({ home, pluginId: 'catalogs', fs, files: [declared] });
const port = new KernelSealedDocuments(new FileSecretKey(kernelSealedFiles(vaultPort)), { now: () => '${AT}' });
const handle = port.open(catalogsPort, def);
console.log(JSON.stringify({ same, names: await handle.names(), opened: await handle.get(linkId) }));
`,
  );
  const child = Bun.spawn(['bun', script, REPO, f.to, LINK], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  const [text, error] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' });
  expect(JSON.parse(text)).toEqual({ same: true, names: [LINK], opened: FAKE_LINK_KEY });
});

test('a sealed link-key document with no vault key fails by file name and writes nothing', async () => {
  await fullHome();
  await Bun.file(join(f.from, 'state/secrets.key')).delete();
  const report = await catalogsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe(
    'state/catalogs/link-keys.json exists but the vault key state/secrets.key that seals it does not',
  );
  expect(await exists('state/catalogs')).toBe(false);
  expect(JSON.stringify(report)).not.toContain('FAKE-');
});

test('a link-key document that is not v4’s envelope fails naming the file, never its content', async () => {
  await sealedHome();
  await writeFile(
    join(f.from, 'state/catalogs/link-keys.json'),
    JSON.stringify({ v: 2, cipher: 'AES-256-GCM', entries: { [LINK]: { iv: 'FAKE-IV', ciphertext: 'FAKE-CT' } } }),
  );
  const report = await catalogsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('state/catalogs/link-keys.json is not a version-1 sealed document');
  expect(JSON.stringify(report)).not.toContain('FAKE-');
});

test('two members with one name (a file v4 had not upgraded yet) fail naming the members; nothing is written', async () => {
  await fullHome();
  await f.put('state/catalogs/members.json', members(['Fake Friend', '  fake   FRIEND ']));
  const report = await catalogsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe(
    `state/catalogs/members.json: members ${MEMBER} and ${MEMBER_B} share one name; start v4.291.5 once so it renames them, then convert again`,
  );
  expect(await exists('state/catalogs')).toBe(false);
});

test('catalogs.json version 2 is upgraded as v4 does; version 1 is refused with the remedy', async () => {
  await f.put('state/catalogs/catalogs.json', catalogs(2));
  const report = await catalogsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await written(V5_CATALOGS)).toEqual(without(catalogs(2)));
  expect(report.note).toContain('schema version 2');

  await f.clean();
  f = await fixture();
  await f.put('state/catalogs/catalogs.json', { schemaVersion: 1, catalogs: [] });
  const refused = await catalogsStep.run(f.ctx());
  expect(refused.status).toBe('failed');
  expect(refused.note).toContain('start v4.291.5 once so it upgrades the file');
});

test('an id that v5 Catalogs would refuse fails naming the file and the field, never the value', async () => {
  const broken = catalogs();
  broken.catalogs[0]!.id = 'cat_FAKE-TOO-SHORT';
  await f.put('state/catalogs/catalogs.json', broken);
  const report = await catalogsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('state/catalogs/catalogs.json: does not fit v5 Catalogs at: ');
  expect(report.note).not.toContain('FAKE');
});

test('an install whose pin is not a digest fails naming the install', async () => {
  await f.put('state/catalog-installs.json', {
    ...catalogInstalls,
    installs: [{ ...catalogInstalls.installs[0], provenance: { ...provenance, digest: 'FAKE-NOT-A-DIGEST' } }],
  });
  const report = await catalogsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain(`install ${INSTALL} does not fit v5's install summary at: digest`);
  expect(report.note).not.toContain('FAKE');
});

test('a blob that does not hash to its name is copied and said; a stray file is named, never read', async () => {
  await f.put('state/catalogs/catalogs.json', catalogs());
  await mkdir(join(f.from, 'state/catalogs/blobs'), { mode: 0o700 });
  const wrong = 'a'.repeat(64);
  await writeFile(join(f.from, `state/catalogs/blobs/${wrong}.json`), BLOB_TEXT, { mode: 0o600 });
  await writeFile(join(f.from, 'state/catalogs/blobs/notes.txt'), 'FAKE', { mode: 0o600 });
  await writeFile(join(f.from, 'state/catalogs/stray.json'), '{}', { mode: 0o600 });
  const report = await catalogsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await readFile(join(f.to, V5_CATALOG_BLOBS, `${wrong}.json`), 'utf8')).toBe(BLOB_TEXT);
  expect(await exists(join(V5_CATALOG_BLOBS, 'notes.txt'))).toBe(false);
  expect(report.note).toContain('1 frozen version(s) do not hash to their name');
  expect(report.note).toContain('1 item version(s) have no frozen file in v4 either');
  const named = report.notCarried.map(item => item.what);
  expect(named).toContain('state/catalogs/blobs/notes.txt');
  expect(named).toContain('state/catalogs/stray.json');
});

test('a public link with no stored key and a key with no link are said, by count', async () => {
  await sealedHome();
  await f.put('state/catalogs/links.json', {
    schemaVersion: 1,
    links: [link(id('lnk_', 'P'), { kind: 'public', bundleId: 'D'.repeat(22), keyRef: id('lnk_', 'P') })],
  });
  const report = await catalogsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toContain('1 public link(s) have no stored key in v4 either');
  expect(report.note).toContain('1 link key(s) belong to no link');
});

test('a dry run checks everything and writes nothing; the sealed file is reported by size', async () => {
  await fullHome();
  const report = await catalogsStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.note).toContain('dry run: nothing written');
  expect(await exists('state')).toBe(false);
  expect(report.sealed).toEqual([
    { file: V5_CATALOG_LINK_KEYS, bytes: (await stat(join(f.from, 'state/catalogs/link-keys.json'))).size },
  ]);
});

test('a home with no catalogs converts with nothing to keep', async () => {
  const report = await catalogsStep.run(f.ctx());
  expect(report).toMatchObject({
    status: 'converted',
    kept: [],
    note: 'this home has no catalogs, shares or installs',
  });
  expect(await exists('state')).toBe(false);
});
