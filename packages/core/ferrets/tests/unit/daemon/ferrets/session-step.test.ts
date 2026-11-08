import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import type { FerretRecord } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretSessionPort, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * The ferret's private session files and spawn stamp are settled BEFORE the harness is asked for anything: the folder is
 * private first, a start records who caused it, a resume brings that forward. Fixture values only.
 */

function fixture(session: FerretSessionPort, records: readonly FerretRecord[] = [], log: string[] = []) {
  const registry = new FerretRegistry(records);
  const tokens = new FerretTokenDirectory();
  const harness = new (class extends FakeHarness {
    override async prepareHome(spec: Parameters<FakeHarness['prepareHome']>[0]) {
      log.push('prepareHome');
      return await super.prepareHome(spec);
    }
  })();
  const runner = new (class extends FakeRunner {
    override async start(spec: Parameters<FakeRunner['start']>[0]) {
      log.push('runner.start');
      return await super.start(spec);
    }
  })();
  let next = 0;
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => {
      next += 1;
      return ferretId(`f${next}`);
    },
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: () => harness,
    harnessKeys: () => [harness.key],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
    session,
  };
  return { log, registry, service: new FerretsService(registry, tokens, ports) };
}

const recorder = (log: string[], failing?: 'prepare' | 'stamp' | 'carry'): FerretSessionPort => ({
  prepare: async ferret => {
    log.push(`prepare ${ferret}`);
    if (failing === 'prepare') throw new Error('FIXTURE_SECRET could not be made private');
  },
  stamp: async request => {
    log.push(`stamp ${request.id}${request.parent === undefined ? '' : ` parent=${request.parent}`}`);
    if (failing === 'stamp') throw new Error('FIXTURE_SECRET stamp failed');
  },
  carry: async ferret => {
    log.push(`carry ${ferret}`);
    if (failing === 'carry') throw new Error('FIXTURE_SECRET carry failed');
  },
});

const stopped = (id: string): FerretRecord => ({
  format: 1,
  id: ferretId(id),
  name: id,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work',
  state: 'stopped',
  createdAt: T0,
  stateAt: T0,
});

describe('a launch settles the ferret’s session folder and spawn stamp first', () => {
  test('a start makes the folder private, then stamps, then asks the harness', async () => {
    const log: string[] = [];
    const f = fixture(recorder(log), [], log);
    const started = await f.service.start({ folder: '/work', by: 'owner' });
    expect(started.ok).toBe(true);
    expect(log).toEqual(['prepare f1', 'stamp f1', 'prepareHome', 'runner.start']);
  });

  test('a resume makes the folder private and carries the stamp, and stamps nothing new', async () => {
    const log: string[] = [];
    const f = fixture(recorder(log), [stopped('old')], log);
    const resumed = await f.service.resume(ferretId('old'));
    expect(resumed.ok).toBe(true);
    expect(log.slice(0, 2)).toEqual(['prepare old', 'carry old']);
    expect(log.some(line => line.startsWith('stamp'))).toBe(false);
  });

  test('a start whose folder cannot be made private launches nothing and quotes nothing of the failure', async () => {
    const log: string[] = [];
    const f = fixture(recorder(log, 'prepare'), [], log);
    const started = await f.service.start({ folder: '/work', by: 'owner' });
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error.reason).toContain('could not be made private');
      expect(started.error.reason).not.toContain('FIXTURE_SECRET');
    }
    expect(log).toEqual(['prepare f1']);
    expect(f.registry.get(ferretId('f1'))?.state).toBe('stopped');
  });

  test('a start whose stamp cannot be recorded is refused before anything is launched', async () => {
    const log: string[] = [];
    const f = fixture(recorder(log, 'stamp'), [], log);
    const started = await f.service.start({ folder: '/work', by: 'owner' });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.reason).not.toContain('FIXTURE_SECRET');
    expect(log).toEqual(['prepare f1', 'stamp f1']);
  });

  test('a resume whose stamp cannot be carried still resumes: the stamp on disk is left exactly as it was', async () => {
    const log: string[] = [];
    const f = fixture(recorder(log, 'carry'), [stopped('old')], log);
    const resumed = await f.service.resume(ferretId('old'));
    expect(resumed.ok).toBe(true);
    expect(log).toContain('runner.start');
  });
});
