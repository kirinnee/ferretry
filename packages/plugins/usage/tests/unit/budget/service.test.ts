import { describe, it } from 'bun:test';
import { instantFromEpochMs } from '@ferretry/std';
import type { Pause } from '../../../contract/index.ts';
import type { TurnUsage } from '@ferretry/core-ferrets/contract';
import should from 'should';
import { SpendMeter } from '../../../daemon/lib/budget/meter.ts';
import { budgetNoticeRef, budgetNoticeText } from '../../../daemon/lib/budget/notice.ts';
import {
  type BudgetConfig,
  type BudgetNotice,
  BudgetService,
  type BudgetSession,
} from '../../../daemon/lib/budget/service.ts';

/** A ferret's turns, set by the test: each costs `dollars` (one micro-dollar per output token). */
class Ledger {
  readonly turns: TurnUsage[] = [];
  spend(at: string, dollars: number): void {
    this.turns.push({
      turn: this.turns.length + 1,
      at: instantFromEpochMs(Date.parse(at)),
      model: 'claude-opus-5-5',
      inputTokens: 0,
      outputTokens: dollars * 1_000_000,
    });
  }
}

interface World {
  now: number;
  config: BudgetConfig;
  live: BudgetSession[];
  republished: number;
  stopped: string[];
  failing: Set<string>;
  notices: BudgetNotice[];
  told: string[];
  /** A publish that throws, as the provisioner does when it refuses an unrelated runtime. */
  publishFails?: boolean;
  /** The ferrets' turns cannot be read (no reader is bound, or every read fails). */
  unreadable?: boolean;
  /** A told record that can be neither read nor written. */
  toldBroken?: boolean;
  /** Sessions the Warden moves to another login instead of their being stopped. Absent: no mover is wired. */
  movable?: Set<string>;
  relocated?: string[];
}

function serviceOver(
  world: World,
  ledger: Ledger,
  restored: Readonly<Record<string, Pause>> = {},
  remembered: Readonly<Record<string, Pause>>[] = [],
): BudgetService {
  const meter = new SpendMeter({
    ferrets: async () => [{ id: 's1', login: 'liftoff' }],
    turns: async (_ferret, sinceIso) =>
      world.unreadable === true ? undefined : ledger.turns.filter(turn => turn.at >= sinceIso),
    pricing: async () => usage => usage.outputTokens ?? 0,
  });
  const service = new BudgetService({
    config: async () => {
      if (world.config === undefined) throw new Error('the fleet manifest could not be read');
      return world.config;
    },
    hostTimeZone: () => 'UTC',
    meter,
    nowMs: () => world.now,
    republish: async () => {
      if (world.publishFails === true) throw new Error('fleet_change_refused: another runtime is broken');
      world.republished += 1;
    },
    liveSessions: async agents => world.live.filter(session => agents.has(session.agent)),
    recentSession: async () => ({ id: 's0', name: 'old', agent: 'liftoff' }),
    ...(world.movable === undefined
      ? {}
      : {
          relocate: async (session: BudgetSession) => {
            if (!world.movable?.has(session.id)) return false;
            world.relocated?.push(session.id);
            world.live = world.live.filter(entry => entry.id !== session.id);
            return true;
          },
        }),
    stop: async session => {
      if (world.failing.has(session.id)) throw new Error('pane refused to die');
      world.stopped.push(session.id);
      world.live = world.live.filter(entry => entry.id !== session.id);
    },
    alternative: async () => 'home',
    notify: async notice => {
      world.notices.push(notice);
    },
    told: {
      read: async () => {
        if (world.toldBroken === true) throw new Error('EACCES');
        return world.told;
      },
      write: async keys => {
        if (world.toldBroken === true) throw new Error('EACCES');
        world.told = [...keys];
      },
    },
    remember: async holds => {
      remembered.push(holds);
    },
  });
  service.restore(restored);
  return service;
}

const freshWorld = (): World => ({
  now: Date.parse('2026-10-30T12:00:00Z'),
  config: {
    logins: [{ id: 'liftoff', budget: { daily: { trigger: 40, hard: 60 } }, agents: ['liftoff'] }],
  },
  live: [
    { id: 's1', name: 'hadi', agent: 'liftoff' },
    { id: 's2', name: 'marin', agent: 'liftoff' },
    { id: 's3', name: 'other', agent: 'home' },
  ],
  republished: 0,
  stopped: [],
  failing: new Set(),
  notices: [],
  told: [],
});

const RESTORED: Pause = {
  period: 'daily',
  level: 'over_trigger',
  limitUsd: 40,
  resetsAtMs: Date.parse('2026-10-31T00:00:00Z'),
  timeZone: 'UTC',
};

describe('BudgetService, a tick that could not measure', () => {
  it('should keep a restored pause and read the amount as partial when the ferrets cannot be read', async () => {
    const world = { ...freshWorld(), unreadable: true };
    const remembered: Readonly<Record<string, Pause>>[] = [];
    const service = serviceOver(world, new Ledger(), { liftoff: RESTORED }, remembered);

    await service.tick();
    await service.tick();

    should(service.holds()).eql({ liftoff: RESTORED });
    should(service.view('liftoff')).match({ partial: true, measured: true });
    should(remembered.at(-1)).eql({ liftoff: RESTORED });
  });

  it('should lift a restored pause once a tick has measured the login completely and it is under its limits', async () => {
    const world = { ...freshWorld(), unreadable: true };
    const service = serviceOver(world, new Ledger(), { liftoff: RESTORED });
    await service.tick();
    should(service.holds()).eql({ liftoff: RESTORED });

    world.unreadable = false;
    await service.tick();

    should(service.holds()).eql({});
    should(service.view('liftoff')?.partial).equal(undefined);
    // And a later unreadable tick does not bring the old pause back.
    world.unreadable = true;
    await service.tick();
    should(service.holds()).eql({});
  });

  it('should not keep a restored pause past its reset, nor for a login whose budget was removed', async () => {
    const reset = { ...freshWorld(), unreadable: true, now: Date.parse('2026-10-31T00:30:00Z') };
    const afterReset = serviceOver(reset, new Ledger(), {
      liftoff: { ...RESTORED, resetsAtMs: Date.parse('2026-10-31T00:00:00Z') },
    });
    await afterReset.tick();
    should(afterReset.holds()).eql({});

    const removed = { ...freshWorld(), unreadable: true };
    const service = serviceOver(removed, new Ledger(), { liftoff: RESTORED });
    removed.config = { logins: [] };
    await service.tick();
    should(service.holds()).eql({});
  });

  it('should still raise a new hold on a partial amount that already crosses a limit', async () => {
    const world = freshWorld();
    const ledger = new Ledger();
    ledger.spend('2026-10-30T09:00:00Z', 45);
    const service = serviceOver(world, ledger, { liftoff: { ...RESTORED, level: 'over_hard', limitUsd: 60 } });
    await service.tick();
    should(service.holds().liftoff).match({ level: 'over_trigger', limitUsd: 40 });
  });
});

describe('BudgetService', () => {
  it('should publish once at the start, and again only when what it holds moves', async () => {
    const world = freshWorld();
    const ledger = new Ledger();
    const service = serviceOver(world, ledger);
    ledger.spend('2026-10-30T09:00:00Z', 10);
    await service.tick();
    should(world.republished).equal(1);
    should(service.holds()).eql({});
    should(service.view('liftoff')).match({ level: 'ok', measured: true, timeZone: 'UTC', timeZoneSet: false });
    should(service.view('liftoff')?.daily).match({ trigger: 40, hard: 60, spentUsd: 10, level: 'ok' });
    await service.tick();
    should(world.republished).equal(1);

    // Past the trigger: held, published, nothing stopped.
    ledger.spend('2026-10-30T10:00:00Z', 31);
    await service.tick();
    should(world.republished).equal(2);
    should(service.holds().liftoff).match({ period: 'daily', level: 'over_trigger', limitUsd: 40 });
    should(world.stopped).eql([]);
    should(world.notices).eql([]);
    // More spend under the hard limit moves no hold, so nothing is published again.
    ledger.spend('2026-10-30T11:00:00Z', 5);
    await service.tick();
    should(world.republished).equal(2);
  });

  it('should stop every live ferret on the login past its hard limit and tell the owner once', async () => {
    const world = freshWorld();
    const ledger = new Ledger();
    const service = serviceOver(world, ledger);
    ledger.spend('2026-10-30T09:00:00Z', 61);
    await service.tick();
    should(world.stopped).eql(['s1', 's2']);
    should(world.notices).have.length(1);
    should(world.notices[0]).match({
      login: 'liftoff',
      period: 'daily',
      spentUsd: 61,
      hardUsd: 60,
      alternative: 'home',
      anchor: { id: 's1' },
      resetsAtMs: Date.parse('2026-10-31T00:00:00Z'),
    });
    should(world.notices[0]?.stopped.map(session => session.name)).eql(['hadi', 'marin']);
    should(world.told).eql(['liftoff|daily|2026-10-30T00:00:00.000Z']);
    should(service.view('liftoff')?.level).equal('over_hard');

    // A ferret that started anyway is stopped too, and the owner is not told again.
    world.live.push({ id: 's4', name: 'late', agent: 'liftoff' });
    await service.tick();
    should(world.stopped).eql(['s1', 's2', 's4']);
    should(world.notices).have.length(1);
  });

  it('should let the Warden move a ferret past the hard limit instead of stopping it, and say so', async () => {
    const world = { ...freshWorld(), movable: new Set(['s1']), relocated: [] as string[] };
    const ledger = new Ledger();
    ledger.spend('2026-10-30T09:00:00Z', 61);
    await serviceOver(world, ledger).tick();
    should(world.relocated).eql(['s1']);
    should(world.stopped).eql(['s2']);
    should(world.notices[0]?.relocated?.map(session => session.name)).eql(['hadi']);
    should(world.notices[0]?.stopped.map(session => session.name)).eql(['marin']);
  });

  it('should not tell the owner twice across a restart, and tell them again in the next period', async () => {
    const world = freshWorld();
    const ledger = new Ledger();
    ledger.spend('2026-10-30T09:00:00Z', 61);
    await serviceOver(world, ledger).tick();
    should(world.notices).have.length(1);
    // The daemon restarts: a new service, the same told record.
    world.live.push({ id: 's5', name: 'resumed', agent: 'liftoff' });
    await serviceOver(world, ledger).tick();
    should(world.notices).have.length(1);
    should(world.stopped).containEql('s5');
    // The next day starts clean; a new overspend is a new notice.
    world.now = Date.parse('2026-10-31T12:00:00Z');
    const nextDay = serviceOver(world, ledger);
    await nextDay.tick();
    should(nextDay.holds()).eql({});
    ledger.spend('2026-10-31T10:00:00Z', 70);
    await nextDay.tick();
    should(world.notices).have.length(2);
  });

  it('should start from the holds the last daemon published, and keep the ones it publishes', async () => {
    const world = freshWorld();
    const ledger = new Ledger();
    const held: Pause = {
      period: 'daily',
      level: 'over_trigger',
      limitUsd: 40,
      resetsAtMs: Date.parse('2026-10-31T00:00:00Z'),
      timeZone: 'UTC',
    };
    const lapsed: Pause = { ...held, resetsAtMs: Date.parse('2026-10-30T00:00:00Z') };
    const remembered: Readonly<Record<string, Pause>>[] = [];
    const service = serviceOver(world, ledger, { liftoff: held, home: lapsed }, remembered);
    // Before the first count: a publish now still holds the login.
    should(service.holds()).eql({ liftoff: held });
    ledger.spend('2026-10-30T09:00:00Z', 45);
    await service.tick();
    should(service.holds().liftoff).match({ level: 'over_trigger' });
    should(remembered).have.length(1);
    should(Object.keys(remembered[0] ?? {})).eql(['liftoff']);
  });

  it('should stop the ferrets past a hard limit even while the fleet will not publish', async () => {
    // Security regression: the stop used to wait on the publish, so a fleet that refused to publish kept
    // a login's ferrets running past their hard limit for as long as the publish kept failing.
    const world = freshWorld();
    world.publishFails = true;
    const ledger = new Ledger();
    const service = serviceOver(world, ledger);
    ledger.spend('2026-10-30T09:00:00Z', 100);
    await service.tick();
    should(world.republished).equal(0);
    should(world.stopped).eql(['s1', 's2']);
    should(world.notices).have.length(1);
    // The publish is tried again on the next tick, and lands once the fleet will take it.
    world.publishFails = false;
    await service.tick();
    should(world.republished).equal(1);
  });

  it('should keep every hold and publish nothing while the configuration cannot be read', async () => {
    // A manifest read error used to read as "no runtimes": $0 spent, every hold lifted and published.
    const world = freshWorld();
    const ledger = new Ledger();
    const service = serviceOver(world, ledger);
    ledger.spend('2026-10-30T09:00:00Z', 45);
    await service.tick();
    const held = service.holds();
    should(held.liftoff).match({ level: 'over_trigger' });
    const published = world.republished;
    const working = world.config;
    world.config = undefined as unknown as BudgetConfig;
    await service.tick();
    should(service.holds()).eql(held);
    should(world.republished).equal(published);
    world.config = working;
  });

  it('should tell the owner once even when the told record can be neither read nor written', async () => {
    const world = freshWorld();
    world.toldBroken = true;
    const ledger = new Ledger();
    const service = serviceOver(world, ledger);
    ledger.spend('2026-10-30T09:00:00Z', 61);
    await service.tick();
    await service.tick();
    await service.tick();
    should(world.notices).have.length(1);
  });

  it('should name a ferret it could not stop and try it again next tick', async () => {
    const world = freshWorld();
    world.failing.add('s2');
    const ledger = new Ledger();
    const service = serviceOver(world, ledger);
    ledger.spend('2026-10-30T09:00:00Z', 61);
    await service.tick();
    should(world.notices[0]?.failed.map(session => session.id)).eql(['s2']);
    world.failing.clear();
    await service.tick();
    should(world.stopped).eql(['s1', 's2']);
  });

  it("should anchor the notice on the login's last session when nothing was running", async () => {
    const world = freshWorld();
    world.live = [];
    const ledger = new Ledger();
    ledger.spend('2026-10-30T09:00:00Z', 61);
    await serviceOver(world, ledger).tick();
    should(world.notices[0]).match({ anchor: { id: 's0' }, stopped: [] });
  });

  it('should count days in the zone machine.yaml names', async () => {
    const world = freshWorld();
    world.config = { ...world.config, timeZone: 'America/Los_Angeles' };
    const ledger = new Ledger();
    // 05:00 UTC on the 30th is still the 29th in Los Angeles: yesterday there.
    ledger.spend('2026-10-30T05:00:00Z', 45);
    const service = serviceOver(world, ledger);
    await service.tick();
    should(service.view('liftoff')).match({ timeZone: 'America/Los_Angeles', timeZoneSet: true, level: 'ok' });
    should(service.view('liftoff')?.daily?.resetsAt).equal('2026-10-31T07:00:00.000Z');
  });

  it('should hold nothing and read nothing for a machine with no budget', async () => {
    const world = freshWorld();
    world.config = { logins: [] };
    const service = serviceOver(world, new Ledger());
    await service.tick();
    should(service.holds()).eql({});
    should(service.view('liftoff')).be.undefined();
  });
});

describe('budgetNoticeText', () => {
  const notice: BudgetNotice = {
    anchor: { id: 's1', name: 'hadi', agent: 'liftoff' },
    login: 'liftoff',
    period: 'daily',
    spentUsd: 61.234,
    hardUsd: 60,
    resetsAtMs: Date.parse('2026-10-31T07:00:00Z'),
    timeZone: 'America/Los_Angeles',
    stopped: [
      { id: 's1', name: 'hadi', agent: 'liftoff' },
      { id: 's2', name: 'marin', agent: 'liftoff' },
    ],
    failed: [],
    alternative: 'home',
  };

  it('should name the spend on this machine, the ferrets stopped and the way forward', () => {
    const text = budgetNoticeText(notice, 'fy', 'Liftoff EC2');
    should(text.ref).equal(budgetNoticeRef(notice));
    should(text.title).equal('liftoff hit its hard limit');
    should(text.summary).match(/\$61\.23 today on Liftoff EC2, past its \$60\.00 hard limit/u);
    should(text.body).match(/Stopped, with their turns saved: :hadi, :marin\./u);
    should(text.body).match(/such as home\. Ferretry does not move them for you/u);
    should(text.body).match(/resets Sat 00:00 \(America\/Los_Angeles\)/u);
  });

  it('should name the ferrets the Warden moved, and not say that nothing ran', () => {
    const text = budgetNoticeText({ ...notice, stopped: [], relocated: [notice.anchor] }, 'fy', 'box');
    should(text.body).match(/Moved to another login by the Warden: :hadi\./u);
    should(text.body).not.match(/No ferret was running/u);
  });

  it('should say so when nothing ran, and name the ferrets it could not stop', () => {
    const quiet = budgetNoticeText({ ...notice, stopped: [], failed: [] }, 'fy', 'box');
    should(quiet.body).match(/No ferret was running on it\./u);
    should(quiet.body).match(/Start new work on another login, such as home/u);
    const stuck = budgetNoticeText({ ...notice, stopped: [], failed: [notice.anchor] }, 'fy', 'box');
    should(stuck.body).match(/Could not stop yet .*:hadi/u);
  });
});
