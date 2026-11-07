/** @ferretry/plugin-lessons/contract/testing — the contract's fake and conformance suite (§7.8). */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { LessonsApi } from '../port.ts';

/**
 * In-memory `LessonsApi`: a ferret takes the machine default until it is switched, a lesson is filed once and its
 * strength grows when the same rule is filed again.
 */
export function fakeLessons(options: { readonly passiveDefault?: boolean } = {}): LessonsApi {
  const passiveDefault = options.passiveDefault ?? true;
  const filed = new Map<string, { id: string; count: number }>();
  return {
    passive: async (_ferret: FerretId) => passiveDefault,
    suggest: async (_ferret, rule, scope) => {
      const key = `${scope}:${rule.trim().toLowerCase()}`;
      const existing = filed.get(key);
      if (existing !== undefined) {
        existing.count += 1;
        return {
          summary: 'merged into a lesson already on the board',
          proposalId: existing.id,
          count: existing.count,
          outcome: 'merged',
        };
      }
      const created = { id: `lesson-${filed.size + 1}`, count: 1 };
      filed.set(key, created);
      return { summary: 'filed for the owner to review', proposalId: created.id, count: 1, outcome: 'filed' };
    },
  };
}

export function lessonsConformance(name: string, make: () => LessonsApi): void {
  describe(`LessonsApi conformance: ${name}`, () => {
    test('a ferret with no switch of its own answers one way, and the same way each time', async () => {
      const api = make();
      const ferret = 'f1' as FerretId;
      expect(await api.passive(ferret)).toBe(await api.passive(ferret));
    });
    test('a new rule is filed with strength 1', async () => {
      const api = make();
      const result = await api.suggest('f1' as FerretId, 'Run the gate before pushing.', 'repo');
      expect(result.outcome).toBe('filed');
      expect(result.count).toBe(1);
      expect(result.proposalId).toBeDefined();
    });
    test('the same rule filed again merges into the first and grows its strength', async () => {
      const api = make();
      const first = await api.suggest('f1' as FerretId, 'Prefer bun.', 'global');
      const again = await api.suggest('f2' as FerretId, 'Prefer bun.', 'global');
      expect(again.outcome).toBe('merged');
      expect(again.proposalId).toBe(first.proposalId);
      expect(again.count).toBe(2);
    });
  });
}
