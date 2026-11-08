import { describe, expect, test } from 'bun:test';
import {
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
  PUSH_URL_MAX,
  PushEnvelopeSchema,
  readPushEnvelope,
} from '../../../src/worker/push-envelope.ts';

const good = { title: 'Deploy approval', body: 'Ship the build?', url: '/ferrets/f1/chat?ask=A3' };

describe('the push envelope (strict: url, title, body only, each capped)', () => {
  test('accepts exactly the three fields', () => {
    expect(PushEnvelopeSchema.parse(good)).toEqual(good);
    expect(PushEnvelopeSchema.safeParse({ ...good, body: '' }).success).toBe(true);
  });

  test('refuses any other field, a missing one, a wrong type and an over-long one', () => {
    for (const bad of [
      { ...good, tag: 'x' },
      { ...good, token: 'secret' },
      { title: good.title, body: good.body },
      { ...good, url: 7 },
      { ...good, title: '' },
      { ...good, url: '' },
      { ...good, title: 'x'.repeat(PUSH_TITLE_MAX + 1) },
      { ...good, body: 'x'.repeat(PUSH_BODY_MAX + 1) },
      { ...good, url: `/${'x'.repeat(PUSH_URL_MAX)}` },
    ]) {
      expect(PushEnvelopeSchema.safeParse(bad).success).toBe(false);
    }
  });

  test('reads the envelope out of a real payload by name and ignores the plugin’s own fields', () => {
    expect(readPushEnvelope({ version: 1, eventKey: 'e', tag: 't', count: 1, urgency: 'high', ...good })).toEqual(good);
  });

  test('is total: anything that carries no envelope is null', () => {
    for (const junk of [null, undefined, 'text', 3, [], [good], {}, { title: 'x' }, { ...good, url: null }]) {
      expect(readPushEnvelope(junk)).toBeNull();
    }
  });
});
