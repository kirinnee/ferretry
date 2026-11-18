import { describe, it } from 'bun:test';
import { FyHttpError } from '../../../app/shell-grants.ts';
import should from 'should';
import {
  browserNudgeStorage,
  dismissPasskeyNudge,
  type NudgeStorage,
  PASSKEY_COST_SENTENCE,
  passkeyFailureSentence,
  passkeyLabel,
  passkeyNudgeDismissed,
  passkeyWindowCommand,
  registrationMinutesLeft,
  confirmExistingSentence,
  registrationClosedSentence,
  registrationClosesSentence,
  unsupportedSentence,
  webAuthnSupported,
} from '../../../app/lib/passkey-panel.ts';
import { PasskeyCeremonyError } from '@ferretry/app';

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

describe('how long the first-passkey window has left (U-P)', () => {
  const now = Date.parse('2026-11-17T10:00:00.000Z');

  it('should round up to whole minutes, and say less than a minute under one', () => {
    should(registrationMinutesLeft('2026-11-17T10:07:00.000Z', now)).equal('7 minutes left');
    should(registrationMinutesLeft('2026-11-17T10:06:01.000Z', now)).equal('7 minutes left');
    should(registrationMinutesLeft('2026-11-17T10:00:30.000Z', now)).equal('less than a minute left');
  });

  it('should say nothing for no end, an unreadable end, or one that has passed', () => {
    should(registrationMinutesLeft(undefined, now)).be.null();
    should(registrationMinutesLeft('soon', now)).be.null();
    should(registrationMinutesLeft('2026-11-17T09:59:59.000Z', now)).be.null();
  });
});

describe('the command the owner runs at the machine (U-P)', () => {
  const id = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';

  it('should name the device as one single-quoted word', () => {
    should(passkeyWindowCommand({ name: 'Liftoff Browser', id })).equal("fy passkey window 'Liftoff Browser'");
    should(passkeyWindowCommand({ name: "Ann's phone", id })).equal("fy passkey window 'Ann'\\''s phone'");
    should(passkeyWindowCommand({ name: '$(reboot); `id` && x', id })).equal(
      "fy passkey window '$(reboot); `id` && x'",
    );
  });

  it('should say the client program the machine runs, and only fy when it named none or named something unsafe', () => {
    should(passkeyWindowCommand({ name: 'Liftoff Browser', id, clientName: 'fy5' })).equal(
      "fy5 passkey window 'Liftoff Browser'",
    );
    should(passkeyWindowCommand({ id, clientName: 'fy5' })).equal(`fy5 passkey window ${id}`);
    should(passkeyWindowCommand({ name: 'Phone', id })).equal("fy passkey window 'Phone'");
    should(passkeyWindowCommand({ name: 'Phone', id, clientName: 'fy; reboot' })).equal("fy passkey window 'Phone'");
    should(passkeyWindowCommand({ name: 'Phone', id, clientName: '-x' })).equal("fy passkey window 'Phone'");
  });

  it('should print the id instead of a name that could change what the shell reads or what the owner sees', () => {
    const fallback = `fy passkey window ${id}`;
    should(passkeyWindowCommand({ name: 'two\nlines', id })).equal(fallback);
    should(passkeyWindowCommand({ name: 'tab\there', id })).equal(fallback);
    should(passkeyWindowCommand({ name: 'flip\u202Eit', id })).equal(fallback);
    should(passkeyWindowCommand({ name: '--help', id })).equal(fallback);
    should(passkeyWindowCommand({ name: '   ', id })).equal(fallback);
    should(passkeyWindowCommand({ id })).equal(fallback);
  });

  it('should fill the real command into the closed-window sentence, and only fall back to a placeholder with none', () => {
    should(registrationClosedSentence(false, "fy passkey window 'Phone'")).containEql(
      "run `fy passkey window 'Phone'`",
    );
    should(registrationClosedSentence(false)).containEql('<this device>');
  });
});

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

  it('P130 says a different next step for a first passkey and for a second', () => {
    should(registrationClosedSentence(false)).containEql('10 minutes of pairing');
    should(registrationClosedSentence(false)).containEql('fy passkey window <this device>');
    should(registrationClosedSentence(true)).containEql(
      'ask the owner to run `fy passkey window <this device>` at the machine',
    );
    should(registrationClosedSentence(true)).not.containEql('make a change');
  });

  it('names the machine when adding a passkey starts with a confirmation', () => {
    should(confirmExistingSentence('Kirin box')).equal(
      'Adding a passkey for Kirin box asks you to confirm with a passkey this device already holds first.',
    );
  });

  it('says when an open registration window closes, and nothing when no end is named', () => {
    should(registrationClosesSentence(undefined)).be.null();
    should(registrationClosesSentence('not a date')).be.null();
    should(registrationClosesSentence('2026-01-01T00:10:00.000Z')).startWith('You can add a passkey until ');
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
    should(passkeyFailureSentence(refusal('step_up_rotation_required'), ORIGIN)).containEql('new key');
    should(passkeyFailureSentence(refusal('step_up_not_at_machine'), ORIGIN)).containEql('owner at the machine');
    should(passkeyFailureSentence(refusal('step_up_unknown_device'), ORIGIN)).containEql('does not know this device');
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
