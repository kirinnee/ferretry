import { describe, it } from 'bun:test';
import should from 'should';
import { toBase64Url } from '../../../../daemon/lib/proof/binary.ts';
import { stepUpRoutes } from '../../../../daemon/lib/routes/step-up.ts';
import { stepUpProvider } from '../../../../daemon/step-up-provider.ts';
import { jsonBody, respond } from '../../../support/daemon/call.ts';
import { fixture, laptop, phone, remote } from '../../../support/daemon/step-up-fixture.ts';
import {
  assertion,
  attestedCredential,
  cbor,
  CREDENTIAL_ID,
  es256Authenticator,
  ORIGIN,
  registration,
} from '../../../support/daemon/passkey-authenticator.ts';

/**
 * A SESSION THE KERNEL STAMPED PROVES A PASSKEY, AND THE PROOF IS FOUND BY THE PAGE THAT MADE IT (the P0 of #2231).
 *
 * The kernel stamps a device principal with TWO ids: `session`, the per-connection transcript hash, and `appSession`,
 * the page's own id. The step-up proof is keyed by (device, appSession). The defect keyed it by `session`, so a good
 * passkey was granted under one key and looked up under another: the unit fixtures set one id for both, every test was
 * green, and the owner's first confirm after a passkey was refused.
 *
 * Nothing here is a fixture agreeing with itself: the request carries a principal whose two ids always differ (as
 * `support/daemon/call.ts` stamps it), the route, the service, the registry and the WebAuthn verifier are the production
 * ones, and the proof is read back through `stepUpProvider`, the `step-up:device` value Gate asks. It fails when the route
 * keys the grant by `session`, or when Gate's admission keys the claim by it (the admission side is pinned in Gate's own
 * `admission-app-session.test.ts`; Access cannot import Gate's daemon).
 */

const page = { deviceId: phone.deviceId, appSession: phone.appSession };
const transcriptOf = (deviceId: string) => `transcript-${deviceId}`;

async function provedOnce() {
  const world = fixture();
  const authenticator = await es256Authenticator();
  const made = await registration(authenticator, {
    auth: { flags: 0x45, attested: attestedCredential(cbor(authenticator.coseKey), CREDENTIAL_ID) },
  });
  await world.service.registrationOptions(remote(), ORIGIN);
  const registered = await world.service.register(remote(), {
    credentialId: toBase64Url(CREDENTIAL_ID),
    clientDataJSON: toBase64Url(made.clientDataJSON),
    attestationObject: toBase64Url(made.attestationObject),
  });
  should(registered.ok).be.true();

  const routes = stepUpRoutes(world.service);
  const ask = (key: string, body: unknown) => respond(routes, key, { body: JSON.stringify(body), device: page });
  const options = await ask('POST /v1/step-up/options', { origin: ORIGIN });
  should(options.status).equal(200);
  should(jsonBody(options)).have.property('challenge');

  const signed = await assertion(authenticator);
  const granted = await ask('POST /v1/step-up', {
    credentialId: toBase64Url(CREDENTIAL_ID),
    clientDataJSON: toBase64Url(signed.clientDataJSON),
    authenticatorData: toBase64Url(signed.authenticatorData),
    signature: toBase64Url(signed.signature),
  });
  should(granted.status).equal(200);
  return { world, witness: stepUpProvider(() => world.service) };
}

describe('a kernel-stamped app session drives the step-up registry', () => {
  it('should hold the proof under the page that made it and let that page claim it once', async () => {
    // Arrange
    const { witness } = await provedOnce();

    // Act
    const held = witness.freshlyHeld(page);
    const first = witness.claimFresh(page);
    const second = witness.claimFresh(page);

    // Assert
    should([held, first, second]).deepEqual([true, true, false]);
  });

  it('should not hold the proof under the connection transcript, another page of the device, or another device', async () => {
    // Arrange
    const { witness } = await provedOnce();
    const others = [
      { deviceId: phone.deviceId, appSession: transcriptOf(phone.deviceId) },
      { deviceId: phone.deviceId, appSession: 'tab-two' },
      { deviceId: laptop.deviceId, appSession: phone.appSession },
      laptop,
    ];

    // Act
    const held = others.map(subject => witness.freshlyHeld(subject));
    const claimed = others.map(subject => witness.claimFresh(subject));

    // Assert
    should(held).deepEqual([false, false, false, false]);
    should(claimed).deepEqual([false, false, false, false]);
  });
});
