/** @ferretry/plugin-agenda/contract/testing — the contract's fake and conformance suite (§7.8). */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { AgendaApi } from '../port.ts';

/** In-memory `AgendaApi`: mode switches (default on), buzz once per key, an empty roll-up. */
export function fakeAgenda(options: { readonly agendaOf?: Readonly<Record<string, number>> } = {}): AgendaApi {
  const modes = new Map<string, boolean>();
  const buzzed = new Set<string>();
  const agent = { ...(options.agendaOf ?? {}) };
  const modeOf = (ferret: FerretId) => ({
    enabled: modes.get(ferret) ?? true,
    restartRequired: false,
    note: 'a running ferret takes the change at its next launch',
  });
  return {
    open: async () => ({ ferrets: [] }),
    daemonAgenda: async () => ({ asks: [], resolved: [] }),
    mode: async ferret => modeOf(ferret),
    setMode: async (ferret, enabled) => {
      modes.set(ferret, enabled);
      return modeOf(ferret);
    },
    clearAgents: async ({ dryRun }) => {
      const cleared = Object.values(agent).reduce((sum, count) => sum + count, 0);
      const ferrets = Object.values(agent).filter(count => count > 0).length;
      if (!dryRun) for (const key of Object.keys(agent)) agent[key] = 0;
      return { cleared, ferrets };
    },
    buzz: async key => {
      if (buzzed.has(key)) return false;
      buzzed.add(key);
      return true;
    },
  };
}

export function agendaConformance(name: string, make: () => AgendaApi): void {
  describe(`AgendaApi conformance: ${name}`, () => {
    test('agenda mode is on for a new ferret and a switch is read back', async () => {
      const api = make();
      const ferret = 'f1' as FerretId;
      expect((await api.mode(ferret)).enabled).toBe(true);
      expect((await api.setMode(ferret, false)).enabled).toBe(false);
      expect((await api.mode(ferret)).enabled).toBe(false);
    });
    test('a moment buzzes once per key', async () => {
      const api = make();
      const message = { title: 'f1 is stopped', body: '1 needs you' };
      expect(await api.buzz('stop:f1', 'stopped', message)).toBe(true);
      expect(await api.buzz('stop:f1', 'stopped', message)).toBe(false);
    });
    test('a dry run counts what a clear would dismiss and changes nothing', async () => {
      const api = make();
      const dry = await api.clearAgents({ dryRun: true });
      expect(await api.clearAgents({ dryRun: true })).toEqual(dry);
    });
  });
}
