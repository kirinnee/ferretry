import { describe, it } from 'bun:test';
import should from 'should';
import { disablePasskeys, type InputCdpSession } from '../../../../src/lib/index.ts';

/** A session that records each call as `[method, params]` and answers from a table. */
function recording(
  answers: Record<string, unknown> = {},
  failing?: string,
): InputCdpSession & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async send(method, params) {
      calls.push([method, params]);
      if (method === failing) throw new Error('not supported');
      return answers[method] ?? {};
    },
  };
}

describe('disablePasskeys', () => {
  it('enables WebAuthn without its UI, adds a virtual authenticator that cannot verify, and makes every touch bad', async () => {
    const session = recording({ 'WebAuthn.addVirtualAuthenticator': { authenticatorId: 'auth-1' } });
    await disablePasskeys(session);
    should(session.calls).eql([
      ['WebAuthn.enable', { enableUI: false }],
      [
        'WebAuthn.addVirtualAuthenticator',
        {
          options: {
            protocol: 'ctap2',
            transport: 'usb',
            hasResidentKey: false,
            hasUserVerification: true,
            isUserVerified: false,
            automaticPresenceSimulation: true,
          },
        },
      ],
      ['WebAuthn.setResponseOverrideBits', { authenticatorId: 'auth-1', isBadUP: true }],
    ]);
  });

  it('sets nothing on an authenticator it was not given an id for', async () => {
    const session = recording({ 'WebAuthn.addVirtualAuthenticator': {} });
    await disablePasskeys(session);
    should(session.calls.map(([method]) => method)).eql(['WebAuthn.enable', 'WebAuthn.addVirtualAuthenticator']);
  });

  for (const failing of ['WebAuthn.enable', 'WebAuthn.addVirtualAuthenticator', 'WebAuthn.setResponseOverrideBits']) {
    it(`swallows a failure of ${failing} and stops there`, async () => {
      const session = recording({ 'WebAuthn.addVirtualAuthenticator': { authenticatorId: 'auth-1' } }, failing);
      await disablePasskeys(session);
      should(session.calls[session.calls.length - 1]?.[0]).equal(failing);
    });
  }

  it('answers for a session that answers nothing', async () => {
    const session: InputCdpSession = { send: async () => null };
    await disablePasskeys(session);
  });
});
