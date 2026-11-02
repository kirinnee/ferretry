import { describe, it } from 'bun:test';
import should from 'should';
import { FileLinkKeyVault } from '../../../src/adapters/catalog-links/file-link-key-vault.ts';
import { FileLinkDocumentStore } from '../../../src/adapters/catalog-links/file-store.ts';
import {
  ConfiguredLinkStoreLocator,
  type LinkStoreSetting,
} from '../../../src/adapters/catalog-links/link-store-locator.ts';
import { FileSecretKey } from '../../../src/adapters/secrets/webcrypto-secret-cipher.ts';
import { EMPTY_LINKS_DOCUMENT } from '../../../src/lib/catalog-links/document.ts';
import { CatalogLinkRefusal } from '../../../src/lib/catalog-links/refusal.ts';
import type { FileSystemPort, FoundationPaths } from '../../../src/lib/index.ts';
import { storedLink } from './support.ts';

class FakeFiles {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async ensureDirectory(path: string, mode: number): Promise<void> {
    this.calls.push(`ensureDirectory ${path} ${mode.toString(8)}`);
  }
  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.calls.push(`writeTextAtomic ${path}`);
    this.files.set(path, text);
  }
  async setMode(path: string, mode: number): Promise<void> {
    this.calls.push(`setMode ${path} ${mode.toString(8)}`);
  }
}

const PATHS = {
  catalogs: '/state/catalogs',
  catalogLinks: '/state/catalogs/links.json',
  catalogLinkKeys: '/state/catalogs/link-keys.json',
} as unknown as FoundationPaths;

const refusalOf = async (work: () => Promise<unknown>): Promise<CatalogLinkRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogLinkRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('FileLinkDocumentStore', () => {
  it('should read an absent file as no links', async () => {
    const files = new FakeFiles();
    should(await new FileLinkDocumentStore(PATHS, files as unknown as FileSystemPort).read()).deepEqual(
      EMPTY_LINKS_DOCUMENT,
    );
  });

  it('should write the whole document through a temporary file, private, and read it back', async () => {
    const files = new FakeFiles();
    const store = new FileLinkDocumentStore(PATHS, files as unknown as FileSystemPort);
    const document = { schemaVersion: 1 as const, links: [storedLink({ state: 'live' })] };
    await store.write(document);
    should(files.calls).deepEqual([
      'ensureDirectory /state/catalogs 700',
      'writeTextAtomic /state/catalogs/links.json',
      'setMode /state/catalogs/links.json 600',
    ]);
    should(await store.read()).deepEqual(document);
  });

  it('should refuse a document that breaks a rule of the file, writing nothing', async () => {
    const files = new FakeFiles();
    const store = new FileLinkDocumentStore(PATHS, files as unknown as FileSystemPort);
    const link = storedLink({ state: 'live' });
    const out = await refusalOf(() => store.write({ schemaVersion: 1, links: [link, link] }));
    should(out.refusal).equal('links_store_damaged');
    should(files.calls).deepEqual([]);
  });

  it('should say a file that will not parse is damaged, and never read it as empty', async () => {
    const files = new FakeFiles();
    files.files.set(PATHS.catalogLinks, '{nope');
    const store = new FileLinkDocumentStore(PATHS, files as unknown as FileSystemPort);
    should((await refusalOf(() => store.read())).refusal).equal('links_store_damaged');
    files.files.set(PATHS.catalogLinks, JSON.stringify({ schemaVersion: 2, links: [] }));
    const out = await refusalOf(() => store.read());
    should(out.refusal).equal('links_store_damaged');
    should(out.message).containEql('Nothing was changed');
  });
});

describe('FileLinkKeyVault', () => {
  const rig = () => {
    const files = new FakeFiles();
    const keys = new FileSecretKey('/state/vault.key', files as unknown as FileSystemPort, () =>
      new Uint8Array(32).fill(9),
    );
    const vault = new FileLinkKeyVault(PATHS, files as unknown as FileSystemPort, keys, () =>
      new Uint8Array(12).fill(3),
    );
    return { files, keys, vault };
  };
  const SECRET = 'k'.repeat(43);

  it('should seal a key, open it again, and write only ciphertext', async () => {
    const { files, vault } = rig();
    await vault.put('lnk_one', SECRET);
    should(await vault.open('lnk_one')).equal(SECRET);
    should(files.files.get(PATHS.catalogLinkKeys)).not.containEql(SECRET);
    should(files.calls).containEql('setMode /state/catalogs/link-keys.json 600');
    should(await vault.open('lnk_other')).equal(undefined);
  });

  it('should forget one entry and ignore one it does not hold', async () => {
    const { files, vault } = rig();
    await vault.forget('lnk_none');
    should(files.files.has(PATHS.catalogLinkKeys)).equal(false);
    await vault.put('lnk_one', SECRET);
    await vault.put('lnk_two', 'z'.repeat(43));
    await vault.forget('lnk_one');
    should(await vault.open('lnk_one')).equal(undefined);
    should(await vault.open('lnk_two')).equal('z'.repeat(43));
  });

  it('should refuse a sealed key moved under another link id, without naming the key', async () => {
    const { files, vault } = rig();
    await vault.put('lnk_one', SECRET);
    const document = JSON.parse(files.files.get(PATHS.catalogLinkKeys) ?? '') as { entries: Record<string, unknown> };
    document.entries.lnk_two = document.entries.lnk_one;
    files.files.set(PATHS.catalogLinkKeys, JSON.stringify(document));
    const out = await refusalOf(() => vault.open('lnk_two'));
    should(out.refusal).equal('links_store_damaged');
    should(out.message).containEql('lnk_two');
    should(out.message).not.containEql(SECRET);
  });

  it('should refuse to open when the vault key is gone', async () => {
    const { files, vault } = rig();
    await vault.put('lnk_one', SECRET);
    files.files.delete('/state/vault.key');
    should((await refusalOf(() => vault.open('lnk_one'))).message).containEql('vault key is gone');
  });

  it('should say a damaged file is damaged', async () => {
    const { files, vault } = rig();
    files.files.set(PATHS.catalogLinkKeys, 'nope');
    should((await refusalOf(() => vault.open('lnk_one'))).message).containEql('not JSON');
    files.files.set(PATHS.catalogLinkKeys, JSON.stringify({ v: 2 }));
    should((await refusalOf(() => vault.put('lnk_one', SECRET))).refusal).equal('links_store_damaged');
  });

  it('should draw its own nonce when none is given', async () => {
    const files = new FakeFiles();
    const keys = new FileSecretKey('/state/vault.key', files as unknown as FileSystemPort);
    const vault = new FileLinkKeyVault(PATHS, files as unknown as FileSystemPort, keys);
    await vault.put('lnk_one', SECRET);
    await vault.put('lnk_two', SECRET);
    const entries = (
      JSON.parse(files.files.get(PATHS.catalogLinkKeys) ?? '') as { entries: Record<string, { iv: string }> }
    ).entries;
    should(entries.lnk_one?.iv).not.equal(entries.lnk_two?.iv);
    should(await vault.open('lnk_two')).equal(SECRET);
  });
});

describe('ConfiguredLinkStoreLocator', () => {
  const locate = async (setting: LinkStoreSetting, directory: string | undefined, taking = true) => {
    const asked: string[] = [];
    const locator = new ConfiguredLinkStoreLocator(
      () => setting,
      () => directory,
      {
        available: async origin => {
          asked.push(origin);
          return taking;
        },
      },
    );
    return { site: await locator.locate(), asked };
  };

  it('should use the relay directory by default, and not carry its address', async () => {
    const { site, asked } = await locate({ source: 'discovery' }, 'https://dir.example.test/');
    should(site).deepEqual({ kind: 'ready', origin: 'https://dir.example.test', selfHosted: false });
    should(asked).deepEqual(['https://dir.example.test/']);
  });

  it('should use a configured store and carry its address', async () => {
    const { site } = await locate({ url: 'https://mine.example.test' }, undefined);
    should(site).deepEqual({ kind: 'ready', origin: 'https://mine.example.test', selfHosted: true });
  });

  it('should say why there is none: turned off, no directory, or the store not taking links', async () => {
    const off = await locate({ enabled: false }, 'https://dir.example.test');
    should(off.site.kind).equal('unavailable');
    should(off.asked).deepEqual([]);
    const none = await locate({ source: 'discovery' }, undefined);
    should(none.site).deepEqual({
      kind: 'unavailable',
      reason:
        'This machine has no link store to ask: the relay directory is off. Set catalogs.linkStore.url to use your own.',
    });
    const down = await locate({ source: 'discovery' }, 'https://dir.example.test', false);
    should(down.site.kind).equal('unavailable');
  });
});
