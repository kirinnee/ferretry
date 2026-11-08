import { describe, expect, test } from 'bun:test';
import { PUSH_BODY_MAX, PUSH_TITLE_MAX, PUSH_URL_MAX, PushEnvelopeSchema } from '@ferretry/app';
import { z } from 'zod';
import { PushEnvelopeFields, PushNotificationPayloadSchema } from '../../../contract/index.ts';

const fields = z.strictObject(PushEnvelopeFields);
const good = { title: 'Deploy approval', body: 'Ship the build?', url: '/ferrets/f1/chat?ask=A3' };

describe('the push envelope the shell worker reads and the payload Access sends', () => {
  test('accept and refuse the same values, at every cap', () => {
    for (const candidate of [
      good,
      { ...good, body: '' },
      { ...good, title: '' },
      { ...good, url: '' },
      { ...good, title: 'x'.repeat(PUSH_TITLE_MAX) },
      { ...good, title: 'x'.repeat(PUSH_TITLE_MAX + 1) },
      { ...good, body: 'x'.repeat(PUSH_BODY_MAX) },
      { ...good, body: 'x'.repeat(PUSH_BODY_MAX + 1) },
      { ...good, url: `/${'x'.repeat(PUSH_URL_MAX - 1)}` },
      { ...good, url: `/${'x'.repeat(PUSH_URL_MAX)}` },
      { ...good, url: 7 },
    ]) {
      expect(fields.safeParse(candidate).success).toBe(PushEnvelopeSchema.safeParse(candidate).success);
    }
  });

  test('a payload over a cap is refused where it is composed, not shown unreadable on the phone', () => {
    const payload = { version: 1, eventKey: 'e', tag: 't', count: 1, ...good };
    expect(PushNotificationPayloadSchema.safeParse(payload).success).toBe(true);
    expect(PushNotificationPayloadSchema.safeParse({ ...payload, title: 'x'.repeat(PUSH_TITLE_MAX + 1) }).success).toBe(
      false,
    );
    expect(PushNotificationPayloadSchema.safeParse({ ...payload, body: 'x'.repeat(PUSH_BODY_MAX + 1) }).success).toBe(
      false,
    );
  });
});
