/**
 * The browser's half of the passkey routes: each call names the right path, method and body, and its
 * answer is parsed with the protocol's schema.
 */

import { describe, it } from 'bun:test';
import type { PasskeyRegistration, StepUpAssertion } from '@ferretry/protocol';
import should from 'should';
import type { z } from 'zod';
import {
  fetchPasskeys,
  passkeyRegistrationOptions,
  unlockOptions,
  registerPasskey,
  type StepUpClient,
  stepUpOptions,
  submitUnlock,
  submitStepUp,
} from '../../src/lib/step-up-client.ts';

const ORIGIN = 'https://ferretry.pages.dev';
const INSTANT = '2026-10-13T10:00:00.000Z';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

/** A client that records each request and answers it through the schema it was handed. */
function clientAnswering(reply: unknown): StepUpClient & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return schema.parse(reply);
    },
  };
}

const bodyOf = (call: Call | undefined): unknown => JSON.parse(String(call?.init?.body));

describe('the passkey routes', () => {
  it('should read what this device holds with a GET', async () => {
    // Arrange
    const passkey = { id: 'AQID', origin: ORIGIN, createdAt: INSTANT };
    const client = clientAnswering({ passkeys: [passkey], registration: 'confirm-existing', stepUpUntil: INSTANT });

    // Act
    const view = await fetchPasskeys(client);

    // Assert
    should(client.calls).have.length(1);
    should(client.calls[0]?.path).equal('/v1/passkeys');
    should(client.calls[0]?.init).eql({ method: 'GET' });
    should(view).eql({ passkeys: [passkey], registration: 'confirm-existing', stepUpUntil: INSTANT });
  });

  it('should ask for registration options with the app origin as a JSON POST', async () => {
    // Arrange
    const options = {
      challenge: 'AQIDBA',
      rp: { id: 'ferretry.pages.dev', name: 'Ferretry' },
      user: { id: 'CQk', name: 'phone', displayName: 'Phone' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [],
      timeout: 60_000,
    };
    const client = clientAnswering(options);

    // Act
    const answer = await passkeyRegistrationOptions(client, ORIGIN);

    // Assert
    const call = client.calls[0];
    should(call?.path).equal('/v1/passkeys/options');
    should(call?.init?.method).equal('POST');
    should(call?.init?.headers).eql({ 'content-type': 'application/json' });
    should(bodyOf(call)).eql({ origin: ORIGIN });
    should(answer.rp.id).equal('ferretry.pages.dev');
  });

  it('should read the confirm assertion options a device that holds a passkey is given', async () => {
    // Arrange
    const client = clientAnswering({
      challenge: 'AQIDBA',
      rp: { id: 'ferretry.pages.dev', name: 'Ferretry' },
      user: { id: 'CQk', name: 'phone', displayName: 'Phone' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [],
      timeout: 60_000,
      confirm: {
        challenge: 'BQYH',
        rpId: 'ferretry.pages.dev',
        allowCredentials: [{ type: 'public-key', id: 'qrs' }],
        timeout: 60_000,
      },
    });

    // Act
    const answer = await passkeyRegistrationOptions(client, ORIGIN);

    // Assert
    should(answer.confirm?.rpId).equal('ferretry.pages.dev');
  });

  it('should send a registration with its confirmation assertion as the body', async () => {
    // Arrange
    const registration: PasskeyRegistration = {
      credentialId: 'qrs',
      clientDataJSON: 'e30',
      attestationObject: 'oA',
      confirmation: { credentialId: 'abc', clientDataJSON: 'e30', authenticatorData: 'AQID', signature: 'BAU' },
    };
    const client = clientAnswering({ id: 'qrs', origin: ORIGIN, createdAt: INSTANT });

    // Act
    await registerPasskey(client, registration);

    // Assert
    should(bodyOf(client.calls[0])).eql(registration);
  });

  it('should send a new credential as the body and read back the passkey it became', async () => {
    // Arrange
    const registration: PasskeyRegistration = {
      credentialId: 'qrs',
      clientDataJSON: 'e30',
      attestationObject: 'oA',
    };
    const client = clientAnswering({ id: 'qrs', origin: ORIGIN, createdAt: INSTANT });

    // Act
    const view = await registerPasskey(client, registration);

    // Assert
    const call = client.calls[0];
    should(call?.path).equal('/v1/passkeys');
    should(call?.init?.method).equal('POST');
    should(bodyOf(call)).eql(registration);
    should(view).eql({ id: 'qrs', origin: ORIGIN, createdAt: INSTANT });
  });

  it('should ask for step-up options with the app origin as a JSON POST', async () => {
    // Arrange
    const client = clientAnswering({
      challenge: 'BQYH',
      rpId: 'ferretry.pages.dev',
      allowCredentials: [{ type: 'public-key', id: 'qrs' }],
      timeout: 60_000,
    });

    // Act
    const options = await stepUpOptions(client, ORIGIN);

    // Assert
    const call = client.calls[0];
    should(call?.path).equal('/v1/step-up/options');
    should(call?.init?.method).equal('POST');
    should(call?.init?.headers).eql({ 'content-type': 'application/json' });
    should(bodyOf(call)).eql({ origin: ORIGIN });
    should(options.allowCredentials).have.length(1);
  });

  it('should name the act in the step-up options request when it is for one', async () => {
    // Arrange
    const client = clientAnswering({
      challenge: 'BQYH',
      rpId: 'ferretry.pages.dev',
      allowCredentials: [{ type: 'public-key', id: 'qrs' }],
      timeout: 60_000,
    });

    // Act
    await stepUpOptions(client, ORIGIN, 'catalog-install');

    // Assert
    should(bodyOf(client.calls[0])).eql({ origin: ORIGIN, act: 'catalog-install' });
  });

  it('should submit the assertion as the body and read back when the step-up lapses', async () => {
    // Arrange
    const assertion: StepUpAssertion = {
      credentialId: 'qrs',
      clientDataJSON: 'e30',
      authenticatorData: 'AQID',
      signature: 'BAU',
    };
    const client = clientAnswering({ expiresAt: INSTANT });

    // Act
    const granted = await submitStepUp(client, assertion);

    // Assert
    const call = client.calls[0];
    should(call?.path).equal('/v1/step-up');
    should(call?.init?.method).equal('POST');
    should(bodyOf(call)).eql(assertion);
    should(granted).eql({ expiresAt: INSTANT });
  });

  it('should refuse an answer the schema does not accept rather than hand it on', async () => {
    // Arrange
    const client = clientAnswering({ expiresAt: 'not a time' });

    // Act, Assert
    await should(
      submitStepUp(client, { credentialId: 'a', clientDataJSON: 'b', authenticatorData: 'c', signature: 'd' }),
    ).rejected();
  });
});

describe('the presence routes', () => {
  it('should ask for options at the app origin on its own route', async () => {
    const client = clientAnswering({
      challenge: 'AAAA',
      rpId: 'ferretry.pages.dev',
      allowCredentials: [{ type: 'public-key', id: 'AQID' }],
      timeout: 60_000,
    });

    await unlockOptions(client, ORIGIN);

    should(client.calls[0]?.path).equal('/v1/unlock/options');
    should(client.calls[0]?.init?.method).equal('POST');
    should(bodyOf(client.calls[0])).eql({ origin: ORIGIN });
  });

  it('should submit the assertion on its own route and read when it lapses', async () => {
    const client = clientAnswering({ unlockedUntil: INSTANT });
    const assertion: StepUpAssertion = {
      credentialId: 'AQID',
      clientDataJSON: 'BA',
      authenticatorData: 'BQ',
      signature: 'Bg',
    };

    const granted = await submitUnlock(client, assertion);

    should(granted.unlockedUntil).equal(INSTANT);
    should(client.calls[0]?.path).equal('/v1/unlock');
    should(bodyOf(client.calls[0])).eql(assertion);
  });
});
