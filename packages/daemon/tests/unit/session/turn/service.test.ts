import { describe, it } from 'bun:test';
import type { SessionTurnState } from '@ferretry/protocol';
import should from 'should';
import type { TurnPaneEvidence } from '../../../../src/lib/session/turn/policy.ts';
import {
  type SessionTurnPorts,
  SessionTurnWatcher,
  TURN_WATCH_INTERVAL_MS,
  type TurnStateChange,
  type TurnWatchSession,
} from '../../../../src/lib/session/turn/service.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/**
 * The watcher over scripted evidence: what it records, that it records each boundary once, that one
 * session's failure never stops another, and that it never overlaps itself.
 */

const A = parseSessionId('session-a');
const B = parseSessionId('session-b');
const IDLE: TurnPaneEvidence = { working: false, atPrompt: true, permission: false };
const BUSY: TurnPaneEvidence = { working: true, atPrompt: false, permission: false };
const started: TranscriptEvent = { harness: 'codex', role: 'system', kind: 'turn', state: 'started' };
const completed: TranscriptEvent = { harness: 'codex', role: 'system', kind: 'turn', state: 'completed' };

interface World {
  states: Map<SessionId, TurnWatchSession['state']>;
  panes: Map<SessionId, TurnPaneEvidence | undefined>;
  transcripts: Map<SessionId, readonly TranscriptEvent[] | undefined>;
  recorded: { id: SessionId; change: TurnStateChange }[];
  failPane?: SessionId;
  refuse?: boolean;
}

const ports = (world: World): SessionTurnPorts => ({
  sessions: async () => [...world.states].map(([id, state]) => ({ id, state })),
  transcript: async id => world.transcripts.get(id),
  pane: async id => {
    if (world.failPane === id) throw new Error('pane gone');
    return world.panes.get(id);
  },
  record: async (id, change) => {
    if (world.refuse) return false;
    world.recorded.push({ id, change });
    const state = world.states.get(id);
    if (state !== undefined)
      world.states.set(id, { ...state, turnState: change.to as SessionTurnState, turnPrompt: change.prompt });
    return true;
  },
  clock: { now: () => '2026-10-16T08:00:00.000Z' },
});

const world = (): World => ({ states: new Map(), panes: new Map(), transcripts: new Map(), recorded: [] });

describe('SessionTurnWatcher', () => {
  it('should look every couple of seconds', () => {
    should(new SessionTurnWatcher(ports(world())).intervalMs).equal(TURN_WATCH_INTERVAL_MS);
    should(TURN_WATCH_INTERVAL_MS).be.belowOrEqual(2_000);
  });

  it('should record the dialog a session is parked on, a new one beside the same needs-input, and clear it once answered', async () => {
    const w = world();
    w.states.set(A, { status: 'running', turn: 1 });
    const parked = (prompt: string): TurnPaneEvidence => ({
      working: false,
      atPrompt: true,
      permission: false,
      prompt,
    });
    w.panes.set(A, parked('Make auto mode your default permission mode?'));
    const watcher = new SessionTurnWatcher(ports(w));

    await watcher.tick();
    await watcher.tick();
    w.panes.set(A, parked('Try the new fullscreen renderer?'));
    await watcher.tick();
    w.panes.set(A, IDLE);
    await watcher.tick();
    await watcher.tick();

    should(w.recorded.map(entry => entry.change)).deepEqual([
      { from: undefined, to: 'needs-input', prompt: 'Make auto mode your default permission mode?' },
      { from: 'needs-input', to: 'needs-input', prompt: 'Try the new fullscreen renderer?' },
      { from: 'needs-input', to: 'your-turn' },
    ]);
  });

  it('should record a turn start, its end once, and nothing more while nothing changes', async () => {
    const w = world();
    w.states.set(A, { status: 'running', turn: 1 });
    w.panes.set(A, BUSY);
    w.transcripts.set(A, [started]);
    const watcher = new SessionTurnWatcher(ports(w));

    await watcher.tick();
    w.panes.set(A, IDLE);
    w.transcripts.set(A, [started, completed]);
    await watcher.tick();
    await watcher.tick();

    should(w.recorded.map(entry => entry.change)).deepEqual([
      { from: undefined, to: 'working' },
      { from: 'working', to: 'your-turn' },
    ]);
  });

  it('should not end a turn on one idle frame the transcript contradicts, but on the second', async () => {
    const w = world();
    w.states.set(A, { status: 'running', turn: 1, turnState: 'working' });
    w.panes.set(A, IDLE);
    w.transcripts.set(A, [started]);
    const watcher = new SessionTurnWatcher(ports(w));

    const first = await watcher.tick();
    should(first.changed.size).equal(0);
    const second = await watcher.tick();

    should(second.changed.get(A)).deepEqual({ from: 'working', to: 'your-turn' });
  });

  it('should clear the record of a session that crashed or stopped, without reading it', async () => {
    const w = world();
    w.states.set(A, { status: 'failed', turn: 1, turnState: 'working' });
    w.failPane = A;
    const report = await new SessionTurnWatcher(ports(w)).tick();

    should(report.changed.get(A)).deepEqual({ from: 'working', to: undefined });
    should(report.failures.size).equal(0);
  });

  it("should carry on past one session's failure and report it", async () => {
    const w = world();
    w.states.set(A, { status: 'running', turn: 1 });
    w.states.set(B, { status: 'running', turn: 1 });
    w.failPane = A;
    w.panes.set(B, BUSY);
    w.transcripts.set(B, undefined);
    const report = await new SessionTurnWatcher(ports(w)).tick();

    should(report.failures.get(A)).equal('pane gone');
    should(report.changed.get(B)).deepEqual({ from: undefined, to: 'working' });
  });

  it('should report no change when the record refused it', async () => {
    const w = world();
    w.states.set(A, { status: 'running', turn: 1 });
    w.panes.set(A, BUSY);
    w.refuse = true;
    const report = await new SessionTurnWatcher(ports(w)).tick();

    should(report.changed.size).equal(0);
  });

  it('should forget a session that left the roster', async () => {
    const w = world();
    w.states.set(A, { status: 'running', turn: 1, turnState: 'working' });
    w.panes.set(A, IDLE);
    w.transcripts.set(A, [started]);
    const watcher = new SessionTurnWatcher(ports(w));
    await watcher.tick();
    w.states.delete(A);
    await watcher.tick();
    w.states.set(A, { status: 'running', turn: 1, turnState: 'working' });

    // The earlier weak idle frame is forgotten, so one more is not yet two in a row.
    should((await watcher.tick()).changed.size).equal(0);
  });

  it('should never overlap itself, and never reject', async () => {
    let release: () => void = () => undefined;
    const slow: SessionTurnPorts = {
      ...ports(world()),
      sessions: () =>
        new Promise(resolve => {
          release = () => resolve([]);
        }),
    };
    const watcher = new SessionTurnWatcher(slow);
    const first = watcher.run();
    should(await watcher.run()).be.undefined();
    release();
    should(await first).deepEqual({ changed: new Map(), failures: new Map() });

    const broken = new SessionTurnWatcher({ ...ports(world()), sessions: async () => Promise.reject(new Error('x')) });
    should(await broken.run()).be.undefined();
  });
});
