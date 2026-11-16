/** The rule client over a machine's client: Accounts' owner suggestion list, read by path with the caller's schema. */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { DaemonResponseError } from '../../../app/lib/agenda-call.ts';
import { ruleClientOf } from '../../../app/lib/rule-client.ts';

const Ids = z.object({ suggestions: z.array(z.object({ id: z.string() })) });

describe('the rule client', () => {
  it('reads the path as a GET on the machine’s client and parses the answer with the caller’s schema', async () => {
    const asked: string[] = [];
    const client = ruleClientOf({
      call: async (route: string) => {
        asked.push(route);
        return { suggestions: [{ id: 'srg_0000000000000001', other: 'ignored' }] };
      },
    } as never);
    const read = await client.request('/v1/sign-in-rules/suggestions', Ids);
    expect(asked).toEqual(['GET /v1/sign-in-rules/suggestions']);
    expect(read.suggestions.map(each => each.id)).toEqual(['srg_0000000000000001']);
  });

  it('refuses an answer that does not fit the schema', async () => {
    const client = ruleClientOf({ call: async () => ({ suggestions: 'none' }) } as never);
    await expect(client.request('/v1/sign-in-rules/suggestions', Ids)).rejects.toThrow();
  });

  it('says a refusal the daemon gave as the half’s own', async () => {
    const client = ruleClientOf({
      call: async () => {
        throw Object.assign(new Error('forbidden'), { status: 403, code: 'forbidden' });
      },
    } as never);
    const failure = await client.request('/v1/sign-in-rules/suggestions', Ids).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonResponseError);
    expect((failure as DaemonResponseError).status).toBe(403);
  });
});
