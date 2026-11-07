/** `@ferretry/plugin-terminals/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import {
  TERMINAL_MAX_GLOBAL,
  TerminalHoldersViewSchema,
  type TerminalsApi,
  type TerminalView,
  TerminalViewSchema,
} from '../index.ts';

/** An in-memory `TerminalsApi` over a fixed set of terminals. */
export function fakeTerminals(terminals: readonly TerminalView[] = []): TerminalsApi {
  const all = terminals.map(terminal => TerminalViewSchema.parse(terminal));
  return {
    of: async (ferret: FerretId) => all.filter(terminal => terminal.sessionId === ferret),
    holders: async () => {
      const counts = new Map<string, number>();
      for (const terminal of all) counts.set(terminal.sessionId, (counts.get(terminal.sessionId) ?? 0) + 1);
      return TerminalHoldersViewSchema.parse({
        limit: TERMINAL_MAX_GLOBAL,
        open: all.length,
        holders: [...counts].map(([sessionId, count]) => ({
          sessionId,
          label: sessionId,
          standing: 'live',
          status: 'working',
          count,
        })),
      });
    },
  };
}

/** What every `TerminalsApi` keeps. */
export function terminalsConformance(name: string, make: () => TerminalsApi, ferret: FerretId): void {
  describe(`TerminalsApi conformance: ${name}`, () => {
    test("a ferret's terminals are its own and parse as the wire view", async () => {
      for (const terminal of await make().of(ferret)) {
        expect(terminal.sessionId).toBe(ferret);
        expect(TerminalViewSchema.safeParse(terminal).success).toBe(true);
      }
    });
    test('the holders add up to what is open, within the limit', async () => {
      const holders = await make().holders();
      expect(holders.holders.reduce((sum, holder) => sum + holder.count, 0)).toBe(holders.open);
      expect(holders.open).toBeLessThanOrEqual(holders.limit);
    });
  });
}
