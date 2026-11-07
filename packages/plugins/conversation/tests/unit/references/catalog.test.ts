import { describe, expect, it } from 'bun:test';
import { ApiError, type CallContext, queryFrom } from '@ferretry/kernel/contract';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import {
  ReferenceCatalogAnswerSchema,
  type ReferenceCatalogPrefix,
  type ReferenceCatalogProvider,
} from '../../../contract/index.ts';
import { referenceCatalogRoute } from '../../../daemon/references/catalog.ts';

const FERRET = FerretIdSchema.parse('mvuc7tsf-0c3d50df');

const call = (ferretId: string, query: Record<string, string>): CallContext =>
  ({
    request: {
      method: 'GET',
      path: `/v1/ferrets/${ferretId}/references`,
      query: queryFrom(Object.entries(query)),
      headers: new Map(),
      text: async () => '',
    },
    params: new Map([['ferretId', ferretId]]),
  }) as unknown as CallContext;

const answerOf = async (
  providers: Partial<Record<ReferenceCatalogPrefix, ReferenceCatalogProvider | 'unavailable'>>,
  query: Record<string, string>,
) => {
  const response = await referenceCatalogRoute(prefix => providers[prefix])(call(FERRET, query));
  if (response.body === undefined || typeof response.body !== 'string') throw new Error('no JSON body');
  return ReferenceCatalogAnswerSchema.parse(JSON.parse(response.body));
};

describe('reference.catalog route', () => {
  it('answers no entries, never an error, for a prefix nobody provides', async () => {
    expect(await answerOf({}, { prefix: '&' })).toEqual({ ferret: FERRET, prefix: '&', provided: false, entries: [] });
  });

  it('answers no entries for a provider that is off', async () => {
    expect((await answerOf({ '&': 'unavailable' }, { prefix: '&' })).provided).toBe(false);
  });

  it("serves the provider's entries for its prefix and passes the query and the ferret", async () => {
    const seen: unknown[] = [];
    const provider: ReferenceCatalogProvider = {
      entries: async input => {
        seen.push(input);
        return [{ token: 'F12', label: 'Fix the composer', detail: 'Build' }];
      },
    };
    const answer = await answerOf({ '&': provider }, { prefix: '&', q: 'fix' });
    expect(answer).toEqual({
      ferret: FERRET,
      prefix: '&',
      provided: true,
      entries: [{ token: 'F12', label: 'Fix the composer', detail: 'Build' }],
    });
    expect(seen).toEqual([{ ferret: FERRET, query: 'fix' }]);
  });

  it('accepts every prefix of the reference grammar, the skill slash included', async () => {
    for (const prefix of [':', '@', '&', '!', '/', '$', '%terminal', '%browser'])
      expect((await answerOf({}, { prefix })).prefix).toBe(prefix as ReferenceCatalogPrefix);
  });

  it('refuses a prefix outside the grammar', async () => {
    await expect(answerOf({}, { prefix: '#' })).rejects.toBeInstanceOf(ApiError);
  });

  it('is a 502 when the provider throws or answers entries it cannot read', async () => {
    const throws: ReferenceCatalogProvider = {
      entries: async () => {
        throw new Error('board offline');
      },
    };
    const nonsense = { entries: async () => [{ label: 'no token' }] } as unknown as ReferenceCatalogProvider;
    for (const provider of [throws, nonsense]) {
      const refused = await answerOf({ '!': provider }, { prefix: '!' }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ApiError);
      expect((refused as ApiError).status).toBe(502);
    }
  });
});
