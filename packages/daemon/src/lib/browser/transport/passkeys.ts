import type { InputCdpSession } from './input-fields.ts';

/**
 * KEEPS THE AGENT BROWSER FROM OFFERING A PASSKEY. A page that is asked for a passkey either shows a
 * browser dialog nobody is there to answer or waits on one; the agent browser signs in with a password the
 * owner types into a card, so a page must find no passkey and fall back to that.
 *
 * It adds a virtual authenticator that can neither remember a credential nor verify a user, and whose
 * every touch is a bad one. Then `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` is
 * false, so a site does not offer a passkey, and `navigator.credentials.get` and `create` with a
 * `publicKey` fail at once with a `NotAllowedError` instead of waiting. Nothing about the browser's
 * identity changes: no user agent, no fingerprint.
 *
 * NEVER BREAKS A PAGE. Any step that fails is dropped and the page goes on as it was.
 */
export async function disablePasskeys(session: InputCdpSession): Promise<void> {
  try {
    await session.send('WebAuthn.enable', { enableUI: false });
    const added = (await session.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'usb',
        hasResidentKey: false,
        hasUserVerification: false,
        isUserVerified: false,
        automaticPresenceSimulation: true,
      },
    })) as { readonly authenticatorId?: unknown } | null;
    if (typeof added?.authenticatorId !== 'string') return;
    await session.send('WebAuthn.setResponseOverrideBits', { authenticatorId: added.authenticatorId, isBadUP: true });
  } catch {
    // A page without the passkey switch is still a page: the owner can answer whatever it asks.
  }
}
