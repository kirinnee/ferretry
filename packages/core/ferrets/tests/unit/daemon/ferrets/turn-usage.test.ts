import { describe, expect, test } from 'bun:test';
import type { FerretId, FerretRecord, Harness, TurnUsage } from '../../../../contract/index.ts';
import { T0 } from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

const record: FerretRecord = {
  format: 1,
  id: 'f1' as FerretId,
  name: 'fern',
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work/project',
  state: 'working',
  createdAt: T0,
  stateAt: T0,
};
const turn: TurnUsage = { turn: 1, at: T0, model: 'm', inputTokens: 10, outputTokens: 5 };

/** The service with only the seams `turnUsage` reads: the registry and the harness a ferret's record names. */
const service = (harness: (key: string) => Pick<Harness, 'usage'> | undefined) =>
  new FerretsService(new FerretRegistry([record]), new FerretTokenDirectory(), {
    ready: async () => undefined,
    harness,
  } as unknown as FerretsPorts);

describe('M4 FerretsApi.turnUsage: what a ferret spent, read through ITS harness', () => {
  test("answers the turns of the harness the ferret's record names, passing `since`", async () => {
    const asked: unknown[] = [];
    const answer = await service(key => ({
      usage: {
        turns: async (ferret, since) => {
          asked.push([key, ferret, since]);
          return [turn];
        },
      },
    })).turnUsage(record.id, T0);
    expect(answer).toEqual([turn]);
    expect(asked).toEqual([['claude-code', 'f1', T0]]);
  });

  test('answers an empty list as empty (a ferret that spent nothing), not as unknown', async () => {
    expect(await service(() => ({ usage: { turns: async () => [] } })).turnUsage(record.id)).toEqual([]);
  });

  test('answers undefined (PARTIAL, never zero) for an unknown ferret, a harness that is off and a reader that throws', async () => {
    expect(
      await service(() => ({ usage: { turns: async () => [turn] } })).turnUsage('nobody' as FerretId),
    ).toBeUndefined();
    expect(await service(() => undefined).turnUsage(record.id)).toBeUndefined();
    expect(
      await service(() => ({
        usage: {
          turns: async () => {
            throw new Error('transcript unreadable /home/owner/secret');
          },
        },
      })).turnUsage(record.id),
    ).toBeUndefined();
  });
});
