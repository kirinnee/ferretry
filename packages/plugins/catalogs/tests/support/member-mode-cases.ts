/**
 * The two member-session cases that BOTH tiers run: the unit tier (rows R609 and R612 of `member-sessions.test.ts`,
 * which names the guarantee) and the integration tier (`member-mode.test.ts`, which drives the same real `daemon/index.ts`
 * composition to cover the `member-mode` adapter). The arrangement and the assertions live here, once; each tier's test
 * keeps its own name and calls the case, so the two can never drift apart.
 */
import { expect } from 'bun:test';
import { session } from '@ferretry/kernel/host';
import {
  type Browser,
  browser,
  catalogsFixture,
  CREDENTIAL,
  DAY,
  joinWith,
  makeCatalog,
  memberSession,
  mintShare,
  unlock,
} from './daemon-host.ts';

const { SESSION_CLOSE_CODES } = session;
const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64url');

/** A person with a passkey (a joined, unlocked key), invited onto a second browser: a join's challenge is spent once. */
export async function joinChallengeIsSpentByTheJoin(): Promise<void> {
  const fx = await catalogsFixture();
  const catalog = await makeCatalog(fx, 'Team recipes');
  const first = await browser();
  const firstShare = await mintShare(fx, { catalogIds: [catalog] });
  const joined = await joinWith(fx, first, firstShare.code);
  await unlock(await memberSession(fx, first, joined.keyId));
  const second = await browser();
  const share = await mintShare(fx, {
    catalogIds: [await makeCatalog(fx, 'Third')],
    member: { kind: 'existing', memberId: joined.memberId },
  });

  const options = await fx.open().handshake();
  await options.joinOptions(second, share.code);
  const challenge = options.records[0]?.message;
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

  expect(challenge?.t).toBe('join-challenge');
  expect(join.records[0]?.message.t).toBe('joined');
  expect(replay.records[0]?.message.t).toBe('join-refused');
}

/** An unknown key, a removed key, an idle key and a forged proof all end on the one cleartext 4403, with nothing sealed. */
export async function everyUnusableKeyEndsTheSame(): Promise<void> {
  const fx = await catalogsFixture();
  const catalog = await makeCatalog(fx, 'Team recipes');
  const share = await mintShare(fx, { catalogIds: [catalog], uses: { kind: 'multi', cap: 100 } });
  const who: Browser = await browser();
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
  expect(new Set([unknown, forged, revoked, expired].map(end => end.end?.reason)).size).toBe(1);
}
