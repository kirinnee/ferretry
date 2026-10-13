import { describe, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import {
  browserNudgeStorage,
  dismissPasskeyNudge,
  type NudgeStorage,
  PASSKEY_COST_SENTENCE,
  passkeyFailureSentence,
  passkeyLabel,
  passkeyNudgeDismissed,
  registrationClosedSentence,
  unsupportedSentence,
  webAuthnSupported,
} from '../../src/lib/passkey-panel.ts';
import { PasskeyCeremonyError } from '../../src/lib/passkeys.ts';

const ORIGIN = 'https://ferretry.example.test';

const memory = (): NudgeStorage & { readonly values: Map<string, string> } => {
  const values = new Map<string, string>();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

const throwing: NudgeStorage = {
  getItem: () => {
    throw new Error('storage denied');
  },
  setItem: () => {
    throw new Error('storage denied');
  },
};

describe('passkey panel sentences', () => {
  it('states the cost of a passkey verbatim', () => {
    // Assert
    should(PASSKEY_COST_SENTENCE).equal(
      'Changing settings, opening a terminal or the browser, and adding a device ask you to confirm with a passkey on this device.',
    );
  });

  it('needs the credential API and a secure address together', () => {
    // Act / Assert
    should(webAuthnSupported({ hasCredentialApi: true, secureContext: true })).be.true();
    should(webAuthnSupported({ hasCredentialApi: true, secureContext: false })).be.false();
    should(webAuthnSupported({ hasCredentialApi: false, secureContext: true })).be.false();
    // The default reads the live environment; the test DOM has no PublicKeyCredential.
    should(typeof webAuthnSupported()).equal('boolean');
  });

  it('names the address when a browser cannot hold passkeys', () => {
    should(unsupportedSentence(ORIGIN)).containEql(ORIGIN);
  });

  it('says a different next step for a first passkey and for a second', () => {
    should(registrationClosedSentence(false)).containEql('10 minutes of pairing');
    should(registrationClosedSentence(true)).containEql('recent passkey confirmation');
  });

  it('turns every ceremony failure and daemon refusal into one plain sentence', () => {
    // Arrange
    const refusal = (code: string): FyHttpError => new FyHttpError('raw daemon text', 403, code);

    // Act / Assert
    should(passkeyFailureSentence(new PasskeyCeremonyError('cancelled'), ORIGIN)).containEql('did not finish');
    should(passkeyFailureSentence(refusal('step_up_not_a_device'), ORIGIN)).containEql('paired device');
    should(passkeyFailureSentence(refusal('step_up_origin_not_allowed'), ORIGIN)).containEql(ORIGIN);
    should(passkeyFailureSentence(refusal('step_up_registration_closed'), ORIGIN)).containEql('10 minutes');
    should(passkeyFailureSentence(refusal('step_up_too_many_passkeys'), ORIGIN)).containEql('as many passkeys');
    should(passkeyFailureSentence(refusal('step_up_no_passkey'), ORIGIN)).containEql('no passkey for this machine');
    should(passkeyFailureSentence(refusal('step_up_not_verified'), ORIGIN)).containEql('did not check out');
    // Anything else is one sentence too, and never the raw text or a status.
    should(passkeyFailureSentence(refusal('something_else'), ORIGIN)).equal('The passkey was not added. Try again.');
    should(passkeyFailureSentence(new Error('boom'), ORIGIN)).equal('The passkey was not added. Try again.');
  });

  it('labels a passkey from its origin and date, and survives a date it cannot read', () => {
    // Act
    const dated = passkeyLabel({ origin: ORIGIN, createdAt: '2025-12-20T18:22:00.000Z' });
    const undated = passkeyLabel({ origin: ORIGIN, createdAt: 'not a date' });

    // Assert
    should(dated).startWith(`Passkey for ${ORIGIN}, added `);
    should(dated).containEql('2025');
    should(undated).equal(`Passkey for ${ORIGIN}, added an unknown date`);
  });
});

describe('passkey nudge dismissal storage', () => {
  it('remembers a dismissal per machine', () => {
    // Arrange
    const storage = memory();

    // Act
    dismissPasskeyNudge(storage, 'daemon-a');

    // Assert
    should(passkeyNudgeDismissed(storage, 'daemon-a')).be.true();
    should(passkeyNudgeDismissed(storage, 'daemon-b')).be.false();
  });

  it('reads as not dismissed, and writes nothing, when storage is absent or refuses', () => {
    // Act / Assert — none of these throws.
    should(passkeyNudgeDismissed(undefined, 'daemon-a')).be.false();
    should(passkeyNudgeDismissed(throwing, 'daemon-a')).be.false();
    dismissPasskeyNudge(undefined, 'daemon-a');
    dismissPasskeyNudge(throwing, 'daemon-a');
  });

  it('finds the browser storage, or nothing, without throwing', () => {
    // Act
    const found = browserNudgeStorage();

    // Assert — the test DOM provides one.
    should(found === undefined || typeof found.getItem === 'function').be.true();
  });

  it('treats a throwing storage property as no storage', () => {
    // Arrange
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied');
      },
    });

    try {
      // Act / Assert
      should(browserNudgeStorage()).be.undefined();
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
