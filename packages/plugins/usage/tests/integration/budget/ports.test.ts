import { describe, it } from 'bun:test';
import type { FerretId, FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import type { StateDamage, StatePort, StateRead } from '@ferretry/kernel/contract';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import { FerretBudgetSessions, PausesStore, ToldStore } from '../../../daemon/adapters/budget/ports.ts';
import type { Pause } from '../../../contract/index.ts';

const at = (iso: string) => instantFromEpochMs(Date.parse(iso));

const ferret = (overrides: Omit<Partial<FerretSummary>, 'id'> & { readonly id: string }): FerretSummary =>
  ({
    name: 'writer',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/work',
    state: 'working',
    createdAt: at('2026-10-30T08:00:00Z'),
    stateAt: at('2026-10-30T08:00:00Z'),
    ...overrides,
    id: overrides.id as FerretId,
  }) as FerretSummary;

class FakeFerrets implements Pick<FerretsApi, 'list' | 'stop'> {
  stopped: [string, string][] = [];
  constructor(public all: readonly FerretSummary[]) {}
  async list(): Promise<readonly FerretSummary[]> {
    return this.all;
  }
  async stop(id: FerretId, how: 'polite' | 'now'): Promise<void> {
    this.stopped.push([id, how]);
  }
}

describe('FerretBudgetSessions', () => {
  const NOW = Date.parse('2026-10-30T12:00:00Z');
  const fleet = [
    ferret({ id: 'a', login: 'liftoff', name: 'hadi' }),
    ferret({ id: 'b', login: 'liftoff', state: 'stopped', stateAt: at('2026-10-30T10:00:00Z'), name: 'old' }),
    ferret({ id: 'c', login: 'liftoff', state: 'stopped', stateAt: at('2026-10-20T10:00:00Z'), name: 'ancient' }),
    ferret({ id: 'd', login: 'home', state: 'idle', name: 'marin' }),
    ferret({ id: 'e', name: 'nologin' }),
  ];

  it('should meter every ferret running now or changed since the period began, naming the login it started on', async () => {
    const sessions = new FerretBudgetSessions(new FakeFerrets(fleet));

    const actual = await sessions.metered(NOW - 86_400_000);

    should(actual).eql([
      { id: 'a', login: 'liftoff' },
      { id: 'b', login: 'liftoff' },
      { id: 'd', login: 'home' },
      { id: 'e', login: null },
    ]);
  });

  it('should list as live only the running ferrets whose login was asked about', async () => {
    const sessions = new FerretBudgetSessions(new FakeFerrets(fleet));

    const actual = await sessions.live(new Set(['liftoff']));

    should(actual).eql([{ id: 'a', name: 'hadi', agent: 'liftoff' }]);
  });

  it('should find the ferret most recently active on a login, running or not', async () => {
    const sessions = new FerretBudgetSessions(new FakeFerrets(fleet));

    const actual = await sessions.recent(new Set(['liftoff']));

    should(actual).eql({ id: 'b', name: 'old', agent: 'liftoff' });
    should(await sessions.recent(new Set(['nobody']))).be.undefined();
  });

  it('should stop a ferret politely, through Ferrets, so its turn is saved', async () => {
    const ferrets = new FakeFerrets(fleet);

    await new FerretBudgetSessions(ferrets).stop({ id: 'a', name: 'hadi', agent: 'liftoff' });

    should(ferrets.stopped).eql([['a', 'polite']]);
  });
});

/** The state port, over memory: one value per file, and a switch that damages it. */
class MemoryState {
  value: unknown;
  damaged = false;
  async read(): Promise<StateRead<unknown>> {
    if (this.damaged) {
      const damage: StateDamage = { file: 'pauses.json', reason: 'unparsable', sentence: 'the file does not parse' };
      return { ok: false, error: damage };
    }
    return { ok: true, value: this.value };
  }
  async write(_file: unknown, value: unknown): Promise<void> {
    this.value = value;
  }
}

describe('the pause records', () => {
  const HOLD: Pause = {
    period: 'daily',
    level: 'over_hard',
    limitUsd: 60,
    resetsAtMs: Date.parse('2026-10-31T00:00:00Z'),
    timeZone: 'UTC',
  };

  it('should keep the pauses last published and read them back after a restart', async () => {
    const state = new MemoryState();
    const store = new PausesStore(state as unknown as StatePort);

    should(await store.read()).eql({});
    await store.write({ liftoff: HOLD });

    should(await store.read()).eql({ liftoff: HOLD });
  });

  it('should refuse to read a damaged record of pauses as none', async () => {
    const state = new MemoryState();
    state.damaged = true;

    // A damaged file is an error the caller must see; "none paused" would spend past a cap.
    await new PausesStore(state as unknown as StatePort).read().then(
      () => {
        throw new Error('a damaged record was read as none');
      },
      () => undefined,
    );
  });

  it('should keep which hard limits the owner was told about, and fail when that record is damaged', async () => {
    const state = new MemoryState();
    const told = new ToldStore(state as unknown as StatePort);

    should(await told.read()).eql([]);
    await told.write(['liftoff|daily|2026-10-30T00:00:00.000Z']);
    should(await told.read()).eql(['liftoff|daily|2026-10-30T00:00:00.000Z']);

    state.damaged = true;
    await told.read().then(
      () => {
        throw new Error('a damaged record was read as empty');
      },
      () => undefined,
    );
  });
});
