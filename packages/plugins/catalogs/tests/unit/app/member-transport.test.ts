import { describe, expect, it } from 'bun:test';
import { setMemberCarriers, WebCryptoRelayCrypto } from '@ferretry/app';
import type { ShareLinkSeed } from '../../../contract/wire/index.ts';
import { MemberUnreachableError } from '../../../app/lib/member-client.ts';
import { currentMemberTransport, memberTransportOver, noMemberTransport } from '../../../app/lib/member-transport.ts';

const SEED = {
  daemonId: `fy_daemon_${'a'.repeat(43)}`,
  daemonUrl: 'https://box.example.test',
  code: 'fy_share_aaaaaaaaaaaaaaaaaaaaaa',
} as unknown as ShareLinkSeed;
const KEYS = { signingKey: {} as CryptoKey, publicKey: 'pk', boxKey: 'bk' } as never;
const SUBSCRIPTION = { daemonId: SEED.daemonId, daemonUrl: SEED.daemonUrl, keyId: 'mk_x', signingKey: {} } as never;

describe('the member transport fails closed', () => {
  it('reaches nobody while the shell offers no member carriers, and sends nothing', async () => {
    setMemberCarriers(undefined);
    const transport = currentMemberTransport();
    expect(transport).toBe(noMemberTransport);
    expect(await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS })).toEqual({
      kind: 'unreachable',
      maybeSpentUnheard: false,
      tried: 0,
    });
    expect(await transport.joinOptions({ seed: SEED, keys: KEYS })).toEqual({ kind: 'unreachable' });
    await expect(transport.openClient(SUBSCRIPTION)).rejects.toBeInstanceOf(MemberUnreachableError);
  });

  it('answers unreachable, with the number of legs it tried, when the carriers offer none', async () => {
    const carriers = {
      legs: () => [],
      tunnelRequest: () => ({}),
      tunnelResponse: () => new Response(null),
      deviceKeyHandle: () => ({}) as never,
    };
    const transport = memberTransportOver(carriers, new WebCryptoRelayCrypto());
    expect(await transport.join({ seed: SEED, clientName: 'Browser', keys: KEYS })).toEqual({
      kind: 'unreachable',
      maybeSpentUnheard: false,
      tried: 0,
    });
    const client = await transport.openClient(SUBSCRIPTION);
    await expect(client.request('/v1/shared/me', { parse: (value: unknown) => value } as never)).rejects.toBeInstanceOf(
      MemberUnreachableError,
    );
  });
});
