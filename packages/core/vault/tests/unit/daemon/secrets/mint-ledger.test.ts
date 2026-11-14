import { describe, expect, test } from 'bun:test';
import type { MintsDocument, SecretName } from '../../../../contract/index.ts';
import { MintLedger, type MintStore } from '../../../../daemon/lib/secrets/mint-ledger.ts';

const TOKEN = 'API_TOKEN' as SecretName;
const OTHER = 'OTHER_TOKEN' as SecretName;

/** A ledger store in memory: `undefined` is a ledger nobody has written yet. */
class MemoryMints implements MintStore {
  document: MintsDocument | undefined;
  writes = 0;
  unreadable = false;

  async read(): Promise<MintsDocument | undefined> {
    if (this.unreadable) throw new Error('damaged');
    return this.document;
  }

  async update(change: (current: MintsDocument) => MintsDocument): Promise<void> {
    this.writes += 1;
    this.document = change(this.document ?? { format: 1, entries: {} });
  }
}

describe('the mint ledger: who wrote a secret’s current value', () => {
  test('a plugin is the minter only while the entry still carries the very write it recorded', async () => {
    const store = new MemoryMints();
    const ledger = new MintLedger(store);
    await ledger.record('plugin-a', TOKEN, 'nonce-1');
    expect(await ledger.mintedBy('plugin-a', TOKEN, 'nonce-1')).toBe(true);
    expect(await ledger.mintedBy('plugin-b', TOKEN, 'nonce-1')).toBe(false);
    expect(await ledger.mintedBy('plugin-a', TOKEN, 'nonce-2')).toBe(false);
    expect(await ledger.mintedBy('plugin-a', OTHER, 'nonce-1')).toBe(false);
  });

  test('a secret with no write identity, or a ledger nobody has written, was minted by nobody', async () => {
    const store = new MemoryMints();
    const ledger = new MintLedger(store);
    expect(await ledger.mintedBy('plugin-a', TOKEN, undefined)).toBe(false);
    expect(await ledger.mintedBy('plugin-a', TOKEN, 'nonce-1')).toBe(false);
  });

  test('recording a second write replaces the first, and keeps the other secrets', async () => {
    const store = new MemoryMints();
    const ledger = new MintLedger(store);
    await ledger.record('plugin-a', TOKEN, 'nonce-1');
    await ledger.record('plugin-a', OTHER, 'nonce-9');
    await ledger.record('plugin-b', TOKEN, 'nonce-2');
    expect(store.document?.entries).toEqual({
      API_TOKEN: { by: 'plugin-b', write: 'nonce-2' },
      OTHER_TOKEN: { by: 'plugin-a', write: 'nonce-9' },
    });
    expect(await ledger.mintedBy('plugin-a', TOKEN, 'nonce-1')).toBe(false);
  });

  test('forgetting removes one entry and leaves the rest; forgetting what is not there writes nothing new', async () => {
    const store = new MemoryMints();
    const ledger = new MintLedger(store);
    await ledger.record('plugin-a', TOKEN, 'nonce-1');
    await ledger.record('plugin-a', OTHER, 'nonce-9');
    await ledger.forget(TOKEN);
    expect(store.document?.entries).toEqual({ OTHER_TOKEN: { by: 'plugin-a', write: 'nonce-9' } });
    const before = store.document;
    await ledger.forget(TOKEN);
    expect(store.document).toBe(before);
  });

  test('a ledger that cannot be read answers that nobody minted it, rather than throwing', async () => {
    const store = new MemoryMints();
    const ledger = new MintLedger(store);
    await ledger.record('plugin-a', TOKEN, 'nonce-1');
    store.unreadable = true;
    expect(await ledger.mintedBy('plugin-a', TOKEN, 'nonce-1')).toBe(false);
  });
});
