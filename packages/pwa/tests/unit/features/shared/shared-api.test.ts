/**
 * The member route table from the browser's side: the path, the method and the body of each call.
 */

import { describe, it } from 'bun:test';
import type { z } from 'zod';
import should from 'should';
import {
  leavePublisher,
  passkeyOptions,
  readMe,
  readSharedItem,
  readSharedManifest,
  redeemShare,
  registerPasskey,
  unlockMember,
  unlockOptions,
} from '../../../../src/features/shared/shared-api.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

const recording = (answer: unknown) => {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      request: async <T extends z.ZodType>(path: string, _schema: T, init?: RequestInit): Promise<z.infer<T>> => {
        calls.push({ path, init });
        return answer as z.infer<T>;
      },
    },
  };
};

const bodyOf = (call: Call | undefined): unknown => JSON.parse(String(call?.init?.body));
const CODE = 'fy_share_FAKEFAKEFAKEFAKEFAKEFA';

describe('the shared api', () => {
  it('should ask for passkey options with the app origin', async () => {
    const { client, calls } = recording({});
    await passkeyOptions(client, 'https://app.ferretry.test');
    should(calls[0]?.path).equal('/v1/shared/passkeys/options');
    should(calls[0]?.init?.method).equal('POST');
    should(bodyOf(calls[0])).deepEqual({ origin: 'https://app.ferretry.test' });
  });

  it('should send the registration as it came from the browser', async () => {
    const { client, calls } = recording({});
    const registration = { credentialId: 'AA', clientDataJSON: 'BB', attestationObject: 'CC' };
    await registerPasskey(client, registration);
    should(calls[0]?.path).equal('/v1/shared/passkeys');
    should(bodyOf(calls[0])).deepEqual(registration);
  });

  it('should ask for unlock options with the app origin, then send the assertion', async () => {
    const options = recording({});
    await unlockOptions(options.client, 'https://app.ferretry.test');
    should(options.calls[0]?.path).equal('/v1/shared/unlock/options');
    should(bodyOf(options.calls[0])).deepEqual({ origin: 'https://app.ferretry.test' });

    const unlock = recording({ unlockedUntil: '2026-11-30T00:00:00.000Z' });
    const assertion = { credentialId: 'AA', clientDataJSON: 'BB', authenticatorData: 'CC', signature: 'DD' };
    await unlockMember(unlock.client, assertion);
    should(unlock.calls[0]?.path).equal('/v1/shared/unlock');
    should(bodyOf(unlock.calls[0])).deepEqual(assertion);
  });

  it('should read who this member is with a plain GET', async () => {
    const { client, calls } = recording({});
    await readMe(client);
    should(calls[0]).deepEqual({ path: '/v1/shared/me', init: undefined });
  });

  it('should read a manifest and an item by encoded path', async () => {
    const { client, calls } = recording({});
    await readSharedManifest(client, 'cat_a/b');
    await readSharedItem(client, 'cat_a', 'itm_b', 3);
    should(calls[0]?.path).equal('/v1/shared/catalogs/cat_a%2Fb/manifest');
    should(calls[1]?.path).equal('/v1/shared/catalogs/cat_a/items/itm_b/3');
  });

  it('should redeem a code and leave', async () => {
    const redeem = recording({ added: [] });
    await redeemShare(redeem.client, CODE);
    should(redeem.calls[0]?.path).equal('/v1/shared/redeem');
    should(bodyOf(redeem.calls[0])).deepEqual({ code: CODE });

    const leave = recording({ keyId: 'mk_AAAAAAAAAAAAAAAAAAAAAA' });
    await leavePublisher(leave.client);
    should(leave.calls[0]?.path).equal('/v1/shared/me/keys/self');
    should(leave.calls[0]?.init).deepEqual({ method: 'DELETE' });
  });
});
