import { describe, it } from 'bun:test';
import type { TurnUsage } from '@ferretry/core-ferrets/contract';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import { type MeteredFerret, SpendMeter } from '../../../daemon/lib/budget/meter.ts';

const turn = (n: number, at: string, output: number, model = 'claude-opus-5-5'): TurnUsage => ({
  turn: n,
  at: instantFromEpochMs(Date.parse(at)),
  model,
  inputTokens: 10,
  outputTokens: output,
});

/** One micro-dollar per output token; a model called `unpriced` has no price. */
const price = (usage: { pricingModel?: string | null; outputTokens?: number | null }): number | undefined =>
  usage.pricingModel === 'unpriced' ? undefined : (usage.outputTokens ?? 0);

/** Ferrets and their turns, as a harness would report them; `null` turns means its reader cannot be asked. */
class World {
  ferrets: MeteredFerret[] = [];
  turns = new Map<string, readonly TurnUsage[] | null>();
  asked: string[] = [];
  meter = new SpendMeter({
    ferrets: async () => this.ferrets,
    turns: async (ferret, sinceIso) => {
      this.asked.push(`${ferret}@${sinceIso}`);
      const answer = this.turns.get(ferret);
      return answer === null || answer === undefined ? undefined : answer;
    },
    pricing: async () => usage => price(usage),
  });
}

const WEEK = Date.parse('2026-10-26T00:00:00Z');
const DAY = { start: Date.parse('2026-10-30T00:00:00Z'), end: Date.parse('2026-10-31T00:00:00Z') };
const LOGINS = new Set(['liftoff']);

describe('SpendMeter', () => {
  it('should book each turn to the day it was made, across a ferret that crossed midnight', async () => {
    const world = new World();
    world.ferrets = [{ id: 'f1', login: 'liftoff' }];
    world.turns.set('f1', [turn(1, '2026-10-29T23:50:00Z', 100), turn(2, '2026-10-30T00:10:00Z', 30)]);

    should(world.meter.measured).be.false();
    await world.meter.refresh(WEEK, LOGINS);

    should(world.meter.measured).be.true();
    should(world.meter.spent(LOGINS, DAY.start, DAY.end)).eql({ usdMicros: 30, unpriced: 0, partial: false });
    should(world.meter.spent(LOGINS, WEEK, DAY.end)).eql({ usdMicros: 130, unpriced: 0, partial: false });
  });

  it('should read only from the latest turn seen on the next refresh, and replace a turn reported again', async () => {
    const world = new World();
    world.ferrets = [{ id: 'f1', login: 'liftoff' }];
    world.turns.set('f1', [turn(1, '2026-10-30T01:00:00Z', 3)]);
    await world.meter.refresh(WEEK, LOGINS);

    // The unfinished turn comes back larger, and a new one follows.
    world.turns.set('f1', [turn(1, '2026-10-30T01:00:00Z', 9), turn(2, '2026-10-30T02:00:00Z', 5)]);
    await world.meter.refresh(WEEK, LOGINS);

    should(world.asked).eql(['f1@2026-10-26T00:00:00.000Z', 'f1@2026-10-30T01:00:00.000Z']);
    should(world.meter.spent(LOGINS, DAY.start, DAY.end).usdMicros).equal(14);
  });

  it('should count a turn on a model with no price as unpriced, never as nothing spent', async () => {
    const world = new World();
    world.ferrets = [{ id: 'f1', login: 'liftoff' }];
    world.turns.set('f1', [turn(1, '2026-10-30T01:00:00Z', 7), turn(2, '2026-10-30T01:05:00Z', 50, 'unpriced')]);
    await world.meter.refresh(WEEK, LOGINS);

    should(world.meter.spent(LOGINS, DAY.start, DAY.end)).eql({ usdMicros: 7, unpriced: 1, partial: false });
  });

  it('should read a ferret whose harness cannot be asked as PARTIAL, and keep what it booked before', async () => {
    const world = new World();
    world.ferrets = [{ id: 'f1', login: 'liftoff' }];
    world.turns.set('f1', [turn(1, '2026-10-30T01:00:00Z', 20)]);
    await world.meter.refresh(WEEK, LOGINS);

    world.turns.set('f1', null);
    await world.meter.refresh(WEEK, LOGINS);

    should(world.meter.spent(LOGINS, DAY.start, DAY.end)).eql({ usdMicros: 20, unpriced: 0, partial: true });
  });

  it('should never read an unreadable ferret as a free one: nothing booked is still partial', async () => {
    const world = new World();
    world.ferrets = [{ id: 'f1', login: 'liftoff' }];
    world.turns.set('f1', null);
    await world.meter.refresh(WEEK, LOGINS);

    should(world.meter.spent(LOGINS, DAY.start, DAY.end)).eql({ usdMicros: 0, unpriced: 0, partial: true });
  });

  it('should count only the ferrets on the logins asked about, and none that name no login', async () => {
    const world = new World();
    world.ferrets = [
      { id: 'f1', login: 'liftoff' },
      { id: 'f2', login: 'home' },
      { id: 'f3', login: null },
    ];
    for (const id of ['f1', 'f2', 'f3']) world.turns.set(id, [turn(1, '2026-10-30T01:00:00Z', 10)]);
    await world.meter.refresh(WEEK, LOGINS);

    should(world.asked).eql(['f1@2026-10-26T00:00:00.000Z']);
    should(world.meter.spent(LOGINS, DAY.start, DAY.end).usdMicros).equal(10);
    should(world.meter.spent(new Set(['home']), DAY.start, DAY.end).usdMicros).equal(0);
  });

  it('should drop what came before the period when it moves on, and start over when it moves back', async () => {
    const world = new World();
    world.ferrets = [{ id: 'f1', login: 'liftoff' }];
    world.turns.set('f1', [turn(1, '2026-10-27T01:00:00Z', 11), turn(2, '2026-10-30T01:00:00Z', 4)]);
    await world.meter.refresh(WEEK, LOGINS);
    should(world.meter.spent(LOGINS, WEEK, DAY.end).usdMicros).equal(15);

    await world.meter.refresh(DAY.start, LOGINS);
    should(world.meter.spent(LOGINS, WEEK, DAY.end).usdMicros).equal(4);
  });
});
