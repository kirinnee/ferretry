/**
 * Saving a derived runtime: it is written whole, and the model it launches with is the pin first, then the catalog
 * default, then the starter. A derived runtime whose model cannot be found is still written whole, on its own profile.
 */
import { describe, expect, it } from 'bun:test';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { pinKey } from '../../../daemon/lib/account/derived-runtimes.ts';
import { type DerivedAtSave, ownedFileBodies, realisedEdits } from '../../../daemon/lib/account/runtimes-edits.ts';
import {
  assembleRuntimesModel,
  NO_COMPONENTS,
  type RuntimesFiles,
} from '../../../daemon/lib/account/runtimes-model.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

const files = (overrides: Partial<RuntimesFiles> = {}): RuntimesFiles => ({
  runtimes: new Map([['claude-default', { login: 'claude-you', profile: 'default' } as RuntimeFile]]),
  profiles: new Map([['default', { contents: [] } as unknown as ProfileFile]]),
  modelSets: new Map(),
  settings: undefined,
  logins: [sampleLogin('claude-you', { store: 'ferretry' })],
  templates: new Map(),
  components: NO_COMPONENTS,
  ...overrides,
});

describe('which model a derived runtime is pinned to', () => {
  const pins = new Map([[pinKey('claude-you', 'claude'), 'claude-pinned']]);

  it('is the pin when one was recorded, else the starter, for a login the machine holds or not', () => {
    const pinned = assembleRuntimesModel(files({ pins, starters: { claude: 'claude-starter' } })).derived;
    const unpinned = assembleRuntimesModel(files({ starters: { claude: 'claude-starter' } })).derived;

    expect(pinned.pinnedModelOf('claude-you', 'claude')).toBe('claude-pinned');
    expect(unpinned.pinnedModelOf('claude-you', 'claude')).toBe('claude-starter');
    expect(unpinned.pinnedModelOf('gone-login', 'claude')).toBe('claude-starter');
    expect(unpinned.pinnedModelOf('gone-login', 'codex')).toBeUndefined();
  });
});

describe('saving a derived runtime whose model is not known', () => {
  const before = assembleRuntimesModel(files()).model;
  const next = assembleRuntimesModel(
    files({
      runtimes: new Map([
        ['claude-default', { login: 'claude-you', profile: 'default', compactAt: 'auto' } as RuntimeFile],
      ]),
    }),
  ).model;
  const derived = (refusedFor: DerivedAtSave['refusedFor']): DerivedAtSave => ({
    runtimes: new Set(['claude-default']),
    profiles: new Set(['default']),
    pinnedModelOf: () => undefined,
    refusedFor,
  });

  it('writes the runtime whole on the profile it names, and refuses nothing', () => {
    const { edits, refused } = realisedEdits(
      before,
      next,
      derived(() => undefined),
      REAL_KITS,
    );

    expect(refused).toEqual([]);
    expect(edits).toEqual([
      { path: 'runtimes/claude-default.yaml', patch: ownedFileBodies(next).get('runtimes/claude-default.yaml') },
    ]);
  });

  it('says why a refused derived runtime cannot be saved on a generated profile', () => {
    const { refused } = realisedEdits(
      before,
      next,
      derived(() => 'its model is gone'),
      REAL_KITS,
    );

    expect(refused).toEqual(['claude-default: its model is gone']);
  });
});
