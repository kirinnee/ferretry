import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId, type SerialExecutor, type SessionId } from '../../../../src/lib/index.ts';
import {
  isLegacyAbsence,
  LegacySendReproof,
  type SendEvidenceReading,
  type SendRecord,
  type SendReproofCounts,
  type SendSettlement,
} from '../../../../src/lib/session/send/index.ts';
import type { ObservedHumanInput } from '../../../../src/lib/transcript/types.ts';

/** One look at a time is all a single test drives; the order is the caller's. */
const INLINE: SerialExecutor = { run: async (_key, work) => await work(), runExclusive: async work => await work() };

const LEAD = parseSessionId('lead');
const OTHER = parseSessionId('other');
const NOW = '2026-10-30T21:00:00.000Z';
const SENT_AT = '2026-10-30T08:56:48.962Z';

const legacy = (sendId: string, message: string, overrides: Partial<SendRecord> = {}): SendRecord => ({
  sendId,
  acceptedAt: SENT_AT,
  acceptedTurn: 594,
  path: 'native-inline',
  message,
  matchText: message,
  fate: 'timed_out',
  fateAt: '2026-10-30T09:03:04.759Z',
  unaccountedReason: 'not_delivered',
  retryable: true,
  attempt: 4,
  senderKind: 'agent',
  ...overrides,
});

const input = (text: string, key: string, at = '2026-10-30T08:58:04.631Z'): ObservedHumanInput => ({
  harness: 'claude',
  text,
  proof: 'normal-user-record',
  observedAt: at,
  proofKey: key,
  shapeVersion: 1,
});

/** A ledger in memory: what a settle wrote, and the journal beside it. */
class World {
  readonly ledgers = new Map<SessionId, SendRecord[]>();
  readonly journal: { id: SessionId; event: string; data: Readonly<Record<string, unknown>> }[] = [];
  readonly recorded: SendReproofCounts[] = [];
  readonly lines: string[] = [];
  pauses = 0;
  ran = false;
  /** Called before each settle's re-read, so a case can change a row under the pass. */
  beforeSettle: (() => void) | undefined;
  failList: SessionId | undefined;

  constructor(readonly reads: Map<SessionId, () => SendEvidenceReading>) {}

  only(id: SessionId, sendId: string): SendRecord {
    const found = this.ledgers.get(id)?.find(record => record.sendId === sendId);
    if (found === undefined) throw new Error(`no ${sendId}`);
    return found;
  }

  reproof(settings?: { matchSlackMs: number; maxLooks: number }): LegacySendReproof {
    let lists = 0;
    return new LegacySendReproof(
      {
        ledger: {
          list: async id => {
            if (id === this.failList) throw new Error('ledger unreadable');
            lists += 1;
            // The second list of a session is the re-read under the lock.
            if (lists % 2 === 0) this.beforeSettle?.();
            return [...(this.ledgers.get(id) ?? [])];
          },
          settle: async (id, sendId, patch: SendSettlement) => {
            const rows = this.ledgers.get(id) ?? [];
            const index = rows.findIndex(record => record.sendId === sendId);
            const merged = { ...rows[index], ...patch } as Record<string, unknown>;
            for (const [key, value] of Object.entries(patch)) if (value === undefined) delete merged[key];
            rows[index] = merged as unknown as SendRecord;
            return rows[index];
          },
        },
        evidence: {
          read: async id => {
            const read = this.reads.get(id);
            return read === undefined ? { readable: true, inputs: [] } : read();
          },
        },
        repository: { journal: async (id, event, data) => void this.journal.push({ id, event, data }) },
        roster: { sessions: () => [...this.ledgers.keys()] },
        serial: INLINE,
        clock: { now: () => NOW },
        marker: {
          ran: async () => this.ran,
          record: async (_at, counts) => void this.recorded.push(counts),
        },
        pause: async () => {
          this.pauses += 1;
        },
        log: line => void this.lines.push(line),
      },
      settings,
    );
  }
}

describe('re-proving the old "not delivered" rows', () => {
  it('finds a message deep in a giant transcript, read across many looks, and calls it delivered', async () => {
    // Arrange — 2,000 looks of other people's messages; the lost one arrives on look 1,500 only.
    const message = 'Bug B23 fix is up: https://github.com/kirinnee/ferretry/pull/967';
    let look = 0;
    const world = new World(
      new Map([
        [
          LEAD,
          () => {
            look += 1;
            const inputs = Array.from({ length: 50 }, (_, index) =>
              input(`unrelated message ${look}-${index}`, `k-${look}-${index}`),
            );
            if (look === 1_500) inputs.push(input(message, 'the-record'));
            return look < 2_000 ? { readable: false, catchingUp: true, inputs } : { readable: true, inputs };
          },
        ],
      ]),
    );
    world.ledgers.set(LEAD, [legacy('s1', message)]);

    // Act
    const counts = await world.reproof().run();

    // Assert — proven on the look that carried it, never read past it, and journalled as a correction.
    should(world.only(LEAD, 's1')).match({ fate: 'delivered', fateAt: NOW, evidence: { key: 'the-record' } });
    should(world.only(LEAD, 's1')).not.have.properties('unaccountedReason', 'retryable');
    should(look).equal(1_500);
    should(world.pauses).equal(1_499);
    should(world.journal).match([
      { id: LEAD, event: 'control.send_delivered', data: { sendId: 's1', corrected: 'timed_out', reproof: true } },
    ]);
    should(counts).eql({ sessions: 1, delivered: 1, unconfirmed: 0, unreadable: 0 });
    should(world.recorded).eql([counts]);
    should(world.lines[0]).match(/1 delivered, 0 unconfirmed, 0 unreadable, across 1 session/u);
  });

  it('calls a typed message the whole transcript does not hold unconfirmed, never not delivered', async () => {
    const world = new World(new Map([[LEAD, () => ({ readable: true, inputs: [input('something else', 'k')] })]]));
    world.ledgers.set(LEAD, [
      legacy('s1', 'the message nobody found'),
      legacy('s2', 'a discarded one', {
        unaccountedReason: 'composer_discarded',
      }),
    ]);

    const counts = await world.reproof().run();

    for (const sendId of ['s1', 's2']) {
      should(world.only(LEAD, sendId)).match({ fate: 'unaccounted', unaccountedReason: 'landing_unconfirmed' });
      should(world.only(LEAD, sendId)).not.have.property('retryable');
    }
    should(counts).match({ unconfirmed: 2, delivered: 0 });
    should(world.journal.map(entry => entry.event)).eql(['control.send_unaccounted', 'control.send_unaccounted']);
  });

  it('says unreadable when the transcript cannot be read to its end', async () => {
    let looks = 0;
    const world = new World(
      new Map([
        [LEAD, () => ({ readable: false, inputs: [] })],
        [
          OTHER,
          () => {
            looks += 1;
            return { readable: false, catchingUp: true, inputs: [] };
          },
        ],
      ]),
    );
    world.ledgers.set(LEAD, [legacy('s1', 'unbound transcript message')]);
    world.ledgers.set(OTHER, [legacy('s2', 'a reader that never finishes')]);

    const counts = await world.reproof({ matchSlackMs: 5_000, maxLooks: 3 }).run();

    should(world.only(LEAD, 's1')).match({ fate: 'unaccounted', unaccountedReason: 'transcript_unreadable' });
    should(world.only(OTHER, 's2')).match({ fate: 'unaccounted', unaccountedReason: 'transcript_unreadable' });
    should(looks).equal(3);
    should(counts).eql({ sessions: 2, delivered: 0, unconfirmed: 0, unreadable: 2 });
  });

  it('a reader that throws is unreadable too', async () => {
    const world = new World(
      new Map([
        [
          LEAD,
          () => {
            throw new Error('worker gone');
          },
        ],
      ]),
    );
    world.ledgers.set(LEAD, [legacy('s1', 'a message behind a broken reader')]);

    await world.reproof().run();

    should(world.only(LEAD, 's1')).match({ fate: 'unaccounted', unaccountedReason: 'transcript_unreadable' });
  });

  it('leaves a send nothing was typed for, a session-ended one and every other fate exactly as they were', async () => {
    let reads = 0;
    const world = new World(
      new Map([
        [
          LEAD,
          () => {
            reads += 1;
            return { readable: true, inputs: [] };
          },
        ],
      ]),
    );
    const untouched = [
      legacy('untyped', 'never typed', { untyped: true }),
      legacy('ended', 'session ended', { unaccountedReason: 'session_ended' }),
      legacy('delivered', 'delivered', { fate: 'delivered' }),
      legacy('unconfirmed', 'unconfirmed', { fate: 'unaccounted', unaccountedReason: 'timeout' }),
    ];
    world.ledgers.set(
      LEAD,
      untouched.map(record => ({ ...record })),
    );

    const counts = await world.reproof().run();

    should(world.ledgers.get(LEAD)).eql(untouched);
    should(reads).equal(0);
    should(counts).eql({ sessions: 0, delivered: 0, unconfirmed: 0, unreadable: 0 });
    should(untouched.filter(isLegacyAbsence)).eql([]);
  });

  it('never overwrites a row something else settled while it was reading', async () => {
    const world = new World(new Map([[LEAD, () => ({ readable: true, inputs: [] })]]));
    world.ledgers.set(LEAD, [legacy('s1', 'retried by a person'), legacy('s2', 'removed from the ledger')]);
    world.beforeSettle = () => {
      const rows = world.ledgers.get(LEAD) ?? [];
      rows[0] = { ...(rows[0] as SendRecord), fate: 'delivered', fateAt: '2026-10-30T20:59:00.000Z' };
      rows.splice(1, 1);
    };

    await world.reproof().run();

    should(world.only(LEAD, 's1')).match({ fate: 'delivered', fateAt: '2026-10-30T20:59:00.000Z' });
    should(world.journal).eql([]);
  });

  it('runs once: a marker that says it ran reads nothing', async () => {
    const world = new World(new Map());
    world.ran = true;
    world.ledgers.set(LEAD, [legacy('s1', 'would have been re-proved')]);

    should(await world.reproof().run()).be.undefined();
    should(world.only(LEAD, 's1').fate).equal('timed_out');
    should(world.recorded).eql([]);
  });

  it('a session whose ledger cannot be read is skipped, and the rest still finish', async () => {
    const world = new World(new Map([[OTHER, () => ({ readable: true, inputs: [input('the second one', 'k2')] })]]));
    world.ledgers.set(LEAD, [legacy('s1', 'behind a broken ledger')]);
    world.ledgers.set(OTHER, [legacy('s2', 'the second one')]);
    world.failList = LEAD;

    const counts = await world.reproof().run();

    should(world.only(OTHER, 's2').fate).equal('delivered');
    should(counts).match({ delivered: 1, sessions: 1 });
  });

  it('a stop between looks leaves the marker unwritten, so the next start finishes the job', async () => {
    let reproof: LegacySendReproof | undefined;
    const world = new World(
      new Map([
        [
          LEAD,
          () => {
            reproof?.stop();
            return { readable: false, catchingUp: true, inputs: [] };
          },
        ],
      ]),
    );
    world.ledgers.set(LEAD, [legacy('s1', 'stopped mid-read')]);
    world.ledgers.set(OTHER, [legacy('s2', 'never reached')]);
    reproof = world.reproof();

    should(await reproof.run()).be.undefined();
    should(world.only(LEAD, 's1').fate).equal('timed_out');
    should(world.recorded).eql([]);
  });

  it('a stop before the walk ends records nothing either', async () => {
    const world = new World(new Map());
    world.ledgers.set(LEAD, [legacy('s1', 'not read')]);
    const reproof = world.reproof();
    reproof.stop();

    should(await reproof.run()).be.undefined();
    should(world.recorded).eql([]);
  });
});
