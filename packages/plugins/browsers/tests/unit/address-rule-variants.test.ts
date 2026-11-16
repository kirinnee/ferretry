import { describe, expect, test } from 'bun:test';
import type { Log, LogFields } from '@ferretry/kernel/contract';
import { HIDDEN_FRAGMENT, hideCredentialFragments, withAddressRuleKernel } from '../../daemon/address-rule.ts';

/**
 * FAKE material only. Every case asserts the credential (and every SUFFIX of it) is gone, never just that `#v1;` is.
 */
const FAKE = ['FAKEFAKE', 'FAKEB', 'FAKEKEY', 'FAKESHARE'];

function leaks(text: string): readonly string[] {
  return FAKE.filter(code => text.includes(code));
}

describe('whitespace continuations of a credential fragment are hidden to the end of the credential', () => {
  test('a space inside a code value (the reviewer’s reproducer) leaves no suffix behind', () => {
    const hidden = hideCredentialFragments('Pair #v1;url=https%3A%2F%2Fexample.test;code= FAKEFAKE;fp=00');
    expect(hidden).toBe(`Pair ${HIDDEN_FRAGMENT}`);
  });

  test('spaces around separators and between parts are absorbed', () => {
    for (const text of [
      'see #v1; c=FAKEFAKE; fp=00',
      'see #v1;c = FAKEFAKE ;fp=00',
      'see #c= FAKEFAKE',
      'see #code =FAKEFAKE;fp=00',
      'see #a=1 ;share= FAKESHARE ;x=2',
    ]) {
      const hidden = hideCredentialFragments(text);
      expect(leaks(hidden)).toEqual([]);
      expect(hidden).not.toContain('fp=00');
      expect(hidden.startsWith('see ')).toBe(true);
      expect(hidden).toContain(HIDDEN_FRAGMENT);
    }
  });

  test('ordinary text after a hidden fragment survives, and ordinary fragments are never extended', () => {
    expect(hideCredentialFragments(`Pair #v1;c=FAKEFAKE then go home`)).toBe(`Pair ${HIDDEN_FRAGMENT} then go home`);
    expect(hideCredentialFragments('see #section then a=b')).toBe('see #section then a=b');
    expect(hideCredentialFragments('Issue #42 is open')).toBe('Issue #42 is open');
  });
});

describe('encoded, mixed-case and split spellings are classified on a decoded, normalised form', () => {
  const cases: readonly [string, string][] = [
    ['https://example.test/#code%3DFAKEFAKE', 'https://example.test/'],
    ['https://example.test/#v2%3Bc%3DFAKEFAKE', 'https://example.test/'],
    ['https://example.test/#v1%3Bb=FAKEB%3Bk=FAKEKEY', 'https://example.test/'],
    ['https://example.test/#%76%31%3Bc%3DFAKEFAKE', 'https://example.test/'],
    ['https://example.test/%23code%3DFAKEFAKE', 'https://example.test/'],
    ['https://example.test/#V1;b=FAKEB;k=FAKEKEY', 'https://example.test/'],
    ['https://example.test/#V1', 'https://example.test/'],
    ['https://example.test/#Share=FAKESHARE', 'https://example.test/'],
    ['https://example.test/%23V1%3Bc%3DFAKEFAKE', 'https://example.test/'],
    ['https://example.test/#%2576%2531%253Bc%253DFAKEFAKE', 'https://example.test/'],
    ['https://example.test/#v1%3b%20c=FAKEFAKE', 'https://example.test/'],
    ['https://example.test/join#Code%3dFAKEFAKE%26x%3D1', 'https://example.test/join'],
  ];
  for (const [input, keep] of cases)
    test(`${input}`, () => {
      const hidden = hideCredentialFragments(input);
      expect(leaks(hidden)).toEqual([]);
      expect(hidden).toBe(`${keep}${HIDDEN_FRAGMENT}`);
    });

  test('harmless fragments and encodings stay untouched', () => {
    for (const text of [
      'https://example.test/docs#section',
      'https://example.test/docs#sec%20tion',
      'https://example.test/docs%23anchor',
      'https://example.test/#V10',
      'https://example.test/#%76%31%30',
      'https://example.test/#codec%3D1',
    ]) {
      expect(hideCredentialFragments(text)).toBe(text);
    }
  });
});

describe('the log and event ports pass the same rule', () => {
  function recordingKernel() {
    const lines: { level: string; message: string; fields?: LogFields }[] = [];
    const makeLog = (): Log => ({
      debug: (message, fields) => lines.push({ level: 'debug', message, ...(fields === undefined ? {} : { fields }) }),
      info: (message, fields) => lines.push({ level: 'info', message, ...(fields === undefined ? {} : { fields }) }),
      warn: (message, fields) => lines.push({ level: 'warn', message, ...(fields === undefined ? {} : { fields }) }),
      error: (message, fields) => lines.push({ level: 'error', message, ...(fields === undefined ? {} : { fields }) }),
      child: () => makeLog(),
    });
    const events: { name: string; payload: unknown }[] = [];
    const kernel = {
      log: makeLog(),
      events: { publish: (event: { name: string }, payload: unknown) => events.push({ name: event.name, payload }) },
      clock: { marker: 'kept' },
    };
    return { lines, events, kernel };
  }

  test('a log message, its fields and a child scope’s lines never carry the fragment', () => {
    const { lines, kernel } = recordingKernel();
    const seamed = withAddressRuleKernel(kernel as never) as unknown as typeof kernel;
    seamed.log.warn('navigate failed at https://example.test/#v1;c=FAKEFAKE;fp=00', {
      url: 'https://example.test/#code=FAKEFAKE',
      attempts: 2,
      ok: false,
      note: undefined,
    });
    seamed.log.child('page').error('echo #v1;url=x;code= FAKEFAKE;fp=00');
    expect(JSON.stringify(lines)).not.toContain('FAKEFAKE');
    expect(lines[0]).toEqual({
      level: 'warn',
      message: `navigate failed at https://example.test/${HIDDEN_FRAGMENT}`,
      fields: { url: `https://example.test/${HIDDEN_FRAGMENT}`, attempts: 2, ok: false, note: undefined },
    });
  });

  test('an event payload is masked in every string, however deep, and the event itself still goes out', () => {
    const { events, kernel } = recordingKernel();
    const seamed = withAddressRuleKernel(kernel as never) as unknown as typeof kernel;
    seamed.events.publish(
      { name: 'browsers.page-changed' },
      {
        ferret: 'f1',
        page: 'p1#v1;c=FAKEFAKE',
        nested: [{ url: 'https://example.test/#code%3DFAKEFAKE' }],
        change: 'closed',
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('browsers.page-changed');
    expect(JSON.stringify(events)).not.toContain('FAKEFAKE');
    expect(events[0]?.payload).toEqual({
      ferret: 'f1',
      page: `p1${HIDDEN_FRAGMENT}`,
      nested: [{ url: `https://example.test/${HIDDEN_FRAGMENT}` }],
      change: 'closed',
    });
  });

  test('every other kernel port is the kernel’s own', () => {
    const { kernel } = recordingKernel();
    const seamed = withAddressRuleKernel(kernel as never) as unknown as typeof kernel;
    expect(seamed.clock).toBe(kernel.clock);
  });
});
