import { describe, it } from 'bun:test';
import type { LaunchInstructionSectionId, RestartQueueEntry } from '@ferretry/protocol';
import should from 'should';
import {
  RESTART_RETRY_BASE_MS,
  RESTART_RETRY_CAP_MS,
  RestartBusy,
  RestartService,
  type RestartPorts,
  type RestartSubject,
} from '../../../../src/lib/session/restart/service.ts';

const AT = '2026-10-30T01:00:00.000Z';

interface World {
  subjects: RestartSubject[];
  stale: Record<string, LaunchInstructionSectionId[]>;
  busy: Set<string>;
  broken: Map<string, string>;
  restarted: string[];
  gaveUp: Array<[string, string]>;
  queue: RestartQueueEntry[];
  saves: number;
  loads: number;
  listed: number;
  looked: string[];
  clock: { now: number };
  /** When each restart was asked for, in ms since AT. */
  attempts: number[];
}

const world = (subjects: RestartSubject[], stale: World['stale'] = {}): World => ({
  subjects,
  stale,
  busy: new Set(),
  broken: new Map(),
  restarted: [],
  gaveUp: [],
  queue: [],
  saves: 0,
  loads: 0,
  listed: 0,
  looked: [],
  clock: { now: Date.parse(AT) },
  attempts: [],
});

const make = (w: World): RestartService => {
  const ports: RestartPorts = {
    subjects: async () => {
      w.listed += 1;
      return w.subjects;
    },
    subject: async id => {
      w.looked.push(id);
      return w.subjects.find(subject => subject.id === id);
    },
    outdated: async id => {
      if (id === 'throws') throw new Error('unreadable');
      return w.stale[id] ?? [];
    },
    restart: async id => {
      w.attempts.push(w.clock.now - Date.parse(AT));
      if (w.busy.has(id)) throw new RestartBusy('a test run is open');
      const broken = w.broken.get(id);
      if (broken !== undefined) throw new Error(broken);
      w.restarted.push(id);
    },
    gaveUp: async (id, reason) => {
      if (id === 'noisy') throw new Error('journal is down');
      w.gaveUp.push([id, reason]);
    },
    queue: {
      load: async () => {
        w.loads += 1;
        return w.queue;
      },
      save: async entries => {
        w.saves += 1;
        w.queue = [...entries];
      },
    },
    now: () => new Date(w.clock.now).toISOString(),
  };
  return new RestartService(ports);
};

const idle = (id: string, name?: string): RestartSubject => ({
  id,
  ...(name ? { name } : {}),
  running: true,
  idle: true,
});
const working = (id: string): RestartSubject => ({ id, running: true, idle: false });
const stopped = (id: string): RestartSubject => ({ id, name: 'Done', running: false, idle: true });

describe('RestartService.restart', () => {
  it('should restart outdated idle ferrets now, queue busy ones and leave current ones alone', async () => {
    const w = world([idle('a', 'Wren'), working('b'), idle('c'), stopped('d')], {
      a: ['pack'],
      b: ['tools'],
      d: ['tools'],
    });
    const result = await make(w).restart({ scope: 'outdated' });
    should(result).eql({
      restarted: [{ id: 'a', name: 'Wren' }],
      queued: [{ id: 'b', reason: 'mid-turn' }],
      skipped: [],
      failed: [],
    });
    should(w.restarted).eql(['a']);
    should(w.queue).eql([{ id: 'b', since: AT, reason: 'mid-turn', onlyIfOutdated: true }]);
  });

  it('should treat an unreadable outdated answer as current', async () => {
    const w = world([idle('throws')]);
    const result = await make(w).restart({ scope: 'outdated' });
    should(result.restarted).eql([]);
  });

  it('should queue a refused ferret as in-flight with the sentence the inventory gave', async () => {
    const w = world([idle('a', 'Wren')]);
    w.busy.add('a');
    const result = await make(w).restart({ scope: 'all' });
    should(result.queued).eql([{ id: 'a', name: 'Wren', reason: 'in-flight', detail: 'a test run is open' }]);
    should(w.queue[0]?.onlyIfOutdated).be.false();
  });

  it('should keep the first since when a ferret is queued again', async () => {
    const w = world([working('a')]);
    w.queue = [{ id: 'a', since: '2026-10-29T00:00:00.000Z', reason: 'mid-turn', onlyIfOutdated: false }];
    await make(w).restart({ scope: 'ids', ids: ['a'] });
    should(w.queue[0]?.since).equal('2026-10-29T00:00:00.000Z');
  });

  it('should queue the caller instead of restarting it mid-turn', async () => {
    const w = world([idle('me', 'Me'), idle('x')], { me: ['notify'], x: ['notify'] });
    const result = await make(w).restart({ scope: 'outdated', caller: 'me' });
    should(result.restarted).eql([{ id: 'x' }]);
    should(result.queued).eql([{ id: 'me', name: 'Me', reason: 'own-session' }]);
  });

  it('should find a ferret by callsign, preferring the running one, and name it once', async () => {
    const w = world([{ ...stopped('old'), name: 'Wren' }, idle('new', 'Wren')]);
    const result = await make(w).restart({ scope: 'ids', ids: [':wren', 'WREN', 'new'] });
    should(result.restarted).eql([{ id: 'new', name: 'Wren' }]);
    const only = world([{ ...stopped('old'), name: 'Wren' }]);
    should((await make(only).restart({ scope: 'ids', ids: ['wren'] })).skipped).eql([
      { id: 'old', name: 'Wren', reason: 'not-running' },
    ]);
  });

  it('should report ids that are missing or not running, and failures without stopping the rest', async () => {
    const w = world([stopped('s'), idle('bad', 'Bad'), idle('ok')]);
    w.broken.set('bad', 'cannot resume');
    const result = await make(w).restart({ scope: 'ids', ids: ['nope', 's', 'bad', 'ok'] });
    should(result).eql({
      restarted: [{ id: 'ok' }],
      queued: [],
      skipped: [
        { id: 'nope', reason: 'not-found' },
        { id: 's', name: 'Done', reason: 'not-running' },
      ],
      failed: [{ id: 'bad', name: 'Bad', reason: 'cannot resume' }],
    });
  });

  it('should drop a restarted ferret from the queue and stringify non-Error failures', async () => {
    const w = world([idle('a')]);
    w.queue = [{ id: 'a', since: AT, reason: 'mid-turn', onlyIfOutdated: false }];
    const service = new RestartService({
      subjects: async () => w.subjects,
      subject: async id => w.subjects.find(subject => subject.id === id),
      outdated: async () => [],
      restart: async () => {
        throw 'plain text';
      },
      gaveUp: async () => undefined,
      queue: {
        load: async () => w.queue,
        save: async e => {
          w.queue = [...e];
        },
      },
      now: () => AT,
    });
    const result = await service.restart({ scope: 'all' });
    should(result.failed).eql([{ id: 'a', reason: 'plain text' }]);
    const ok = make(w);
    w.queue = [{ id: 'a', since: AT, reason: 'mid-turn', onlyIfOutdated: false }];
    await ok.restart({ scope: 'all' });
    should(w.queue).eql([]);
  });

  it('should answer a retried request id from memory and forget the oldest after the cap', async () => {
    const w = world([idle('a')]);
    const service = make(w);
    const first = await service.restart({ scope: 'all' }, 'r-1');
    const again = await service.restart({ scope: 'all' }, 'r-1');
    should(again).equal(first);
    should(w.restarted).eql(['a']);
    for (let n = 0; n < 70; n += 1) await service.restart({ scope: 'ids', ids: ['zzz'] }, `fill-${n}`);
    await service.restart({ scope: 'all' }, 'r-1');
    should(w.restarted).eql(['a', 'a']);
  });
});

describe('RestartService.status and cancel', () => {
  it('should list outdated running ferrets and the queue, skipping unreadable ones', async () => {
    const w = world([idle('a', 'Wren'), idle('throws'), stopped('d')], { a: ['pack', 'notify'], d: ['tools'] });
    w.queue = [{ id: 'b', since: AT, reason: 'mid-turn', onlyIfOutdated: true }];
    should(await make(w).status()).eql({
      outdated: [{ id: 'a', name: 'Wren', sections: ['pack', 'notify'] }],
      queued: w.queue,
    });
  });

  it('should clear the queue and say how many it held', async () => {
    const w = world([]);
    w.queue = [{ id: 'b', since: AT, reason: 'mid-turn', onlyIfOutdated: true }];
    should(await make(w).cancel()).eql({ cancelled: 1 });
    should(w.queue).eql([]);
  });
});

describe('RestartService.drain', () => {
  const entry = (id: string, onlyIfOutdated = false): RestartQueueEntry => ({
    id,
    since: AT,
    reason: 'mid-turn',
    onlyIfOutdated,
  });

  it('should do nothing, and not write, when the queue is empty', async () => {
    const w = world([idle('a')]);
    await make(w).drain();
    should(w.saves).equal(0);
  });

  it('should restart what is idle now, keep what is still busy, and drop what is gone', async () => {
    const w = world([idle('a'), working('b'), stopped('s'), idle('c'), idle('d')], { c: [] });
    w.queue = [entry('a'), entry('b'), entry('s'), entry('gone'), entry('c', true), entry('d', true)];
    w.stale.d = ['tools'];
    await make(w).drain();
    should(w.restarted).eql(['a', 'd']);
    should(w.queue.map(e => e.id)).eql(['b']);
  });

  it('should keep a ferret the inventory still refuses, marked in-flight', async () => {
    const w = world([idle('a')]);
    w.busy.add('a');
    w.queue = [entry('a')];
    await make(w).drain();
    should(w.queue).eql([{ ...entry('a'), reason: 'in-flight' }]);
  });

  it('should give up on a ferret whose restart fails, journal it, and survive a failing journal', async () => {
    const w = world([idle('a'), idle('noisy')]);
    w.broken.set('a', 'cannot resume');
    w.broken.set('noisy', 'cannot resume');
    w.queue = [entry('a'), entry('noisy')];
    await make(w).drain();
    should(w.gaveUp).eql([['a', 'cannot resume']]);
    should(w.queue).eql([]);
  });

  it('should treat an unreadable outdated check as still outdated, and share overlapping passes', async () => {
    const w = world([idle('throws')]);
    w.queue = [entry('throws', true)];
    const service = make(w);
    const first = service.drain();
    const second = service.drain();
    should(second).equal(first);
    await first;
    should(w.restarted).eql(['throws']);
    await service.drain();
  });
});

/**
 * The stall budget of the drain (the EC2 stalls of 2026-10-30): it runs on a 10 s tick for the daemon's whole
 * life, so what one pass may cost is pinned here on a fake clock — nothing when the queue is empty, one read per
 * QUEUED ferret rather than the fleet, and no repeat of a refused preflight until the backoff ends or the
 * ferret's record moves.
 */
describe('RestartService.drain stall budget', () => {
  const entry = (id: string): RestartQueueEntry => ({ id, since: AT, reason: 'mid-turn', onlyIfOutdated: true });
  const fleet = (size: number): RestartSubject[] =>
    Array.from({ length: size }, (_, n) => ({ id: `f${n}`, running: n % 10 === 0, idle: true }));

  it('should read the queue once and nothing at all on later ticks while it stays empty', async () => {
    const w = world(fleet(500));
    const service = make(w);
    for (let tick = 0; tick < 50; tick += 1) await service.drain();
    should(w.loads).equal(1);
    should(w.listed).equal(0);
    should(w.looked).eql([]);
    should(w.saves).equal(0);
  });

  it('should look up only the queued ferret, never list the fleet, and not rewrite an unchanged queue', async () => {
    const w = world([...fleet(500), working('busy')]);
    w.queue = [entry('busy')];
    const service = make(w);
    for (let tick = 0; tick < 5; tick += 1) await service.drain();
    should(w.listed).equal(0);
    should(w.looked).eql(['busy', 'busy', 'busy', 'busy', 'busy']);
    should(w.saves).equal(0);
    should(w.loads).equal(1);
  });

  it('should not ask the inventory again before the backoff ends, and double it while nothing moves', async () => {
    const w = world([{ ...idle('a'), revision: 'r1' }], { a: ['tools'] });
    w.busy.add('a');
    w.queue = [entry('a')];
    const service = make(w);
    // Ten minutes of 10 s ticks.
    for (let second = 0; second <= 600; second += 10) {
      w.clock.now = Date.parse(AT) + second * 1000;
      await service.drain();
    }
    // Without the backoff that is 61 migrate preflights; with it: 10 s, 20 s, 40 s, 80 s, then the cap.
    should(w.attempts.slice(0, 5)).eql([0, 10_000, 30_000, 70_000, 150_000]);
    should(w.attempts.length).be.below(10);
    const gaps = w.attempts.slice(1).map((at, n) => at - (w.attempts[n] ?? 0));
    should(Math.max(...gaps)).equal(RESTART_RETRY_CAP_MS);
    should(w.queue).eql([{ ...entry('a'), reason: 'in-flight' }]);
    should(w.saves).equal(1);
  });

  it('should ask again at once when the ferret record moves, and restart it then', async () => {
    const w = world([{ ...idle('a'), revision: 'r1' }], { a: ['tools'] });
    w.busy.add('a');
    w.queue = [entry('a')];
    const service = make(w);
    await service.drain();
    w.clock.now += RESTART_RETRY_BASE_MS / 2;
    w.busy.delete('a');
    await service.drain();
    should(w.restarted).eql([]);
    w.subjects = [{ ...idle('a'), revision: 'r2' }];
    await service.drain();
    should(w.restarted).eql(['a']);
    should(w.queue).eql([]);
  });

  it('should start the backoff over when a person asks for the same ferret again', async () => {
    const w = world([idle('a')], { a: ['tools'] });
    w.busy.add('a');
    w.queue = [entry('a')];
    const service = make(w);
    await service.drain();
    w.busy.delete('a');
    await service.restart({ scope: 'ids', ids: ['a'] });
    should(w.restarted).eql(['a']);
    should(w.queue).eql([]);
    should(RESTART_RETRY_BASE_MS).be.below(RESTART_RETRY_CAP_MS);
  });
});
