import { describe, it } from 'bun:test';
import should from 'should';
import {
  nextLookDelayMs,
  PacedTurnWatcher,
  type PacedTurnPorts,
  TURN_WATCH_QUIET_MAX_MS,
} from '../../../../../daemon/lib/session/observer/turn-watch.ts';
import type { TurnFacts, TurnStateChange } from '../../../../../daemon/lib/session/observer/turn.ts';
import { TURN_WATCH_INTERVAL_MS, type TurnPaneEvidence } from '../../../../../daemon/lib/session/peers/turn.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';

const T0 = Date.parse('2026-11-08T10:00:00.000Z');
const IDLE: TurnPaneEvidence = { working: false, atPrompt: true, permission: false, frame: 'idle' };
const DRAWING = (n: number): TurnPaneEvidence => ({
  working: true,
  atPrompt: false,
  permission: false,
  frame: `w${n}`,
});

/** A fleet in memory: facts per session, the pane each shows, a clock the test moves, and what was looked at. */
function fleet(ids: readonly string[], facts: TurnFacts = { status: 'running', turn: 1, turnState: 'your-turn' }) {
  let nowMs = T0;
  const state = new Map<SessionId, TurnFacts>(ids.map(id => [parseSessionId(id), facts]));
  const panes = new Map<SessionId, TurnPaneEvidence | undefined>();
  const looked: SessionId[] = [];
  const recorded: { readonly id: SessionId; readonly change: TurnStateChange }[] = [];
  const failed: SessionId[] = [];
  let yields = 0;
  const broken = new Set<SessionId>();
  /** A session whose writer throws a failure carrying this key (a damaged document, named by its damage). */
  const damaged = new Map<SessionId, string>();
  const ports: PacedTurnPorts = {
    sessions: async () => [...state].map(([id, each]) => ({ id, state: each })),
    transcript: async () => undefined,
    pane: async id => {
      looked.push(id);
      if (broken.has(id)) throw new Error('the pane could not be read');
      return panes.has(id) ? panes.get(id) : IDLE;
    },
    record: async (id, change) => {
      const damage = damaged.get(id);
      if (damage !== undefined) throw Object.assign(new Error('the document is damaged'), { damage });
      recorded.push({ id, change });
      state.set(id, { ...(state.get(id) as TurnFacts), turnState: change.to });
      return true;
    },
    clock: { now: () => new Date(nowMs).toISOString() },
    yieldToLoop: async () => {
      yields += 1;
    },
    failed: id => void failed.push(id),
    failureKey: error => (error as { damage?: string }).damage,
  };
  const watcher = new PacedTurnWatcher(ports);
  const tick = async () => {
    const report = await watcher.tick();
    nowMs += TURN_WATCH_INTERVAL_MS;
    return report;
  };
  return {
    watcher,
    tick,
    state,
    panes,
    looked,
    recorded,
    failed,
    broken,
    damaged,
    yields: () => yields,
    id: (raw: string) => parseSessionId(raw),
  };
}

describe('nextLookDelayMs (RULING #44 idle back-off)', () => {
  it('should lengthen a quiet pane one tick at a time up to 10 s, and go back to 2 s on any change', () => {
    // Arrange
    const quiet: number[] = [];
    let delay = TURN_WATCH_INTERVAL_MS;

    // Act
    for (let index = 0; index < 6; index += 1) {
      delay = nextLookDelayMs(delay, true);
      quiet.push(delay);
    }
    const moved = nextLookDelayMs(TURN_WATCH_QUIET_MAX_MS, false);

    // Assert
    should(quiet).deepEqual([4_000, 6_000, 8_000, 10_000, 10_000, 10_000]);
    should(moved).equal(2_000);
  });
});

describe('PacedTurnWatcher', () => {
  it('J-0260 should look at a quiet pane less often, at most every 10 s', async () => {
    // Arrange
    const subject = fleet(['quiet-1']);

    // Act: one minute of 2 s ticks over an idle pane.
    for (let index = 0; index < 30; index += 1) await subject.tick();

    // Assert: today's inline tick would have looked 30 times; a quiet pane is looked at about every 10 s.
    should(subject.looked.length).be.within(6, 10);
    should(subject.watcher.delayOf(subject.id('quiet-1'))).equal(TURN_WATCH_QUIET_MAX_MS);
  });

  it('J-0260 should look at a drawing pane every 2 s, as today', async () => {
    // Arrange
    const subject = fleet(['busy-1'], { status: 'running', turn: 1, turnState: 'working' });
    const id = subject.id('busy-1');

    // Act
    for (let index = 0; index < 10; index += 1) {
      subject.panes.set(id, DRAWING(index));
      await subject.tick();
    }

    // Assert
    should(subject.looked.length).equal(10);
    should(subject.watcher.delayOf(id)).equal(TURN_WATCH_INTERVAL_MS);
  });

  it('should come back to 2 s at once when the pane redraws after backing off', async () => {
    // Arrange
    const subject = fleet(['wake-1']);
    const id = subject.id('wake-1');
    for (let index = 0; index < 20; index += 1) await subject.tick();
    const before = subject.looked.length;

    // Act: the pane starts drawing; within one back-off it is looked at, and then every tick.
    for (let index = 0; index < 10; index += 1) {
      subject.panes.set(id, DRAWING(index));
      await subject.tick();
    }

    // Assert
    should(subject.recorded.map(each => each.change.to)).deepEqual(['working']);
    should(subject.looked.length - before).be.aboveOrEqual(6);
    should(subject.watcher.delayOf(id)).equal(TURN_WATCH_INTERVAL_MS);
  });

  it('should look again at once when what is recorded about a ferret changes (a send recorded working)', async () => {
    // Arrange
    const subject = fleet(['sent-1']);
    const id = subject.id('sent-1');
    for (let index = 0; index < 10; index += 1) await subject.tick();
    const before = subject.looked.length;

    // Act: another writer (the send repository) records `working`; the pane is still idle.
    subject.state.set(id, { status: 'running', turn: 2, turnState: 'working' });
    await subject.tick();

    // Assert
    should(subject.looked.length).equal(before + 1);
  });

  it('should look again on the next tick once woken (Ferrets typed into the pane), and start the wait over at 2 s', async () => {
    // Arrange: a quiet pane, backed off to 10 s.
    const subject = fleet(['quiet-1']);
    for (let at = 0; at < 16; at += 1) await subject.tick();
    const id = subject.id('quiet-1');
    const backedOff = subject.watcher.delayOf(id);
    const lookedBefore = subject.looked.length;

    // Act
    subject.watcher.wake(id);
    await subject.tick();

    // Assert
    should(backedOff).equal(TURN_WATCH_QUIET_MAX_MS);
    should(subject.looked.length).equal(lookedBefore + 1);
    should(subject.watcher.delayOf(id)).equal(TURN_WATCH_INTERVAL_MS);
  });

  it('should never slow the second look an unconfirmed end of turn waits for', async () => {
    // Arrange: the record says working; the pane now shows only an idle prompt (unconfirmed your-turn).
    const subject = fleet(['ends-1'], { status: 'running', turn: 1, turnState: 'working' });

    // Act
    await subject.tick();
    await subject.tick();

    // Assert: two looks, two ticks apart, and the turn ended on the second.
    should(subject.looked.length).equal(2);
    should(subject.recorded.map(each => each.change.to)).deepEqual(['your-turn']);
  });

  it('should not end a turn on one idle-looking frame between two spinner frames while no transcript is proved', async () => {
    // Arrange
    const subject = fleet(['flick-1'], { status: 'running', turn: 1, turnState: 'working' });
    const id = subject.id('flick-1');

    // Act: drawing, one frame with no spinner, drawing again.
    subject.panes.set(id, DRAWING(1));
    await subject.tick();
    subject.panes.set(id, { working: false, atPrompt: true, permission: false, frame: 'between' });
    await subject.tick();
    subject.panes.set(id, DRAWING(2));
    await subject.tick();

    // Assert
    should(subject.recorded).deepEqual([]);
  });

  it('should hand the loop back after every ferret, so a tick is never one long slice', async () => {
    // Arrange
    const subject = fleet(['y-1', 'y-2', 'y-3']);

    // Act
    await subject.tick();

    // Assert
    should(subject.yields()).equal(3);
  });

  it('should report a ferret it could not look at and keep watching the others', async () => {
    // Arrange
    const subject = fleet(['bad-1', 'good-1'], { status: 'running', turn: 1, turnState: 'working' });
    subject.broken.add(subject.id('bad-1'));

    // Act: the good one needs its second look to end its turn.
    const first = await subject.tick();
    await subject.tick();

    // Assert
    should([...first.failures.keys()]).deepEqual([subject.id('bad-1')]);
    should(subject.failed).deepEqual([subject.id('bad-1')]);
    should(subject.recorded.map(each => each.id)).deepEqual([subject.id('good-1')]);
  });

  it('should back a ferret it could not decide off to 10 s, not report it on every 2 s tick', async () => {
    // Arrange: a failure at t0; the ticks that follow are 2 s apart.
    const subject = fleet(['bad-2'], { status: 'running', turn: 1, turnState: 'working' });
    subject.broken.add(subject.id('bad-2'));
    await subject.tick();

    // Act: four more ticks (2, 4, 6, 8 s), then the one at 10 s.
    const inside: number[] = [];
    for (let at = 0; at < 4; at += 1) inside.push((await subject.tick()).failures.size);
    const due = await subject.tick();

    // Assert: nothing is looked at or reported inside the wait, and it is reported again once it is due.
    should(inside).deepEqual([0, 0, 0, 0]);
    should(subject.failed).have.length(2);
    should(subject.looked).have.length(2);
    should([...due.failures.keys()]).deepEqual([subject.id('bad-2')]);
    should(subject.watcher.delayOf(subject.id('bad-2'))).equal(TURN_WATCH_QUIET_MAX_MS);
  });

  it('should tell a keyed failure once, again only when its key changes or after the ferret recorded a turn', async () => {
    // Arrange: the pane says the turn ended, but the writer meets a damaged document every time it is due.
    const subject = fleet(['damaged-7'], { status: 'running', turn: 1, turnState: 'working' });
    const id = subject.id('damaged-7');
    subject.damaged.set(id, 'damage-a');

    // Act + Assert: a minute of ticks (six due looks, each meeting the same damage) is told once.
    for (let at = 0; at < 30; at += 1) await subject.tick();
    should(subject.failed).deepEqual([id]);

    // Act + Assert: the damage changes: told once more, at its next due look, and not again.
    subject.damaged.set(id, 'damage-b');
    for (let at = 0; at < 30; at += 1) await subject.tick();
    should(subject.failed).deepEqual([id, id]);

    // Act + Assert: mended (the turn is recorded), then damaged again the same way: told again.
    subject.damaged.delete(id);
    for (let at = 0; at < 6; at += 1) await subject.tick();
    should(subject.recorded.map(each => each.change.to)).deepEqual(['your-turn']);
    subject.state.set(id, { status: 'running', turn: 2, turnState: 'working' });
    subject.damaged.set(id, 'damage-b');
    for (let at = 0; at < 6; at += 1) await subject.tick();
    should(subject.failed).deepEqual([id, id, id]);
  });

  it('should clear a stopped ferret without looking at its pane', async () => {
    // Arrange
    const subject = fleet(['gone-1'], { status: 'stopped', turn: 3, turnState: 'working' });

    // Act
    await subject.tick();

    // Assert
    should(subject.looked).deepEqual([]);
    should(subject.recorded.map(each => each.change.to)).deepEqual([undefined]);
  });
});
