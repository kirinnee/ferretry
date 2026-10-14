/**
 * The browser's half of the security settings: each call names the right path, method and body, the
 * answer is parsed with the protocol's schema, and every failure is one plain sentence.
 */

import { describe, it } from 'bun:test';
import { SECURITY_WIDEN_REFUSED_CODE, STEP_UP_REQUIRED_CODE } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import type { z } from 'zod';
import {
  boundsSentence,
  changeSecuritySettings,
  DAMAGED_SETTINGS_SENTENCE,
  describeSettingValue,
  UNLOCK_STAYS_FALLBACK,
  unlockStaysSentence,
  devicesExpiringSentence,
  fetchSecuritySettings,
  parseSettingDraft,
  SECURITY_SETTING_COPY,
  type SecuritySettingsClient,
  securityFailureSentence,
  widenAtMachineSentence,
} from '../../src/lib/security-settings-client.ts';

const SETTINGS = {
  stepUpWindowMinutes: 15,
  deviceKeyRotationDays: 30,
  unlockOnOpen: true,
  unlockValidityHours: 8,
  stepUpOnActions: false,
  idleExpiryDays: 30,
};
const VIEW = {
  settings: SETTINGS,
  source: 'document',
  mayWiden: false,
  widenCommand: 'fy daemon security set <field> <value>',
};

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

function clientAnswering(reply: unknown): SecuritySettingsClient & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return schema.parse(reply);
    },
  };
}

describe('the security settings routes', () => {
  it('should read the settings with a GET', async () => {
    const client = clientAnswering(VIEW);

    const view = await fetchSecuritySettings(client);

    should(view.settings.stepUpWindowMinutes).equal(15);
    should(client.calls[0]?.path).equal('/v1/security');
    should(client.calls[0]?.init?.method).equal('GET');
  });

  it('should PATCH only the field that changed, and parse the change', async () => {
    const client = clientAnswering({ view: VIEW, devicesExpiring: 2 });

    const change = await changeSecuritySettings(client, { idleExpiryDays: 7 });

    should(change.devicesExpiring).equal(2);
    should(client.calls[0]?.path).equal('/v1/security');
    should(client.calls[0]?.init?.method).equal('PATCH');
    should(JSON.parse(String(client.calls[0]?.init?.body))).eql({ idleExpiryDays: 7 });
  });
});

describe('what a setting says', () => {
  it('should put the value in the right number of its unit', () => {
    should(describeSettingValue('stepUpWindowMinutes', 1)).equal('1 minute');
    should(describeSettingValue('stepUpWindowMinutes', 0)).equal('0 minutes');
    should(describeSettingValue('idleExpiryDays', 30)).equal('30 days');
    should(describeSettingValue('unlockValidityHours', 1)).equal('1 hour');
  });

  it('should say how long an unlock stays, in the machine’s own number, and when it cannot be read', () => {
    should(unlockStaysSentence(8)).equal('It stays unlocked on this device for 8 hours.');
    should(unlockStaysSentence(1)).equal('It stays unlocked on this device for 1 hour.');
    should(UNLOCK_STAYS_FALLBACK).equal('It stays unlocked on this device for a few hours, as this machine is set.');
  });

  it('should name the command at the machine in the one loosening sentence', () => {
    should(widenAtMachineSentence('fy daemon security set idleExpiryDays 60')).equal(
      'Loosening this can only be done at the machine: run fy daemon security set idleExpiryDays 60.',
    );
  });

  it('should say nothing when no device is unpaired, and count them otherwise', () => {
    should(devicesExpiringSentence(0)).be.null();
    should(devicesExpiringSentence(1)).equal('This will unpair 1 device that has not been used within the new period.');
    should(devicesExpiringSentence(3)).equal(
      'This will unpair 3 devices that have not been used within the new period.',
    );
  });

  it('should have copy for every setting and a unit for every number', () => {
    should(SECURITY_SETTING_COPY.unlockOnOpen.unit).be.null();
    should(SECURITY_SETTING_COPY.stepUpOnActions.unit).be.null();
    should(DAMAGED_SETTINGS_SENTENCE).containEql('strictest');
  });
});

describe('a typed number', () => {
  it('should accept the bounds themselves and refuse one past them', () => {
    should(parseSettingDraft('stepUpWindowMinutes', '0')).equal(0);
    should(parseSettingDraft('stepUpWindowMinutes', '60')).equal(60);
    should(parseSettingDraft('stepUpWindowMinutes', '61')).be.null();
    should(parseSettingDraft('deviceKeyRotationDays', '6')).be.null();
    should(parseSettingDraft('deviceKeyRotationDays', '7')).equal(7);
  });

  it('should refuse an empty, fractional or non-numeric draft with the range', () => {
    for (const draft of ['', '  ', '1.5', 'abc'])
      should(boundsSentence('idleExpiryDays', draft)).equal('Enter a whole number from 1 to 90.');
    should(boundsSentence('idleExpiryDays', '45')).be.null();
  });
});

describe('the sentence for a failed change', () => {
  const command = 'fy daemon security set <field> <value>';

  it('should name the command for a remote widen', () => {
    const refusal = new FyHttpError('refused', 403, SECURITY_WIDEN_REFUSED_CODE);
    should(securityFailureSentence(refusal, command)).equal(widenAtMachineSentence(command));
  });

  it('should say a dismissed passkey prompt changed nothing', () => {
    const refusal = new FyHttpError('refused', 403, STEP_UP_REQUIRED_CODE);
    should(securityFailureSentence(refusal, command)).containEql('Nothing was changed');
  });

  it('should say the machine cannot read its settings on a 503, and not accept a value on a 400', () => {
    should(securityFailureSentence(new FyHttpError('x', 503, 'security_unavailable'), command)).containEql(
      'could not read its security settings',
    );
    should(securityFailureSentence(new FyHttpError('x', 400, undefined), command)).containEql('does not accept');
  });

  it('should fall back to one sentence and never print a code or an error name', () => {
    for (const reason of [new FyHttpError('x', 500, 'weird_code'), new Error('boom'), 'raw', undefined]) {
      const sentence = securityFailureSentence(reason, command);
      should(sentence).equal('The setting was not changed. Try again.');
    }
  });
});
