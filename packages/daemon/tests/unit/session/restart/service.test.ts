import { describe, it } from 'bun:test';
import type { LaunchInstructionSectionId, RestartQueueEntry } from '@ferretry/protocol';
import should from 'should';
import {
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
});

const make = (w: World): RestartService => {
  const ports: RestartPorts = {
    subjects: async () => w.subjects,
    outdated: async id => {
      if (id === 'throws') throw new Error('unreadable');
      return w.stale[id] ?? [];
    },
    restart: async id => {
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
      load: async () => w.queue,
      save: async entries => {
        w.saves += 1;
        w.queue = [...entries];
      },
    },
    now: () => AT,
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
