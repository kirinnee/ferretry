/**
 * Member subscriptions in memory, for every suite above the key store itself, with a record of what was
 * saved, refused and forgotten: "saved only after joined" and "a refusal never deletes" are claims about
 * exactly those calls.
 */

import {
  type MemberKeyStore,
  type MemberSubscription,
  type MintedMemberKeys,
  mintMemberKeys,
  webCryptoMemberKeyGenerator,
} from '../../src/lib/member-keys.ts';

export class MemoryMemberKeyStore implements MemberKeyStore {
  readonly subscriptions = new Map<string, MemberSubscription>();
  readonly saved: string[] = [];
  readonly refused: string[] = [];
  readonly forgotten: string[] = [];

  async list(): Promise<readonly MemberSubscription[]> {
    return [...this.subscriptions.values()];
  }

  async load(daemonId: string): Promise<MemberSubscription | undefined> {
    return this.subscriptions.get(daemonId);
  }

  async save(subscription: MemberSubscription): Promise<void> {
    this.saved.push(subscription.daemonId);
    this.subscriptions.set(subscription.daemonId, subscription);
  }

  async markRefused(daemonId: string, at: string): Promise<boolean> {
    const found = this.subscriptions.get(daemonId);
    if (found === undefined) return false;
    this.refused.push(daemonId);
    this.subscriptions.set(daemonId, { ...found, status: 'refused', refusedAt: at });
    return true;
  }

  async rename(daemonId: string, ownLabel: string): Promise<boolean> {
    const found = this.subscriptions.get(daemonId);
    if (found === undefined) return false;
    this.subscriptions.set(daemonId, { ...found, ownLabel });
    return true;
  }

  async forget(daemonId: string): Promise<void> {
    this.forgotten.push(daemonId);
    this.subscriptions.delete(daemonId);
  }
}

/** Real member keys, as a join mints them. */
export const testMemberKeys = (): Promise<MintedMemberKeys> => mintMemberKeys(webCryptoMemberKeyGenerator());

/** A subscription a join would have saved, with real keys. */
export const testSubscription = async (
  daemonId: string,
  overrides: Partial<MemberSubscription> = {},
): Promise<MemberSubscription> => {
  const keys = await testMemberKeys();
  return {
    daemonId,
    daemonName: 'Studio',
    daemonUrl: 'https://studio.example.test',
    ownLabel: 'Studio',
    keyId: 'mk_AAAAAAAAAAAAAAAAAAAAAA',
    memberId: 'mbr_AAAAAAAAAAAAAAAAAAAAAA',
    memberLabel: 'Alice',
    status: 'active',
    joinedAt: '2026-10-31T10:00:00.000Z',
    passkeyWindowEndsAt: '2026-10-31T10:10:00.000Z',
    unlockDays: 30,
    carriers: [],
    publicKey: keys.publicKey,
    boxKey: keys.boxKey,
    signingKey: keys.signingKey,
    boxPrivateKey: keys.boxPrivateKey,
    ...overrides,
  };
};
