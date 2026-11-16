import { describe, expect, test } from 'bun:test';
import type { AskBoardSnapshot } from '@ferretry/core-asks/contract';
import {
  AGENDA_REST_NUDGE_ID_PREFIX,
  AGENDA_REST_NUDGE_LIMIT,
  AGENDA_REST_NUDGE_MAX_MS,
  AGENDA_REST_NUDGE_MS,
  AgendaRestNudger,
  restNudgeCount,
  restNudgeDueAt,
  restNudgeMessage,
  restNudgeSendId,
  restNudgesDue,
  type AgendaRestNudgePorts,
  type RestItem,
  type RestNudgeRecord,
} from '../../../daemon/lib/rest-nudge.ts';
import { AGENDA_NUDGE_MARK, NudgeSendFailure } from '../../../daemon/lib/turn-nudge.ts';

const REPLIED = '2026-11-03T09:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(REPLIED) + minutes * 60_000).toISOString();
const FERRET = 'ms8kkfyd-95b7037e';

/** An item the owner replied to: it rests, waiting on the ferret, since `REPLIED`. */
const resting = (id: string, over: Record<string, unknown> = {}): RestItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}?`,
    title: `Ask ${id}`,
    raisedBy: 'agent',
    raisedBySession: FERRET,
    raisedByName: 'Ada',
    parked: { reason: 'replied', at: REPLIED },
    resting: { sub: 'waiting-on-ferret', at: REPLIED },
    ...over,
  }) as unknown as RestItem;

const board = (...items: RestItem[]): AskBoardSnapshot => ({ sessionId: FERRET, items }) as unknown as AskBoardSnapshot;

const record = (over: Partial<RestNudgeRecord> = {}): RestNudgeRecord => ({
  since: REPLIED,
  nudges: 1,
  at: at(30),
  sendId: 's1',
  ...over,
});

describe('when a resting item’s nudge is due', () => {
  test('is 30 minutes after it began resting, then doubles after each nudge, up to a day', () => {
    expect(AGENDA_REST_NUDGE_MS).toBe(30 * 60_000);
    expect(restNudgeDueAt(resting('A1'), {})).toBe(Date.parse(at(30)));
    expect(restNudgeDueAt(resting('A1'), { A1: record({ nudges: 1, at: at(30) }) })).toBe(Date.parse(at(90)));
    expect(restNudgeDueAt(resting('A1'), { A1: record({ nudges: 2, at: at(90) }) })).toBe(Date.parse(at(210)));
    expect(restNudgeDueAt(resting('A1'), { A1: record({ nudges: 6, at: at(0) }) })).toBe(
      Date.parse(at(0)) + AGENDA_REST_NUDGE_MAX_MS,
    );
  });

  test('is never for an item the ferret works on, a snoozed one, a done one, or one that is not resting', () => {
    expect(
      restNudgeDueAt(resting('A1', { resting: { sub: 'working', at: REPLIED, why: 'rebasing' } }), {}),
    ).toBeUndefined();
    expect(
      restNudgeDueAt(resting('A1', { parked: { reason: 'snoozed', at: REPLIED, until: at(600) } }), {}),
    ).toBeUndefined();
    expect(restNudgeDueAt(resting('A1', { resolvedAt: at(1) }), {})).toBeUndefined();
    expect(restNudgeDueAt(resting('A1', { parked: undefined, resting: undefined }), {})).toBeUndefined();
  });

  test('is never once the rest has had its cap of nudges, whichever side counted them', () => {
    expect(restNudgeDueAt(resting('A1'), { A1: record({ nudges: AGENDA_REST_NUDGE_LIMIT - 1 }) })).toBeDefined();
    expect(restNudgeDueAt(resting('A1'), { A1: record({ nudges: AGENDA_REST_NUDGE_LIMIT }) })).toBeUndefined();
    const carried = resting('A1', {
      resting: { sub: 'waiting-on-ferret', at: REPLIED, nudges: AGENDA_REST_NUDGE_LIMIT, nudgedAt: at(500) },
    });
    expect(restNudgeDueAt(carried, {})).toBeUndefined();
  });

  test('counts only the rest it is in: a record of an earlier rest, or none, is zero', () => {
    const stale = { A1: record({ since: at(-600), nudges: 5 }) };
    expect(restNudgeCount(resting('A1'), stale)).toBe(0);
    expect(restNudgeDueAt(resting('A1'), stale)).toBe(Date.parse(at(30)));
    expect(restNudgeCount(resting('A1'), { A1: record({ nudges: 3 }) })).toBe(3);
    expect(restNudgeCount(resting('A1', { resting: { sub: 'waiting-on-ferret', at: REPLIED, nudges: 4 } }), {})).toBe(
      4,
    );
    expect(restNudgeCount(resting('A1', { resting: { sub: 'working', at: REPLIED } }), {})).toBe(0);
  });

  test('reads the later of the record’s and the board’s own last nudge, and says nothing when no clock reads', () => {
    const carried = resting('A1', { resting: { sub: 'waiting-on-ferret', at: REPLIED, nudges: 1, nudgedAt: at(60) } });
    expect(restNudgeDueAt(carried, { A1: record({ nudges: 1, at: at(30) }) })).toBe(Date.parse(at(120)));
    expect(
      restNudgeDueAt(resting('A1', { resting: { sub: 'waiting-on-ferret', at: 'not a time' } }), {}),
    ).toBeUndefined();
  });
});

describe('which items are due', () => {
  test('only the ferret’s own items and the daemon’s on its behalf, due by now, oldest first', () => {
    const daemonCard = resting('A3', { raisedBy: 'daemon', raisedBySession: null, source: 'task', sourceRef: 'x:1' });
    const gateFollowup = resting('A6', {
      raisedBy: 'daemon',
      raisedBySession: null,
      source: 'task',
      sourceRef: 'gate-followup:F12:1',
      resting: { sub: 'waiting-on-ferret', at: at(5) },
    });
    const cardAgenda = resting('A7', {
      raisedBy: 'daemon',
      raisedBySession: null,
      source: 'task',
      sourceRef: 'card-agenda:F12',
      resting: { sub: 'waiting-on-ferret', at: at(7) },
    });
    const notice = resting('A5', { notice: true });
    const items = [
      resting('A2', { resting: { sub: 'waiting-on-ferret', at: at(10) } }),
      resting('A1'),
      daemonCard,
      notice,
      gateFollowup,
      cardAgenda,
      resting('A4', { resting: { sub: 'waiting-on-ferret', at: at(25) } }),
    ];

    const due = restNudgesDue(items, {}, Date.parse(at(45)));

    expect(due.map(item => item.id)).toEqual(['A1', 'A6', 'A7', 'A2']);
  });
});

describe('the words and the send id', () => {
  test('one short message names every item and says how to answer, rest or close', () => {
    const message = restNudgeMessage([resting('A1'), resting('A2')], 'fy');
    expect(message.startsWith(AGENDA_NUDGE_MARK)).toBe(true);
    expect(message).toContain('!A1 «Ask A1», !A2 «Ask A2»');
    expect(message).toContain('Answer each:');
    expect(message).toContain('fy agenda answer A1 "<text>"');
    expect(message).toContain('fy agenda rest A1 --why');
    expect(message).toContain('fy agenda done A1');
    expect(restNudgeMessage([resting('A1')], 'fy')).toContain('Answer it:');
    expect(restNudgeMessage([], 'fy')).toContain('fy agenda answer A1');
  });

  test('the send id names the ferret, the first item, the rest it is in and which nudge it is', () => {
    const first = restNudgeSendId(FERRET, resting('A1'), {});
    expect(first).toBe(`${AGENDA_REST_NUDGE_ID_PREFIX}${FERRET}-A1.${Date.parse(REPLIED)}.1`);
    expect(restNudgeSendId(FERRET, resting('A1'), { A1: record({ nudges: 1 }) })).toBe(
      `${AGENDA_REST_NUDGE_ID_PREFIX}${FERRET}-A1.${Date.parse(REPLIED)}.2`,
    );
    const later = resting('A1', { resting: { sub: 'waiting-on-ferret', at: at(100) } });
    expect(restNudgeSendId(FERRET, later, {})).not.toBe(first);
    expect(restNudgeSendId(FERRET, resting('A1', { resting: undefined, parked: undefined }), {})).toContain('NaN');
  });
});

/** The store the way the state adapter behaves, and a world to sweep. */
const world = (
  over: { enabled?: boolean; running?: boolean; failSend?: string | Error; boards?: AskBoardSnapshot[] } = {},
) => {
  const clock = { value: REPLIED };
  const files = new Map<string, Record<string, RestNudgeRecord>>();
  const sent: Array<{ ferret: string; sendId: string; message: string }> = [];
  const failures: unknown[] = [];
  const reserved: string[][] = [];
  const state = { failSend: over.failSend, enabled: over.enabled ?? true, running: over.running ?? true };
  const boards = over.boards ?? [board(resting('A1'), resting('A2', { title: 'Ask A2' }))];
  const ports: AgendaRestNudgePorts = {
    records: async ferret => files.get(ferret) ?? {},
    reserve: async (ferret, taken, live) => {
      reserved.push(Object.keys(taken));
      files.set(ferret, {
        ...Object.fromEntries(Object.entries(files.get(ferret) ?? {}).filter(([id]) => live.includes(id))),
        ...taken,
      });
    },
    release: async (ferret, sendId, prior) => {
      const next = { ...(files.get(ferret) ?? {}) };
      for (const [id, before] of Object.entries(prior)) {
        if (next[id]?.sendId !== sendId) continue;
        if (before === undefined) delete next[id];
        else next[id] = before;
      }
      files.set(ferret, next);
    },
    enabled: () => state.enabled,
    boards: async () => boards,
    running: async () => state.running,
    now: () => clock.value,
    send: async (ferret, sendId, message) => {
      if (state.failSend !== undefined)
        throw typeof state.failSend === 'string' ? new NudgeSendFailure(state.failSend, 'refused') : state.failSend;
      sent.push({ ferret, sendId, message });
    },
    failed: (_ferret, error) => void failures.push(error),
  };
  const nudger = () => new AgendaRestNudger(ports, 'fy');
  return { clock, files, sent, failures, reserved, state, nudger, ports, boards };
};

describe('the silence nudge sweep', () => {
  test('nudges the ferret once for both items after 30 minutes, and not again until the backoff', async () => {
    const { clock, nudger, sent, files } = world();
    const sweeper = nudger();

    clock.value = at(29);
    const early = await sweeper.sweep();
    clock.value = at(31);
    const due = await sweeper.sweep();
    clock.value = at(60);
    const tooSoon = await sweeper.sweep();
    clock.value = at(92);
    const backoff = await sweeper.sweep();

    expect([early, due, tooSoon, backoff]).toEqual([0, 1, 0, 1]);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.sendId).toBe(`${AGENDA_REST_NUDGE_ID_PREFIX}${FERRET}-A1.${Date.parse(REPLIED)}.1`);
    expect(sent[1]?.sendId).toBe(`${AGENDA_REST_NUDGE_ID_PREFIX}${FERRET}-A1.${Date.parse(REPLIED)}.2`);
    expect(sent[0]?.message).toContain('!A1 «Ask A1», !A2 «Ask A2»');
    expect(Object.values(files.get(FERRET) ?? {}).map(each => each.nudges)).toEqual([2, 2]);
  });

  test('says nothing while the machine has the agenda nudge off', async () => {
    const { clock, nudger, sent, files } = world({ enabled: false });
    clock.value = at(120);
    expect(await nudger().sweep()).toBe(0);
    expect(sent).toEqual([]);
    expect(files.size).toBe(0);
  });

  test('never nudges a ferret that is stopped or gone, and counts nothing for it', async () => {
    const { clock, nudger, sent, files } = world({ running: false });
    clock.value = at(120);
    expect(await nudger().sweep()).toBe(0);
    expect(sent).toEqual([]);
    expect(files.size).toBe(0);
  });

  test('a ferret that never answers is nudged at most the cap, across a restart on every sweep', async () => {
    const { clock, files, sent, nudger } = world();
    // A sweep every minute for ten days; a fresh nudger (a restarted daemon) each time, over the same counters.
    for (let minute = 0; minute <= 10 * 24 * 60; minute += 1) {
      clock.value = at(minute);
      await nudger().sweep();
    }
    expect(sent).toHaveLength(AGENDA_REST_NUDGE_LIMIT);
    expect(new Set(sent.map(one => one.sendId)).size).toBe(AGENDA_REST_NUDGE_LIMIT);
    expect(Object.values(files.get(FERRET) ?? {}).map(each => each.nudges)).toEqual([
      AGENDA_REST_NUDGE_LIMIT,
      AGENDA_REST_NUDGE_LIMIT,
    ]);
  });

  test('the counts are written before the send, so a send that may have been typed is never nudged again early', async () => {
    const { clock, files, sent, nudger, reserved } = world({ failSend: 'send_unconfirmed' });
    clock.value = at(31);
    const sweeper = nudger();
    expect(await sweeper.sweep()).toBe(0);
    expect(reserved).toEqual([['A1', 'A2']]);
    expect(Object.values(files.get(FERRET) ?? {}).map(each => each.nudges)).toEqual([1, 1]);
    clock.value = at(40);
    await sweeper.sweep();
    expect(sent).toEqual([]);
    expect(reserved).toHaveLength(1);
  });

  test('a send known to have typed nothing gives the count back, so the next sweep tries again', async () => {
    const { clock, files, state, nudger, failures, sent } = world({ failSend: 'send_refused' });
    clock.value = at(31);
    expect(await nudger().sweep()).toBe(0);
    expect(files.get(FERRET)).toEqual({});
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(NudgeSendFailure);

    state.failSend = undefined;
    clock.value = at(32);
    expect(await nudger().sweep()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  test('giving a count back restores an earlier nudge’s record and leaves a newer send’s alone', async () => {
    const { clock, files, state, nudger, ports } = world();
    clock.value = at(31);
    await nudger().sweep();
    const before = structuredClone(files.get(FERRET));
    state.failSend = 'composer_occupied';
    clock.value = at(95);
    await nudger().sweep();
    expect(files.get(FERRET)).toEqual(before);

    await ports.release(FERRET, 'another-send', { A1: undefined });
    expect(files.get(FERRET)).toEqual(before);
  });

  test('a failed give-back is swallowed, and the send failure is the one reported', async () => {
    const { clock, ports, failures } = world({ failSend: 'send_refused' });
    clock.value = at(31);
    const sweeper = new AgendaRestNudger(
      {
        ...ports,
        release: async () => {
          throw new Error('the state is damaged');
        },
      },
      'fy',
    );
    expect(await sweeper.sweep()).toBe(0);
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).name).toBe('NudgeSendFailure');
  });

  test('a send that throws something that is not a refusal keeps its count', async () => {
    const { clock, nudger, files, failures } = world({ failSend: new Error('the pane vanished') });
    clock.value = at(31);
    expect(await nudger().sweep()).toBe(0);
    expect(Object.values(files.get(FERRET) ?? {}).map(each => each.nudges)).toEqual([1, 1]);
    expect(failures).toHaveLength(1);
  });

  test('one ferret failing leaves the others nudged', async () => {
    const other = { ...board(resting('A9')), sessionId: 'ms9zzzzz-12345678' } as AskBoardSnapshot;
    const { clock, sent, ports, boards } = world();
    boards.push(other);
    clock.value = at(31);
    const sweeper = new AgendaRestNudger(
      {
        ...ports,
        records: async ferret => {
          if (ferret === FERRET) throw new Error('unreadable');
          return await ports.records(ferret);
        },
      },
      'fy',
    );
    expect(await sweeper.sweep()).toBe(1);
    expect(sent.map(one => one.ferret)).toEqual(['ms9zzzzz-12345678']);
  });

  test('an answer, or the ferret taking the item on, ends the nudges', async () => {
    const { clock, nudger, sent, boards } = world();
    boards.splice(
      0,
      1,
      board(
        resting('A1', { resting: { sub: 'working', at: at(10) } }),
        resting('A2', { parked: undefined, resting: undefined }),
      ),
    );
    clock.value = at(300);
    expect(await nudger().sweep()).toBe(0);
    expect(sent).toEqual([]);
  });

  test('a new rest (the owner replied again) has its own count and its own first nudge', async () => {
    const { clock, nudger, sent, boards, files } = world();
    clock.value = at(31);
    await nudger().sweep();
    boards.splice(0, 1, board(resting('A1', { resting: { sub: 'waiting-on-ferret', at: at(100) } })));
    clock.value = at(120);
    expect(await nudger().sweep()).toBe(0);
    clock.value = at(131);
    expect(await nudger().sweep()).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.sendId).toBe(`${AGENDA_REST_NUDGE_ID_PREFIX}${FERRET}-A1.${Date.parse(at(100))}.1`);
    expect(Object.keys(files.get(FERRET) ?? {})).toEqual(['A1']);
  });
});
