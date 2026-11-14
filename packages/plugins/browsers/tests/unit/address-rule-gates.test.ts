import { describe, expect, test } from 'bun:test';
import { ApiError, type Redaction } from '@ferretry/kernel/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import { HIDDEN_FRAGMENT, mapStrings, withAddressRule, withAddressRuleTools } from '../../daemon/address-rule.ts';
import { guarded, maskedRefusal, WITHHELD_REFUSAL } from '../../daemon/pages/routes.ts';
import { BrowserSessionError } from '../../daemon/pages/service.ts';

/** FAKE material only. */
const FAKE_URL = 'https://example.test/#v1;a=127.0.0.1:9;c=FAKEFAKE;fp=00';
const open: Redaction = {
  read: async fn => await fn({ text: text => text, cells: grid => grid, lines: lines => lines }),
};
const failing: Redaction = {
  read: async () => {
    throw new Error('vault unavailable');
  },
};

describe('one gate over every owner refusal (the routes and the socket accept)', () => {
  test('a refusal keeps its status and code and loses the fragment from its message and extras', async () => {
    const refused = await maskedRefusal(
      withAddressRule(open),
      new ApiError(503, `worker failed at ${FAKE_URL}`, 'launch_failed', undefined, { at: [FAKE_URL] }),
    );
    expect(refused).toBeInstanceOf(ApiError);
    const error = refused as ApiError;
    expect([error.status, error.code]).toEqual([503, 'launch_failed']);
    expect(error.message).toBe(`worker failed at https://example.test/${HIDDEN_FRAGMENT}`);
    expect(JSON.stringify(error.extra)).not.toContain('FAKEFAKE');
  });

  test('FAILS CLOSED: a seam that cannot be read withholds the message whole, status and code kept', async () => {
    const refused = (await maskedRefusal(
      failing,
      new ApiError(502, `down at ${FAKE_URL}`, 'upstream_failed'),
    )) as ApiError;
    expect(refused.message).toBe(WITHHELD_REFUSAL);
    expect([refused.status, refused.code]).toEqual([502, 'upstream_failed']);
  });

  test('a handler that throws a session refusal leaves translated and masked; an unknown error passes untouched', async () => {
    const handler = guarded(withAddressRule(open), async () => {
      throw new BrowserSessionError('launch_failed', `worker failed at ${FAKE_URL}`);
    });
    const thrown = (await handler({}).catch((error: unknown) => error)) as ApiError;
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown.status).toBe(503);
    expect(thrown.message).not.toContain('FAKEFAKE');

    const defect = new TypeError('boom');
    expect(await guarded(open, async () => await Promise.reject(defect))({}).catch((error: unknown) => error)).toBe(
      defect,
    );
  });
});

describe('one gate over every tool result and error', () => {
  const handlers: Record<'browser_read' | 'browser_picture' | 'browser_fail', ToolHandler> = {
    browser_read: async () => ({
      text: `now at ${FAKE_URL}`,
      data: { surfaces: [{ url: FAKE_URL, title: 'Pair #v1;code= FAKEFAKE;fp=00' }], matched: true },
    }),
    browser_picture: async () => ({
      text: 'shot',
      data: { picture: { mime: 'image/png', base64: 'iVBORw0KGgo=' } },
    }),
    browser_fail: async () => {
      throw new ApiError(400, `bad ${FAKE_URL}`, 'bad_request');
    },
  };
  const gated = withAddressRuleTools(handlers);

  test('the whole result, structured data included, passes the rule', async () => {
    const result = await gated.browser_read({} as never, {});
    expect(JSON.stringify(result)).not.toContain('FAKEFAKE');
    expect(JSON.stringify(result)).not.toContain('fp=00');
    expect(result.text).toBe(`now at https://example.test/${HIDDEN_FRAGMENT}`);
  });

  test('a picture’s bytes pass unchanged', async () => {
    const result = await gated.browser_picture({} as never, {});
    expect(result.data).toEqual({ picture: { mime: 'image/png', base64: 'iVBORw0KGgo=' } });
  });

  test('a refusal’s message passes the rule and keeps its status and code', async () => {
    const thrown = (await gated.browser_fail({} as never, {}).catch((error: unknown) => error)) as ApiError;
    expect([thrown.status, thrown.code]).toEqual([400, 'bad_request']);
    expect(thrown.message).toBe(`bad https://example.test/${HIDDEN_FRAGMENT}`);
  });
});

describe('mapStrings', () => {
  test('masks every string at any depth, passes scalars, withholds what it cannot walk or is too deep', () => {
    const upper = (text: string): string => text.toUpperCase();
    expect(mapStrings({ a: 'x', b: [1, null, undefined, true, { c: 'y' }] }, upper)).toEqual({
      a: 'X',
      b: [1, null, undefined, true, { c: 'Y' }],
    });
    const walked: unknown = mapStrings({ f: () => 'x' }, upper);
    expect(walked).toEqual({ f: '[withheld]' });
    let deep: unknown = 'leaf';
    for (let level = 0; level < 40; level++) deep = [deep];
    expect(JSON.stringify(mapStrings(deep, upper))).toContain('[withheld]');
  });
});
