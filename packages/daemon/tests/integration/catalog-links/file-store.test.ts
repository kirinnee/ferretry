import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileLinkKeyVault } from '../../../src/adapters/catalog-links/file-link-key-vault.ts';
import { FileLinkDocumentStore } from '../../../src/adapters/catalog-links/file-store.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileSecretKey } from '../../../src/adapters/secrets/webcrypto-secret-cipher.ts';
import { CatalogLinkRefusal } from '../../../src/lib/catalog-links/refusal.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { storedLink } from '../../unit/catalog-links/support.ts';

/**
 * Links under a real state home: the two files' modes, a restart that finds the same links and the same sealed key,
 * a damaged file that is refused rather than emptied, and a key that is never on disk in the clear.
 */

const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

const SECRET = 'k'.repeat(43);
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-links-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  /** A fresh adapter pair over the same disk: what a daemon restart builds. */
  const boot = () => ({
    documents: new FileLinkDocumentStore(paths, files),
    vault: new FileLinkKeyVault(paths, files, new FileSecretKey(join(home, 'vault.key'), files)),
  });
  return { home, paths, boot };
}

const refusal = async (work: () => Promise<unknown>): Promise<CatalogLinkRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogLinkRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('links.json under a real state home', () => {
  it('should read as no links before anything is written', async () => {
    const { boot } = await fixture();
    should((await boot().documents.read()).links).deepEqual([]);
  });

  it('should write privately, leave no temporary file behind, and survive a restart', async () => {
    const { paths, boot } = await fixture();
    const document = { schemaVersion: 1 as const, links: [storedLink({ state: 'live' })] };
    await boot().documents.write(document);
    should(await mode(paths.catalogLinks)).equal(0o600);
    should(await mode(paths.catalogs)).equal(0o700);
    should((await readdir(paths.catalogs)).filter(name => name.includes('tmp'))).deepEqual([]);
    should(await boot().documents.read()).deepEqual(document);
  });

  it('should keep a moved, revived, pending and identity-ended link across a restart', async () => {
    const { boot } = await fixture();
    const at = new Date(Date.UTC(2026, 0, 3)).toISOString();
    const later = new Date(Date.UTC(2026, 0, 9)).toISOString();
    const document = {
      schemaVersion: 1 as const,
      links: [
        storedLink({
          state: 'live',
          version: 2,
          movedFrom: 1,
          revivedAt: at,
          pendingUpload: { sequence: 3, version: 2, notAfter: later, issuedAt: at, revived: true },
        }),
        storedLink({ state: 'ended', endedAt: at, endReason: 'identity-changed' }),
      ],
    };
    await boot().documents.write(document);
    should(await boot().documents.read()).deepEqual(document);
  });

  it('should refuse a damaged file, and leave it on disk untouched', async () => {
    const { paths, boot } = await fixture();
    await boot().documents.write({ schemaVersion: 1, links: [] });
    await writeFile(paths.catalogLinks, '{ not json');
    should((await refusal(() => boot().documents.read())).refusal).equal('links_store_damaged');
    should(await readFile(paths.catalogLinks, 'utf8')).equal('{ not json');
  });
});

describe('link-keys.json under a real state home', () => {
  it('should seal a key privately, never in the clear, and open it after a restart', async () => {
    const { paths, boot } = await fixture();
    await boot().vault.put('lnk_one', SECRET);
    should(await mode(paths.catalogLinkKeys)).equal(0o600);
    should(await readFile(paths.catalogLinkKeys, 'utf8')).not.containEql(SECRET);
    should(await boot().vault.open('lnk_one')).equal(SECRET);
  });

  it('should forget a key for good', async () => {
    const { paths, boot } = await fixture();
    await boot().vault.put('lnk_one', SECRET);
    await boot().vault.forget('lnk_one');
    should(await boot().vault.open('lnk_one')).equal(undefined);
    should(await readFile(paths.catalogLinkKeys, 'utf8')).not.containEql('lnk_one');
  });

  it('should fail to open once the vault key is lost, and say so without the key', async () => {
    const { home, boot } = await fixture();
    await boot().vault.put('lnk_one', SECRET);
    await rm(join(home, 'vault.key'));
    const out = await refusal(() => boot().vault.open('lnk_one'));
    should(out.refusal).equal('links_store_damaged');
    should(out.message).not.containEql(SECRET);
  });

  it('should refuse a damaged file instead of treating it as no keys', async () => {
    const { paths, boot } = await fixture();
    await boot().vault.put('lnk_one', SECRET);
    await writeFile(paths.catalogLinkKeys, 'nope');
    should((await refusal(() => boot().vault.open('lnk_one'))).refusal).equal('links_store_damaged');
    should(await readFile(paths.catalogLinkKeys, 'utf8')).equal('nope');
  });
});

describe('what the two files refuse to hold', () => {
  it('should refuse to write a document that breaks a rule of the file, and write nothing', async () => {
    const { paths, boot } = await fixture();
    await boot().documents.write({ schemaVersion: 1, links: [] });
    const same = storedLink({ state: 'live' });
    const out = await refusal(() => boot().documents.write({ schemaVersion: 1, links: [same, same] }));
    should(out.refusal).equal('links_store_damaged');
    should((await boot().documents.read()).links).deepEqual([]);
    should(await readFile(paths.catalogLinks, 'utf8')).not.containEql(same.linkId);
  });

  it('should refuse a sealed key that does not authenticate, and say nothing of the key', async () => {
    const { paths, boot } = await fixture();
    await boot().vault.put('lnk_one', SECRET);
    const sealed = JSON.parse(await readFile(paths.catalogLinkKeys, 'utf8')) as {
      entries: Record<string, { iv: string; ciphertext: string }>;
    };
    const entry = sealed.entries.lnk_one;
    if (entry === undefined) throw new Error('expected a sealed entry');
    entry.ciphertext = `${entry.ciphertext.startsWith('A') ? 'B' : 'A'}${entry.ciphertext.slice(1)}`;
    await writeFile(paths.catalogLinkKeys, JSON.stringify(sealed));
    const out = await refusal(() => boot().vault.open('lnk_one'));
    should(out.refusal).equal('links_store_damaged');
    should(out.message).not.containEql(SECRET);
  });
});
