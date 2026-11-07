/** @ferretry/plugin-warden/contract/testing — the contract's fake and conformance suite (§7.8). */
import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import type { FerretId } from '../core.ts';
import type { WardenApi } from '../port.ts';
import { DEFAULT_WARDEN_CONFIG, effectiveWardenConfig, type WardenBlessingView, type WardenFile } from '../wire.ts';

const AT = '2026-11-07T09:00:00.000Z' as Instant;

/** In-memory `WardenApi`: settings merge over the default, a sweep with nothing wrong finds nothing, a leave is a blessing. */
export function fakeWarden(): WardenApi {
  let file: WardenFile = {};
  const blessings = new Map<string, WardenBlessingView>();
  return {
    flags: async () => [],
    config: async () => effectiveWardenConfig(file),
    configure: async patch => {
      file = { ...file, ...patch };
      return effectiveWardenConfig(file);
    },
    sweep: async () => ({ sweptAt: AT, flags: [] }),
    investigate: async request => ({ state: 'queued', message: `looking at ${request.ferret}` }),
    leave: async request => {
      const blessing: WardenBlessingView = {
        ferret: request.ferret,
        kinds: [],
        expiresAt: AT,
        by: 'owner',
        ...(request.duration === 'until_change' ? { untilChange: true as const } : {}),
      };
      blessings.set(request.ferret, blessing);
      return blessing;
    },
    blessed: async ferret => blessings.get(ferret),
  };
}

export function wardenConformance(name: string, make: () => WardenApi): void {
  describe(`WardenApi conformance: ${name}`, () => {
    test('with no file the settings are the default: on, and free (both triage layers off)', async () => {
      const config = await make().config();
      expect(config).toEqual(DEFAULT_WARDEN_CONFIG);
      expect(config.layers).toEqual({ jev: false, llm: false });
      expect(config.mayActAlone.stop).toBe(false);
    });
    test('a settings patch changes the keys it names and keeps the rest', async () => {
      const api = make();
      const after = await api.configure({ caps: { jevUsdPerDay: 1 } });
      expect(after.caps).toEqual({ ...DEFAULT_WARDEN_CONFIG.caps, jevUsdPerDay: 1 });
      expect(after.intervalMinutes).toBe(2);
    });
    test('leaving a ferret alone is remembered', async () => {
      const api = make();
      const ferret = 'f1' as FerretId;
      expect(await api.blessed(ferret)).toBeUndefined();
      await api.leave({ ferret, duration: '1h' });
      expect((await api.blessed(ferret))?.by).toBe('owner');
    });
  });
}
