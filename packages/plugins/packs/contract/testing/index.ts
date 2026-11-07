/** @ferretry/plugin-packs/contract/testing — the contract's fake and conformance suite (§7.8). */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { PacksApi } from '../port.ts';
import { DEFAULT_PACK_CONFIG, DEFAULT_ROUTING_FILE, type PackNewOutcome } from '../wire.ts';

const ROUTING = { text: 'Use the strongest model for plans and a fast one for chores.', source: 'default' as const };
const CLEAN_UP = { available: false, runtimes: [] as readonly string[], reason: 'no runtime is ready' };

/** In-memory `PacksApi`: Pack mode is on with today's defaults, no model is usable, a start is refused `no_candidate`. */
export function fakePacks(): PacksApi {
  const switches = new Map<string, boolean>();
  return {
    view: async () => ({ config: DEFAULT_PACK_CONFIG, routing: ROUTING, models: [], available: [], cleanUp: CLEAN_UP }),
    recommend: async input => ({
      ...(input.task === undefined ? {} : { task: input.task }),
      routing: ROUTING,
      available: [],
    }),
    newHelper: async (): Promise<PackNewOutcome> => ({
      outcome: 'refused',
      refusal: { code: 'no_candidate', message: 'No model a runtime here offers can run now.' },
      attempts: [],
    }),
    routingLine: async () => `Routing: ${ROUTING.text}`,
    instructed: async ferret => switches.get(ferret) ?? true,
    result: async () => undefined,
    table: async () => undefined,
    setSwitch: async () => undefined,
  };
}

export function packsConformance(name: string, make: () => PacksApi): void {
  describe(`PacksApi conformance: ${name}`, () => {
    test('with nothing written, Pack mode is on and its settings are the defaults', async () => {
      const view = await make().view();
      expect(view.config).toEqual(DEFAULT_PACK_CONFIG);
      expect(DEFAULT_ROUTING_FILE).toEqual({});
    });
    test('a recommendation echoes the task and carries the routing prompt in effect', async () => {
      const recommendation = await make().recommend({ task: 'sweep the tests' });
      expect(recommendation.task).toBe('sweep the tests');
      expect(recommendation.routing.text.length).toBeGreaterThan(0);
    });
    test('a refused start is an answer with a closed code, never a throw', async () => {
      const outcome = await make().newHelper({ task: 'x', auto: true }, { agent: true });
      if (outcome.outcome === 'refused') expect(outcome.refusal.code.length).toBeGreaterThan(0);
    });
    test('a ferret nobody switched is told about Pack mode', async () => {
      expect(await make().instructed('f1' as FerretId)).toBe(true);
    });
  });
}

packsConformance('fakePacks', fakePacks);
