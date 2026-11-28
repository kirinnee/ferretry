/**
 * What a harness adds to a runtime beyond the common launch is asked of the harness's own plugin's kit: Runtimes names no
 * Codex variable or file, and a Codex runtime whose plugin gives no extras is refused with the sentence for it.
 */
import { describe, expect, it } from 'bun:test';
import type { KitExtrasInput, RuntimesHarnessKit } from '../../../contract/index.ts';
import { missingKitRefusal } from '../../../daemon/lib/account/adapt.ts';
import { runtimeExtras } from '../../../daemon/lib/account/runtime-extras.ts';
import { unsupportedHarnessSentence } from '../../../daemon/lib/harness-kind.ts';
import type { RuntimeModels } from '../../../daemon/lib/models/runtime.ts';

const derived: RuntimeModels = {
  catalog: { id: 'acme', label: 'Acme', origin: 'file', customIds: false, docs: '' },
  models: [{ id: 'a', label: 'A', efforts: ['low'], available: true }],
  default: 'a',
  env: {},
};
const input = { sqliteHome: '/fy/sqlite', statePath: '/fy/homes/a/.fy', derived, settings: { model: 'a' } };

describe('runtimeExtras', () => {
  it('should add nothing for Claude: its kit says so, and no kit is guessed at', () => {
    expect(runtimeExtras('claude', input)).toEqual({ env: {} });
    expect(runtimeExtras('claude', input, { runtimeExtras: () => ({ env: {} }) })).toEqual({ env: {} });
  });

  it('should hand Codex’s kit the runtime’s state, models and settings, and return what it says', () => {
    const seen: KitExtrasInput[] = [];
    const kit: RuntimesHarnessKit = {
      runtimeExtras: given => {
        seen.push(given);
        return { env: { CODEX_SQLITE_HOME: given.sqliteHome } };
      },
    };

    expect(runtimeExtras('codex', input, kit)).toEqual({ env: { CODEX_SQLITE_HOME: '/fy/sqlite' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sqliteHome).toBe('/fy/sqlite');
    expect(seen[0]?.statePath).toBe('/fy/homes/a/.fy');
    expect(seen[0]?.models.catalog?.id).toBe('acme');
    expect(seen[0]?.models.entries).toEqual(derived.models);
    expect(seen[0]?.models.default).toBe('a');
    expect(seen[0]?.settings).toEqual({ model: 'a' });
  });

  it('should leave the catalog out of what it hands over when the login has none', () => {
    const seen: KitExtrasInput[] = [];
    runtimeExtras(
      'codex',
      { ...input, derived: { models: [], default: undefined, env: {} } },
      {
        runtimeExtras: given => {
          seen.push(given);
          return { env: {} };
        },
      },
    );

    expect('catalog' in (seen[0]?.models ?? {})).toBe(false);
  });

  it('should guess nothing for a Codex runtime whose plugin gives no extras; the caller refuses it with the typed refusal', () => {
    for (const kit of [undefined, {}]) {
      expect(runtimeExtras('codex', input, kit)).toEqual({ env: {} });
      expect(missingKitRefusal('codex', kit)).toEqual({
        kind: 'harness-unsupported',
        message: unsupportedHarnessSentence('codex'),
      });
    }
    expect(
      missingKitRefusal('codex', {
        runtimeExtras: () => ({ env: {} }),
        fixedLayer: () => ({ ok: true, layer: { entries: [], args: [], supersededFlags: {} } }),
      }),
    ).toBeUndefined();
  });
});
