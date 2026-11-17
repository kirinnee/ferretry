import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import { PERSON_ORIGIN, type FerretRecord } from '../../../../contract/index.ts';
import {
  FakeHarness,
  FakeRunner,
  emptyChildEnvironment,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { effectiveMode, FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { switchesOfRecord } from '../../../../daemon/lib/agent-control/launch-environment.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * A ferret converted from v4 carries NO `ferret.json.mode`: v4's mode survives as
 * `details.options.mode`. The registry already reads that for the summary (the Agents filter); the LAUNCH must read the
 * same fact, or the first relaunch of an owner's interactive session hands the harness no mode. The question tool
 * is withheld from every ferret whatever its mode (each plugin's own tests pin that); a
 * core test cannot import a plugin's daemon half (the context-imports gate), so this pins what the harness is HANDED:
 * `LaunchSpec.mode` (what both read) and the pane's `FY_SESSION_MODE`.
 */

function launching(options: { readonly record?: 'auto' | 'interactive'; readonly detail?: 'auto' | 'interactive' }) {
  const id = ferretId('wren');
  const record: FerretRecord = {
    format: 1,
    id,
    name: 'wren',
    role: 'lead',
    ...(options.record === undefined ? {} : { mode: options.record }),
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work',
    state: 'stopped',
    createdAt: T0,
    stateAt: T0,
  };
  const registry = new FerretRegistry([record]);
  // The real converter's representation: no record.mode, the start options hold it.
  if (options.detail !== undefined) registry.putDetails(id, { options: { mode: options.detail } });
  const harness = new FakeHarness();
  const handed: Readonly<Record<string, string>>[] = [];
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => id,
    newName: () => 'wren',
    save: async () => {},
    saveTokens: async () => {},
    harness: () => harness,
    harnessKeys: () => ['claude-code'],
    runner: () => new FakeRunner(),
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: {
      childEnvironment: async (_ferret, environment) => {
        handed.push(environment);
        return ok(emptyChildEnvironment());
      },
    },
    asks: { open: async () => [] },
  };
  const service = new FerretsService(registry, new FerretTokenDirectory(), ports);
  return { id, registry, harness, handed, service };
}

const INTERACTIVE = { launchMode: 'interactive', paneMode: 'interactive' } as const;

describe('a converted v4 interactive ferret (no record.mode, details.options.mode) keeps its question tool', () => {
  test('RESUME: the harness is handed interactive and the pane FY_SESSION_MODE=interactive', async () => {
    const f = launching({ detail: 'interactive' });
    expect(f.registry.summary(f.id)?.mode).toBe('interactive');
    expect((await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN })).ok).toBe(true);
    const spec = f.harness.launched[0]!;
    expect({ launchMode: spec.mode, paneMode: f.handed[0]?.FY_SESSION_MODE }).toEqual(INTERACTIVE);
    expect(f.harness.prepared[0]?.mode).toBe('interactive');
  });

  test('RESTART (a relaunch that replaces the live pane): the same, on the second launch', async () => {
    const f = launching({ detail: 'interactive' });
    expect((await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN })).ok).toBe(true);
    expect((await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN, replaceLiveTerminal: true })).ok).toBe(
      true,
    );
    expect(f.harness.launched).toHaveLength(2);
    const spec = f.harness.launched[1]!;
    expect({ launchMode: spec.mode, paneMode: f.handed[1]?.FY_SESSION_MODE }).toEqual(INTERACTIVE);
  });

  test('the derived launch switch reads the same fact, so a launch never makes the ferret read as changed', () => {
    const f = launching({ detail: 'interactive' });
    const record = f.registry.get(f.id)!;
    expect(switchesOfRecord(record, f.registry.detailsOf(f.id))).toEqual({ FY_SESSION_MODE: 'interactive' });
  });
});

describe('the mode is resolved once: the record wins, a genuine auto stays auto, no fact at all is unattended', () => {
  test('an explicit record.mode wins over a persisted start option', async () => {
    const f = launching({ record: 'auto', detail: 'interactive' });
    expect((await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN })).ok).toBe(true);
    expect(f.harness.launched[0]?.mode).toBe('auto');
    expect(f.handed[0]?.FY_SESSION_MODE).toBe('auto');
  });

  test('a converted ferret whose persisted mode is auto stays auto', async () => {
    const f = launching({ detail: 'auto' });
    expect((await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN })).ok).toBe(true);
    expect(f.harness.launched[0]?.mode).toBe('auto');
    expect(f.handed[0]?.FY_SESSION_MODE).toBe('auto');
  });

  test('a record with neither field hands the harness no mode and the pane no variable', async () => {
    const f = launching({});
    expect((await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN })).ok).toBe(true);
    expect(f.harness.launched[0]).not.toHaveProperty('mode');
    expect(f.handed[0]).not.toHaveProperty('FY_SESSION_MODE');
  });

  test('effectiveMode is the one rule', () => {
    const record = { mode: 'auto' } as FerretRecord;
    const bare = {} as FerretRecord;
    expect(effectiveMode(record, { options: { mode: 'interactive' } })).toBe('auto');
    expect(effectiveMode(bare, { options: { mode: 'interactive' } })).toBe('interactive');
    expect(effectiveMode(bare, { options: {} })).toBeUndefined();
    expect(effectiveMode(bare)).toBeUndefined();
  });
});
