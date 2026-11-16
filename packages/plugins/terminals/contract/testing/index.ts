/** `@ferretry/plugin-terminals/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import {
  type LivenessSample,
  type PaneBrowser,
  type PaneBrowsers,
  type PaneBrowserStill,
  TERMINAL_MAX_GLOBAL,
  TerminalHoldersViewSchema,
  type TerminalsApi,
  type TerminalView,
  TerminalViewSchema,
} from '../index.ts';

/**
 * What the fake's panes show: a liveness sample and the browsers under each ferret's pane, by ferret, and how a browser
 * re-proves (`still`; absent: still exactly when its ferret's `browsers` lists that pid with that start and no tool
 * command runs, `tool-running` while one does, otherwise `not-proved`).
 */
export interface FakePanes {
  readonly samples?: Readonly<Record<string, LivenessSample>>;
  readonly browsers?: Readonly<Record<string, PaneBrowsers>>;
  readonly still?: (ferret: FerretId, browser: PaneBrowser) => PaneBrowserStill | Promise<PaneBrowserStill>;
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
    paneBrowserStill: async (ferret: FerretId, browser: PaneBrowser) => {
      if (panes.still !== undefined) return await panes.still(ferret, browser);
      const read = panes.browsers?.[ferret];
      if (read?.kind !== 'observed') return { still: false, why: 'not-proved' };
      if (read.toolCommandRunning) return { still: false, why: 'tool-running' };
      const same = read.browsers.some(listed => listed.pid === browser.pid && listed.start === browser.start);
      return same ? { still: true } : { still: false, why: 'not-proved' };
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
    test('a liveness sample carries only the sample fields, never a transcript of its own', async () => {
      const sample = await make().liveness(ferret);
      const fields = ['paneHash', 'pane', 'subprocessAlive', 'subprocessKey', 'leftoverBrowser'];
      expect(Object.keys(sample).every(key => fields.includes(key))).toBe(true);
    });
    test('the browsers under a pane are a pid and its start only, never argv, env or a path', async () => {
      const read = await make().paneBrowsers(ferret);
      if (read.kind === 'unobservable') {
        expect(read.reason.length).toBeGreaterThan(0);
        return;
      }
      for (const browser of read.browsers) {
        expect(Object.keys(browser).sort()).toEqual(['pid', 'start']);
        expect(Number.isSafeInteger(browser.pid) && browser.pid > 1).toBe(true);
        expect(Number.isSafeInteger(browser.start)).toBe(true);
      }
    });
    test('a browser re-proved with another start, or a pid of 1 or below, is never still', async () => {
      const api = make();
      const read = await api.paneBrowsers(ferret);
      const listed = read.kind === 'observed' ? read.browsers : [];
      for (const browser of listed) {
        expect((await api.paneBrowserStill(ferret, { pid: browser.pid, start: browser.start + 1 })).still).toBe(false);
      }
      for (const pid of [1, 0, -1, Number.NaN]) {
        expect((await api.paneBrowserStill(ferret, { pid, start: 1 })).still).toBe(false);
      }
    });
  });
}
