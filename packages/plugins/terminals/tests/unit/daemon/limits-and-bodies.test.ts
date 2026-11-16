import { describe, expect, it } from 'bun:test';
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { isShellForeground } from '../../../daemon/lib/agent-tools/policy.ts';
import { parseBody, parseOptionalBody } from '../../../daemon/lib/api/body.ts';
import { GIBIBYTE, resolveLimits } from '../../../daemon/lib/protocol/limits.ts';
import { lonePasteOf } from '../../../daemon/lib/tmux/composer.ts';
import { paneShowsOpenPicker } from '../../../daemon/lib/tmux/picker-screen.ts';

const requestOf = (text: () => Promise<string> | string): ApiRequest =>
  ({ text: async () => await text() }) as unknown as ApiRequest;
const Shape = z.strictObject({ name: z.string().min(1) });
const refusal = async (run: () => Promise<unknown>): Promise<ApiError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('the body of a terminal route', () => {
  it('parses a body against its schema, and an optional body that is empty as the no-fields case', async () => {
    expect(
      await parseBody(
        requestOf(() => '{"name":"dev"}'),
        Shape,
      ),
    ).toEqual({ name: 'dev' });
    expect(
      await parseOptionalBody(
        requestOf(() => '  \n'),
        z.object({ a: z.string().optional() }),
      ),
    ).toEqual({});
    expect(
      await parseOptionalBody(
        requestOf(() => '{"a":"x"}'),
        z.object({ a: z.string().optional() }),
      ),
    ).toEqual({
      a: 'x',
    });
  });

  it('refuses a body that is too large with 413, in the reader’s own words', async () => {
    const tooBig = () => {
      const error = new Error('the request body is larger than 10 bytes');
      error.name = 'BodyTooLargeError';
      throw error;
    };
    const refused = await refusal(async () => await parseBody(requestOf(tooBig), Shape, 10));
    expect([refused.status, refused.code, refused.message]).toEqual([
      413,
      'body_too_large',
      'the request body is larger than 10 bytes',
    ]);
  });

  it('refuses a body that cannot be read with 400', async () => {
    const refused = await refusal(
      async () =>
        await parseBody(
          requestOf(() => {
            throw new Error('socket reset');
          }),
          Shape,
        ),
    );
    expect([refused.status, refused.code]).toEqual([400, 'unreadable_body']);
    const odd = await refusal(
      async () =>
        await parseBody(
          requestOf(() => {
            throw 'not an error';
          }),
          Shape,
        ),
    );
    expect(odd.code).toBe('unreadable_body');
  });

  it('refuses text that is not JSON with 400, and a body that does not fit, without echoing it', async () => {
    const broken = await refusal(
      async () =>
        await parseBody(
          requestOf(() => '{nope'),
          Shape,
        ),
    );
    expect([broken.status, broken.code]).toEqual([400, 'invalid_json']);
    const unfit = await refusal(
      async () =>
        await parseBody(
          requestOf(() => '{"name":""}'),
          Shape,
        ),
    );
    expect([unfit.status, unfit.code]).toEqual([400, 'invalid_request']);
    expect(unfit.message).toStartWith('the request body is invalid — name: ');
    const whole = await refusal(
      async () =>
        await parseBody(
          requestOf(() => '5'),
          Shape,
        ),
    );
    expect(whole.message).toStartWith('the request body is invalid — body: ');
    const badOptional = await refusal(
      async () =>
        await parseOptionalBody(
          requestOf(() => '{nope'),
          Shape,
        ),
    );
    expect(badOptional.code).toBe('invalid_json');
  });
});

describe('what the agent tools call a shell', () => {
  it('knows the shells a terminal opens with, with or without a login dash', () => {
    expect(isShellForeground('bash')).toBe(true);
    expect(isShellForeground('-zsh')).toBe(true);
    expect(isShellForeground('node')).toBe(false);
  });
});

describe('limits written as a byte count or a percent of the budget', () => {
  const host = { memoryCeilingBytes: 64 * GIBIBYTE };

  it('takes a number as bytes and a percent as that share of the budget', () => {
    const limits = resolveLimits(
      {
        fleet: { memoryMax: 2 * GIBIBYTE, memoryHigh: '1%', swapMax: '50%' },
        perFerret: { memoryMax: '10%', memoryHigh: 1 * GIBIBYTE, tasksMax: 'infinity' },
      },
      host,
    );
    expect(limits.fleet.memoryMax).toBe(2 * GIBIBYTE);
    expect(limits.fleet.memoryHigh).toBe(Math.floor(0.01 * 64 * GIBIBYTE));
    expect(limits.fleet.swapMax).toBe(32 * GIBIBYTE);
    expect(limits.perFerret.memoryMax).toBe(Math.floor(6.4 * GIBIBYTE));
    expect(limits.perFerret.memoryHigh).toBe(1 * GIBIBYTE);
    expect(limits.perFerret.tasksMax).toBeNull();
    expect(limits.warnings).toEqual([]);
  });

  it('warns and uses the hard limit when a soft one written as a percent is above it', () => {
    const limits = resolveLimits({ fleet: { memoryMax: '10%', memoryHigh: '50%' } }, host);
    expect(limits.fleet.memoryHigh).toBe(limits.fleet.memoryMax as number);
    expect(limits.warnings).toHaveLength(1);
  });
});

describe('a composer that shows only a pasted-text placeholder', () => {
  it('is this payload’s when its character count agrees, counted in code units or in characters', () => {
    expect(lonePasteOf('[Pasted text #1 5 chars]', 'hello')).toBe(true);
    expect(lonePasteOf('[Pasted text #1 4 chars]', '😀abc')).toBe(true);
    expect(lonePasteOf('[Pasted text #1 7 chars]', 'hello')).toBe(false);
  });

  it('is never claimed with no count at all, or one beside other text', () => {
    expect(lonePasteOf('[Pasted text #1]', 'hello')).toBe(false);
    expect(lonePasteOf('[Pasted text #1 5 chars] more', 'hello')).toBe(false);
  });
});

describe('a Codex picker whose rows carry more than one annotation', () => {
  it('strips each trailing (current) or (default) from the row name and still shows a picker open', () => {
    const pane = ['  Select Model', '  1. gpt-5.1  fast model (current) (default)', '  2. gpt-5.2'].join('\n');
    expect(paneShowsOpenPicker(pane)).toBe(true);
    const doubled = ['  Select Reasoning Level for gpt-5.1', '  1. High (current) (default)'].join('\n');
    expect(paneShowsOpenPicker(doubled)).toBe(true);
  });
});
