/**
 * Accounts' stored documents over the kernel's REAL state port and a real temp folder: the account index, the standing
 * sign-in rules and the paste rules. A damaged file is an error, never an empty store.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import type { AccountIndexDocument } from '../../../contract/routes/index.ts';
import { FilePasteRuleStore } from '../../../daemon/adapters/secure-copy/file-paste-rules.ts';
import { FileSignInRuleStore } from '../../../daemon/adapters/sign-in-rules/file-sign-in-rules.ts';
import { StateAccountIndexStore } from '../../../daemon/adapters/state-account-index-store.ts';
import { kernelStateDocument } from '../../../daemon/adapters/state-document.ts';
import manifest from '../../../manifest.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const fileOf = (name: string) => {
  const found = manifest.data.state.find(candidate => candidate.name === name);
  if (found === undefined) throw new Error(`accounts declares no state file ${name}`);
  return found;
};

async function disk() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-accounts-state-'));
  homes.push(home);
  const port = state.createStatePort({
    home,
    pluginId: 'accounts',
    files: manifest.data.state,
    fs: state.createNodeHostFs(),
  });
  const damage = async (path: string, text = '{ not json') => {
    await writeFile(join(home, 'state', 'accounts', path), text);
  };
  return { home, port, damage };
}

const EMPTY_INDEX: AccountIndexDocument = { format: 1, accounts: {}, signIns: {} };

describe('the account index on disk', () => {
  it('should answer nothing for a home that never saved an account, and read back what it wrote', async () => {
    // Arrange
    const { port } = await disk();
    const store = new StateAccountIndexStore(port, fileOf('accounts'));

    // Act
    const before = await store.read();
    await store.write(EMPTY_INDEX);
    const after = await store.read();

    // Assert
    should(before).be.undefined();
    should(after).deepEqual(EMPTY_INDEX);
  });

  it('S68 should raise, naming no part of the file, for an index file that is not an account index', async () => {
    // Arrange
    const { port } = await disk();
    const file = fileOf('accounts');
    await port.write(file, { format: 1, accounts: 'nonsense', signIns: {} });

    // Act
    const actual = await new StateAccountIndexStore(port, file).read().catch((error: unknown) => error);

    // Assert
    should(actual).be.instanceOf(Error);
    should((actual as Error).message).not.containEql('nonsense');
  });

  it('should raise, never read as empty, for a damaged index file', async () => {
    // Arrange
    const { port, damage } = await disk();
    const file = fileOf('accounts');
    await port.write(file, { format: 1, accounts: {}, signIns: {} });
    await damage('accounts.json');

    // Act
    const actual = await new StateAccountIndexStore(port, file).read().catch((error: unknown) => error);

    // Assert
    should(actual).be.instanceOf(Error);
  });
});

describe('the standing sign-in rules on disk', () => {
  it('should read nothing before the first write, and the same document after it', async () => {
    // Arrange
    const { port } = await disk();
    const store = new FileSignInRuleStore(kernelStateDocument(port, fileOf('sign-in-rules')));

    // Act
    const before = await store.read();
    await store.write({ v: 1, rules: [] });
    const after = await store.read();

    // Assert
    should(before).be.undefined();
    should(after).deepEqual({ v: 1, rules: [] });
  });

  it('S128 should refuse a damaged rules file whole, and refuse to move it aside in this build', async () => {
    // Arrange
    const { port, damage } = await disk();
    const store = new FileSignInRuleStore(kernelStateDocument(port, fileOf('sign-in-rules')));
    await store.write({ v: 1, rules: [] });
    await damage('sign-in-rules.json');

    // Act
    const read = await store.read().catch((error: unknown) => error);
    const aside = await store.setAside('2026-11-09T10:00:00Z').catch((error: unknown) => error);

    // Assert
    should(read).be.instanceOf(Error);
    should(aside).be.instanceOf(Error);
    should((aside as Error).message).match(/cannot copy the damaged file aside/);
  });

  it('should refuse a document that parses as JSON but is not a rules document', async () => {
    // Arrange
    const { port } = await disk();
    const file = fileOf('sign-in-rules');
    await port.write(file, { v: 2, rules: [] });

    // Act
    const actual = await new FileSignInRuleStore(kernelStateDocument(port, file)).read().catch((e: unknown) => e);

    // Assert
    should(actual).be.instanceOf(Error);
  });
});

describe('the paste rules on disk', () => {
  it('should read nothing before the first write, and the same rules after it', async () => {
    // Arrange
    const { port } = await disk();
    const store = new FilePasteRuleStore(kernelStateDocument(port, fileOf('copy-rules')));
    const document = { rules: [], settings: { allowProfileTargets: true } };

    // Act
    const before = await store.read();
    await store.write(document);
    const after = await store.read();

    // Assert
    should(before).be.undefined();
    should(after).deepEqual(document);
  });

  it('should refuse a damaged or foreign rules file, so no approval is ever invented', async () => {
    // Arrange
    const { port, damage } = await disk();
    const file = fileOf('copy-rules');
    const store = new FilePasteRuleStore(kernelStateDocument(port, file));
    await store.write({ rules: [], settings: { allowProfileTargets: false } });
    await port.write(file, { v: 1, rules: [], settings: { allowProfileTargets: 'yes' } });
    const foreign = await store.read().catch((error: unknown) => error);
    await damage('copy-rules.json');

    // Act
    const broken = await store.read().catch((error: unknown) => error);

    // Assert
    should(foreign).be.instanceOf(Error);
    should(broken).be.instanceOf(Error);
  });
});
