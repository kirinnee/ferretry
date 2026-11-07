/** `@ferretry/plugin-terminals/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import {
  type LivenessSample,
  type PaneBrowsers,
  TERMINAL_MAX_GLOBAL,
  TerminalHoldersViewSchema,
  type TerminalsApi,
  type TerminalView,
  TerminalViewSchema,
} from '../index.ts';

/** What the fake's panes show: a liveness sample and the browsers under each ferret's pane, by ferret. */
export interface FakePanes {
  readonly samples?: Readonly<Record<string, LivenessSample>>;
  readonly browsers?: Readonly<Record<string, PaneBrowsers>>;
}

/** An in-memory `TerminalsApi` over a fixed set of terminals, and the panes `panes` describes (none: blind, empty). */
export function fakeTerminals(terminals: readonly TerminalView[] = [], panes: FakePanes = {}): TerminalsApi {
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
    liveness: async (ferret: FerretId) => ({ ...(panes.samples?.[ferret] ?? {}) }),
    paneBrowsers: async (ferret: FerretId) =>
      panes.browsers?.[ferret] ?? { kind: 'observed', toolCommandRunning: false, browsers: [] },
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
    test('a liveness sample carries only the sample fields, never a transcript of its own', async () => {
      const sample = await make().liveness(ferret);
      const fields = ['paneHash', 'pane', 'subprocessAlive', 'subprocessKey', 'leftoverBrowser'];
      expect(Object.keys(sample).every(key => fields.includes(key))).toBe(true);
    });
    test('the browsers under a pane are pids only, and none counts while a tool command runs', async () => {
      const read = await make().paneBrowsers(ferret);
      if (read.kind === 'unobservable') {
        expect(read.reason.length).toBeGreaterThan(0);
        return;
      }
      for (const browser of read.browsers) {
        expect(Object.keys(browser)).toEqual(['pid']);
        expect(Number.isSafeInteger(browser.pid) && browser.pid > 1).toBe(true);
      }
    });
  });
}
