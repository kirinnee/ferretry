/**
 * The member session mode, Credentials' member provider, Access' passkey verdicts and Connections' reach, as the daemon
 * composes them: the real `daemon/index.ts` half behind the kernel's own session layer and Dispatcher, a browser end
 * speaking the real records over real WebCrypto. What a join does, what a live member session is, and what ends it.
 * The few branches only a race between two reads can reach are driven on the mode directly, below.
 */
import { describe, expect, it } from 'bun:test';
import { session } from '@ferretry/kernel/host';
import { memberMode } from '../../../daemon/adapters/member-mode.ts';
import {
  APP_ORIGIN,
  type Browser,
  browser,
  CREDENTIAL,
  catalogsFixture,
  DAY,
  joinWith,
  makeCatalog,
  memberSession,
  mintShare,
  unlock,
} from '../../support/daemon-host.ts';

const { MEMBER_JOIN_OUTCOME_BYTES, SESSION_CLOSE_CODES } = session;
const CONCLUDED = 4440;
const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64url');

async function publisher() {
  const fx = await catalogsFixture();
  return { fx, catalog: await makeCatalog(fx, 'Team recipes') };
}

/** A joined key, unlocked on a live session. */
async function unlockedMember() {
  const { fx, catalog } = await publisher();
  const who = await browser();
  const share = await mintShare(fx, { catalogIds: [catalog] });
  const joined = await joinWith(fx, who, share.code);
  const end = await memberSession(fx, who, joined.keyId);
  await unlock(end);
  return { fx, catalog, who, joined, end };
}

describe('joining as a member', () => {
  it('answers join-options with a padded open outcome, refuses a forged proof, and joins once with the code', async () => {
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const who = await browser();

    const asked = await fx.open().handshake();
    await asked.joinOptions(who, share.code);
    const forged = await fx.open().handshake();
    await forged.joinOptions(who, share.code, APP_ORIGIN, await browser());
    const joined = await fx.open().handshake();
    await joined.join(who, share.code);

    expect(asked.records[0]?.bytes).toBe(MEMBER_JOIN_OUTCOME_BYTES);
    expect(asked.records[0]?.message.t).toBe('join-open');
    expect(asked.end?.code).toBe(CONCLUDED);
    expect(forged.records[0]?.message.t).toBe('join-refused');
    expect(joined.records[0]?.message.t).toBe('joined');
  });

  it('counts a join on the carrier the session opened on, the network’s by its peer and the relay’s and tunnel’s on their own', async () => {
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog], uses: { kind: 'multi', cap: 100 } });

    for (const [carrier, peer] of [
      ['relay', undefined],
      ['tunnel', undefined],
      ['direct', { address: '198.51.100.7' }],
    ] as const) {
      const end = await fx.open(carrier, peer).handshake();
      await end.join(await browser(), share.code);
      expect(end.records[0]?.message.t).toBe('joined');
    }
  });

  it('issues a challenge to a person who has a passkey, that a join spends, so a replay is refused', async () => {
    const { fx, joined } = await unlockedMember();
    const second = await browser();
    const share = await mintShare(fx, {
      catalogIds: [await makeCatalog(fx, 'Third')],
      member: { kind: 'existing', memberId: joined.memberId },
    });

    const options = await fx.open().handshake();
    await options.joinOptions(second, share.code);
    const passkey = {
      credentialId: b64(CREDENTIAL),
      clientDataJSON: b64('client'),
      authenticatorData: b64('authenticator'),
      signature: b64('signature'),
    };
    const join = await fx.open().handshake();
    await join.join(second, share.code, { passkey });
    const replay = await fx.open().handshake();
    await replay.join(second, share.code, { passkey });

    expect(options.records[0]?.message.t).toBe('join-challenge');
    expect(join.records[0]?.message.t).toBe('joined');
    expect(replay.records[0]?.message.t).toBe('join-refused');
  });
});

describe('a live member session', () => {
  it('serves a member request with the standing its key and unlock give, and is told when the key is removed', async () => {
    const { fx, joined, end } = await unlockedMember();

    const served = await end.ask('GET', '/v1/shared/me');
    expect(served.status).toBe(200);

    await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}`);
    await end.pump();

    expect(end.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
  });

  it('closes just the one key’s sessions when that key is removed, and leaves the member’s others serving', async () => {
    const { fx, joined, end } = await unlockedMember();
    const other = await memberSession(fx, (await browser()) as Browser, joined.keyId);

    await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}/keys/${joined.keyId}`);
    await end.pump();

    expect(end.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
    expect(other.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
  });

  it('ends an unknown key, a removed key, an idle key and a forged proof with the same 4403', async () => {
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog], uses: { kind: 'multi', cap: 100 } });
    const who = await browser();
    const gone = await browser();
    const idle = await browser();
    const joined = await joinWith(fx, who, share.code);
    const removed = await joinWith(fx, gone, share.code);
    const idleKey = await joinWith(fx, idle, share.code);
    await unlock(await memberSession(fx, idle, idleKey.keyId));
    await fx.host.request('DELETE', `/v1/catalog-members/${removed.memberId}`);

    const unknown = await memberSession(fx, who, `mk_${'Z'.repeat(22)}`);
    const forged = await fx.open().handshake();
    await forged.member(who, joined.keyId, await browser());
    const revoked = await memberSession(fx, gone, removed.keyId);
    await fx.clock.advance(91 * DAY);
    const expired = await memberSession(fx, idle, idleKey.keyId);

    for (const end of [unknown, forged, revoked, expired]) {
      expect(end.end?.code).toBe(SESSION_CLOSE_CODES.authRejected);
      expect(end.records).toEqual([]);
    }
  });
});

describe('the mode itself, where only a race or a hand-made proof reaches', () => {
  const access = { memberId: 'member-1', keyId: 'mk_AAAAAAAAAAAAAAAAAAAAAA', catalogIds: [], memberKey: 'key' };

  /** The mode as the kernel calls it, typed as loosely as a hand-made proof or a bare holder needs. */
  interface Loose {
    readonly mode: {
      holder(proof: unknown): Promise<unknown>;
      watch(holder: unknown, watch: unknown): unknown;
      redeem(attempt: unknown): Promise<unknown>;
    };
    readonly credentials: { standing(holder: unknown): unknown; generation(): number };
    readonly pages: ReadonlyMap<unknown, unknown>;
  }
  const modeWith = (parts: {
    accessNow?: () => unknown;
    track?: () => () => void;
    unlockExpiresAt?: () => number | undefined;
    generations?: { members: () => number; passkeys: () => number };
  }): Loose =>
    memberMode({
      members: {
        accessNow: parts.accessNow ?? (() => access),
        access: async () => access,
        touchKey: async () => undefined,
        generation: parts.generations?.members ?? (() => 0),
      } as never,
      passkeys: {
        unlockExpiresAt: parts.unlockExpiresAt ?? (() => undefined),
        generation: parts.generations?.passkeys ?? (() => 0),
      } as never,
      join: {} as never,
      live: { track: parts.track ?? (() => () => undefined) } as never,
    }) as unknown as Loose;

  it('stands a member’s key as unknown when it is gone, and as a member with its catalogs and any unlock', () => {
    const holder = access.keyId as never;

    expect(modeWith({ accessNow: () => undefined }).credentials.standing(holder)).toBe('unknown');
    expect(modeWith({}).credentials.standing(holder)).toEqual({ kind: 'member', holder, catalogs: [] });
    expect(
      modeWith({ unlockExpiresAt: () => Date.parse('2026-11-10T10:00:00.000Z') }).credentials.standing(holder),
    ).toEqual({ kind: 'member', holder, catalogs: [], unlockedUntil: '2026-11-10T10:00:00.000Z' });
  });

  it('moves its generation only when the members or the passkeys moved', () => {
    let members = 1;
    let passkeys = 1;
    const { credentials } = modeWith({ generations: { members: () => members, passkeys: () => passkeys } });

    const first = credentials.generation();

    expect(credentials.generation()).toBe(first);
    members += 1;
    const second = credentials.generation();
    expect(second).toBeGreaterThan(first);
    expect(credentials.generation()).toBe(second);
    passkeys += 1;
    expect(credentials.generation()).toBeGreaterThan(second);
  });

  it('names no holder for a proof that is not a member’s, has no object body, or names no key', async () => {
    const { mode } = modeWith({});

    expect(await mode.holder({ mode: 'device', body: { keyId: access.keyId } } as never)).toBeUndefined();
    expect(await mode.holder({ mode: 'member', body: null } as never)).toBeUndefined();
    expect(await mode.holder({ mode: 'member', body: 'text' } as never)).toBeUndefined();
    expect(await mode.holder({ mode: 'member', body: { keyId: 7 } } as never)).toBeUndefined();
    expect(await mode.holder({ mode: 'member', body: { keyId: access.keyId } } as never)).toEqual({
      holder: access.keyId,
      key: 'key',
    });
  });

  it('watches nothing for a key that is gone, and lets go of one whose member changed while it was being tracked', () => {
    let released = 0;
    const watch = { revoked: () => undefined, session: 's1', appSession: 'a1' } as never;
    const gone = modeWith({ accessNow: () => undefined });
    let reads = 0;
    const raced = modeWith({
      accessNow: () => (++reads === 1 ? access : { ...access, memberId: 'member-2' }),
      track: () => () => {
        released += 1;
      },
    });

    expect(gone.mode.watch(access.keyId as never, watch)).toBeUndefined();
    expect(raced.mode.watch(access.keyId as never, watch)).toBeUndefined();
    expect(released).toBe(1);
    expect(raced.pages.size).toBe(0);
  });

  it('refuses a redemption that is not a member’s, has no object body, or names an act it does not know', async () => {
    const { mode } = modeWith({});
    const redeem = mode.redeem.bind(mode);
    const attempt = (proof: unknown) => ({ proof, prove: async () => true, carrier: 'relay', peer: 'relay' }) as never;

    expect(await redeem(attempt({ mode: 'device', body: {} }))).toBe('refused');
    expect(await redeem(attempt({ mode: 'member', body: null }))).toBe('refused');
    expect(await redeem(attempt({ mode: 'member', body: { act: 'other' } }))).toBe('refused');
  });
});
