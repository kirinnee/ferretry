import { describe, expect, test } from 'bun:test';
import {
  isPushServiceHost,
  PUSH_CLEAR_MAX_TAGS,
  PUSH_COUNT_MAX,
  PUSH_SERVICE_ALLOWS_SILENT,
  PUSH_SERVICE_HOST_SUFFIXES,
  PUSH_SERVICE_HOSTS,
  PUSH_TAG_PATTERN,
  PushClearSchema,
  PushKindSchema,
  PushShowSchema,
  pushServiceAllowsSilent,
  readPushMessage,
} from '../../../contract/push-envelope.ts';

const three = { title: 'Deploy approval', body: 'Ship the build?', url: '/ferrets/f1/chat?ask=A3' };
/** A real Access show: the envelope, the worker's optional fields, and the plugin's own (`version`, `eventKey`, `sessionId`). */
const access = {
  version: 1,
  eventKey: 'session-1:agenda:7',
  ...three,
  tag: 'attention-session-1:A3',
  count: 1,
  sessionId: 'session-1',
  kind: 'agenda',
  urgency: 'high',
};
const clear = { version: 1, kind: 'clear', eventKey: 'clear:session-1:A3:1', sessionId: 'session-1', tags: ['a'] };
const tags = (count: number): string[] => Array.from({ length: count }, (_, index) => `attention-s:${index}`);

describe('readPushMessage: a show', () => {
  test('a three-field push (an older daemon) reads as a show with no tag, kind, count or urgency', () => {
    expect(readPushMessage(three)).toEqual({ type: 'show', show: three });
  });

  test('a real Access payload reads as a show; the plugin fields are not in the result', () => {
    const message = readPushMessage(access);
    expect(message).toEqual({
      type: 'show',
      show: { ...three, tag: 'attention-session-1:A3', kind: 'agenda', count: 1, urgency: 'high' },
    });
    const show = message?.type === 'show' ? message.show : {};
    for (const field of ['version', 'eventKey', 'sessionId']) expect(Object.keys(show)).not.toContain(field);
  });

  test('a key on the prototype, or an own key holding undefined, is not picked', () => {
    const inherited = Object.assign(Object.create({ tag: 'from-prototype', kind: 'agenda' }), three);
    expect(readPushMessage(inherited)).toEqual({ type: 'show', show: three });
    expect(readPushMessage({ ...three, tag: undefined })).toEqual({ type: 'show', show: three });
  });

  test('tag boundaries: 1 and 128 characters read; 0 and 129 make the message unreadable', () => {
    expect(readPushMessage({ ...three, tag: 'x' })?.type).toBe('show');
    expect(readPushMessage({ ...three, tag: 'x'.repeat(128) })?.type).toBe('show');
    expect(readPushMessage({ ...three, tag: '' })).toBeNull();
    expect(readPushMessage({ ...three, tag: 'x'.repeat(129) })).toBeNull();
  });

  test('tag charset: letters, digits and . _ : - read; a space, / # non-ASCII or a control character is unreadable', () => {
    expect(readPushMessage({ ...three, tag: 'aZ09._:-' })?.type).toBe('show');
    for (const tag of ['two words', 'a/b', 'a#b', 'café', 'a\u0000b', 'a\nb', 'a​b', 'a\tb', 42])
      expect(readPushMessage({ ...three, tag })).toBeNull();
    expect(PUSH_TAG_PATTERN.test('pa-3fa85f64')).toBe(true);
  });

  test('kind: today’s Access kinds read; Clear, a leading dash and 41 characters are unreadable', () => {
    for (const kind of ['agenda', 'question', 'failed', 'completed', 'device-paired', 'attention'])
      expect(readPushMessage({ ...three, kind })).toEqual({ type: 'show', show: { ...three, kind } });
    expect(readPushMessage({ ...three, kind: `a${'b'.repeat(39)}` })?.type).toBe('show');
    for (const kind of ['Clear', '-x', `a${'b'.repeat(40)}`, '', '1abc', 'a_b'])
      expect(readPushMessage({ ...three, kind })).toBeNull();
  });

  test('a show can never carry kind clear: the schema refuses it, and the reader takes it as a clear', () => {
    expect(PushKindSchema.safeParse('clear').success).toBe(false);
    expect(PushShowSchema.safeParse({ ...three, kind: 'clear' }).success).toBe(false);
    // read as a clear, which has no tags here, so it is unreadable rather than shown
    expect(readPushMessage({ ...three, kind: 'clear' })).toBeNull();
  });

  test('the bounds are the declared numbers: count 999, clear tags 32', () => {
    expect(PUSH_COUNT_MAX).toBe(999);
    expect(PUSH_CLEAR_MAX_TAGS).toBe(32);
    expect(readPushMessage({ ...three, count: 1_000 })).toBeNull();
    expect(readPushMessage({ ...clear, tags: tags(33) })).toBeNull();
  });

  test('the show and clear schemas are strict on their own, not only through the reader’s pick', () => {
    expect(PushShowSchema.safeParse({ ...three, token: 'secret' }).success).toBe(false);
    expect(PushClearSchema.safeParse({ kind: 'clear', tags: ['a'], title: 'words' }).success).toBe(false);
  });

  test('count is an integer 1..999 and urgency is high or absent', () => {
    expect(readPushMessage({ ...three, count: 1 })?.type).toBe('show');
    expect(readPushMessage({ ...three, count: PUSH_COUNT_MAX })?.type).toBe('show');
    for (const count of [0, PUSH_COUNT_MAX + 1, 1.5, -1, '2']) expect(readPushMessage({ ...three, count })).toBeNull();
    expect(readPushMessage({ ...three, urgency: 'high' })?.type).toBe('show');
    for (const urgency of ['normal', 'low', 'HIGH', true]) expect(readPushMessage({ ...three, urgency })).toBeNull();
  });

  test('the three fields keep their caps and stay required', () => {
    expect(readPushMessage({ ...three, title: '' })).toBeNull();
    expect(readPushMessage({ body: '', url: '/' })).toBeNull();
    expect(readPushMessage({ ...three, url: 'x'.repeat(1_025) })).toBeNull();
  });
});

describe('readPushMessage: a clear', () => {
  test('1 and 32 tags read; 0 and 33 are unreadable', () => {
    expect(readPushMessage({ ...clear, tags: tags(1) })).toEqual({
      type: 'clear',
      clear: { kind: 'clear', tags: tags(1) },
    });
    expect(readPushMessage({ ...clear, tags: tags(PUSH_CLEAR_MAX_TAGS) })?.type).toBe('clear');
    expect(readPushMessage({ ...clear, tags: [] })).toBeNull();
    expect(readPushMessage({ ...clear, tags: tags(PUSH_CLEAR_MAX_TAGS + 1) })).toBeNull();
  });

  test('one bad tag refuses the whole clear', () => {
    expect(readPushMessage({ ...clear, tags: ['good', 'two words'] })).toBeNull();
    expect(readPushMessage({ ...clear, tags: ['good', 'x'.repeat(129)] })).toBeNull();
    expect(readPushMessage({ ...clear, tags: 'good' })).toBeNull();
  });

  test('a clear with title, body and url beside it yields a value with NO text field', () => {
    const message = readPushMessage({ ...clear, ...three, kind: 'clear', tag: 'x', count: 2, urgency: 'high' });
    expect(message).toEqual({ type: 'clear', clear: { kind: 'clear', tags: ['a'] } });
    expect(Object.keys(message?.type === 'clear' ? message.clear : {}).sort()).toEqual(['kind', 'tags']);
  });
});

describe('readPushMessage is total', () => {
  test('null, arrays, numbers, strings, {} and undefined read as null', () => {
    for (const json of [null, undefined, [], [three], 0, 42, '', 'push', true, {}, () => three])
      expect(readPushMessage(json)).toBeNull();
    // an array carrying the fields as its own properties is still not a push
    expect(readPushMessage(Object.assign([], three))).toBeNull();
    expect(readPushMessage(Object.assign([], { kind: 'clear', tags: ['a'] }))).toBeNull();
  });

  test('a throwing getter or a throwing proxy never throws', () => {
    const getter = Object.defineProperty({ ...three }, 'tag', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    expect(readPushMessage(getter)).toBeNull();
    const kindGetter = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    expect(readPushMessage(kindGetter)).toBeNull();
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('boom');
        },
        get: () => {
          throw new Error('boom');
        },
      },
    );
    expect(() => readPushMessage(proxy)).not.toThrow();
    expect(readPushMessage(proxy)).toBeNull();
  });
});

describe('the push-service table (owner decision !A324)', () => {
  test('every allowlisted service is classified, and the values are today’s', () => {
    expect(Object.keys(PUSH_SERVICE_ALLOWS_SILENT).sort()).toEqual(
      [...PUSH_SERVICE_HOSTS, ...PUSH_SERVICE_HOST_SUFFIXES].sort(),
    );
    expect(PUSH_SERVICE_ALLOWS_SILENT).toEqual({
      'fcm.googleapis.com': true,
      'updates.push.services.mozilla.com': false,
      '.push.apple.com': false,
      '.notify.windows.com': true,
    });
  });

  test('FCM and WNS may show nothing; Mozilla, Apple, a bare suffix and an unknown host may not', () => {
    expect(pushServiceAllowsSilent('FCM.googleapis.com')).toBe(true);
    expect(pushServiceAllowsSilent('wns2-db5p.notify.windows.com')).toBe(true);
    expect(pushServiceAllowsSilent('updates.push.services.mozilla.com')).toBe(false);
    expect(pushServiceAllowsSilent('web.push.apple.com')).toBe(false);
    expect(pushServiceAllowsSilent('notify.windows.com')).toBe(false);
    expect(pushServiceAllowsSilent('.notify.windows.com')).toBe(false);
    expect(pushServiceAllowsSilent('push.example.test')).toBe(false);
    expect(pushServiceAllowsSilent('')).toBe(false);
  });

  test('isPushServiceHost is exact and lowercased: a listed host or a real subdomain of a suffix', () => {
    expect(isPushServiceHost('FCM.GOOGLEAPIS.COM')).toBe(true);
    expect(isPushServiceHost('web.push.apple.com')).toBe(true);
    expect(isPushServiceHost('push.apple.com')).toBe(false);
    expect(isPushServiceHost('.push.apple.com')).toBe(false);
    expect(isPushServiceHost('fcm.googleapis.com.evil.test')).toBe(false);
    expect(isPushServiceHost('evilpush.apple.com')).toBe(false);
    expect(isPushServiceHost('127.0.0.1')).toBe(false);
  });
});
