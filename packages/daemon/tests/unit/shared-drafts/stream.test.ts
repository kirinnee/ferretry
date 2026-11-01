import { describe, it } from 'bun:test';
import should from 'should';
import {
  SHARED_DRAFT_MAX_CHARS,
  SHARED_DRAFT_STREAM_FRAME_BUDGET,
  type SharedDraftServerFrame,
  sharedDraftFrameBytes,
} from '@ferretry/protocol';
import type { SocketDownstream } from '../../../src/lib/api/socket.ts';
import {
  SHARED_DRAFT_PRESENCE_PER_SECOND,
  SHARED_DRAFT_STREAM_CLOSES,
  SHARED_DRAFT_STREAM_MAX_BUFFER_BYTES,
  SharedDraftPresence,
  SharedDraftService,
  SharedDraftStreamHandler,
  type SharedDraftStreamTarget,
  snapshotFrames,
} from '../../../src/lib/shared-drafts/index.ts';

const AT = '2026-11-01T00:00:00.000Z';
const G = 'gen-1';

/**
 * A socket the test reads back: every frame sent, and how (and whether) it was closed. `ready` is not
 * listed with the rest; where it arrived is kept in `readyAt` (how many frames came before it).
 */
class RecordingDownstream implements SocketDownstream {
  readonly frames: SharedDraftServerFrame[] = [];
  readyAt: number | undefined;
  closed: { code: number; reason: string } | undefined;
  buffered = 0;
  refuse = false;

  send(frame: string | Uint8Array): number | undefined {
    if (this.refuse) return -1;
    const parsed = JSON.parse(String(frame)) as SharedDraftServerFrame;
    if (parsed.kind === 'ready') this.readyAt = this.frames.length;
    else this.frames.push(parsed);
    return 1;
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  bufferedBytes(): number {
    return this.buffered;
  }

  kinds(): string[] {
    return this.frames.map(frame => frame.kind);
  }
}

const world = () => {
  const service = new SharedDraftService(
    { has: async sessionId => sessionId === 's1' },
    { load: async () => undefined, save: async () => undefined },
    { now: () => AT },
    { after: () => ({ cancel: () => undefined }) },
    { next: () => G },
  );
  const presence = new SharedDraftPresence();
  let now = 0;
  const clock = { nowMs: () => now };
  const open = async (target: Partial<SharedDraftStreamTarget> & { peer: string }) => {
    const downstream = new RecordingDownstream();
    const handler = new SharedDraftStreamHandler(
      service,
      presence,
      { sessionId: 's1', device: `${target.peer}'s phone`, ...target },
      downstream,
      clock,
    );
    await handler.open();
    return { handler, downstream };
  };
  return { service, presence, open, tick: (ms: number) => (now += ms) };
};

const settle = async () => await new Promise(resolve => setTimeout(resolve, 0));
const edit = (id: string, text: readonly (number | string)[], base: number) =>
  JSON.stringify({ kind: 'edit', id, edit: { generation: G, epoch: 0, base, text } });

describe('SharedDraftStreamHandler', () => {
  it('opens with the whole draft, then hears other composers edit by edit and its own edits as acks', async () => {
    // Arrange
    const { open, service } = world();
    const phone = await open({ peer: 'phone' });

    // Act — the laptop types through the plain route; the phone types down its stream.
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['hi'] });
    phone.handler.fromClient(edit('p1', [2, '!'], 1));
    await settle();

    // Assert
    should(phone.downstream.frames).match([
      { kind: 'snapshot', snapshot: { generation: G, rev: 0, text: '' } },
      { kind: 'edit', applied: { rev: 1, text: ['hi'] }, epoch: 0, rev: 1 },
      { kind: 'ack', id: 'p1', applied: { rev: 2, text: [2, '!'] }, epoch: 0, rev: 2 },
    ]);
  });

  it('sends an ack in sequence order, never after an edit that was sequenced later', async () => {
    // Arrange
    const { open } = world();
    const phone = await open({ peer: 'phone' });
    const laptop = await open({ peer: 'laptop' });

    // Act — both edits are handed over in the same tick.
    phone.handler.fromClient(edit('p1', ['a'], 0));
    laptop.handler.fromClient(edit('l1', ['b'], 0));
    await settle();

    // Assert — the phone hears its own answer (rev 1) before the laptop's edit (rev 2), and vice versa.
    should(phone.downstream.frames.slice(1).map(frame => [frame.kind, 'rev' in frame ? frame.rev : 0])).deepEqual([
      ['ack', 1],
      ['edit', 2],
    ]);
    should(laptop.downstream.frames.slice(1).map(frame => [frame.kind, 'rev' in frame ? frame.rev : 0])).deepEqual([
      ['edit', 1],
      ['ack', 2],
    ]);
  });

  it('catches a reconnecting composer up edit by edit instead of resending the whole draft', async () => {
    // Arrange
    const { open, service } = world();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['a'] });
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [1, 'b'] });
    await service.edit('s1', { generation: G, epoch: 0, base: 2, text: [2, 'c'] });

    // Act — it last saw revision 1.
    const phone = await open({ peer: 'phone', position: { generation: G, epoch: 0, rev: 1 } });

    // Assert — and only then `ready`, the moment to resend anything still unanswered.
    should(phone.downstream.frames).match([
      { kind: 'edit', rev: 2, applied: { text: [1, 'b'] } },
      { kind: 'edit', rev: 3, applied: { text: [2, 'c'] } },
    ]);
    should(phone.downstream.readyAt).equal(2);
  });

  it("names a composer's own edit by its id when it is replayed, so a reconnect never sends it twice", async () => {
    // Arrange — the phone's edit lands, and its stream drops before it hears the answer.
    const { open } = world();
    const before = await open({ peer: 'phone-1' });
    before.downstream.refuse = true;
    before.handler.fromClient(edit('p7', ['typed on the train'], 0));
    await settle();
    before.handler.close();

    // Act — the phone comes back on a new stream, as a new peer, from where it last knew the draft.
    const after = await open({ peer: 'phone-2', position: { generation: G, epoch: 0, rev: 0 } });

    // Assert
    should(after.downstream.frames).match([{ kind: 'edit', id: 'p7', rev: 1 }]);
  });

  it('falls back to the whole draft when the composer is from another generation', async () => {
    const { open } = world();
    const phone = await open({ peer: 'phone', position: { generation: 'old', epoch: 0, rev: 4 } });
    should(phone.downstream.kinds()).deepEqual(['snapshot']);
  });

  it('answers a refused edit with its own code, and keeps the stream open', async () => {
    const { open } = world();
    const phone = await open({ peer: 'phone' });

    phone.handler.fromClient(
      JSON.stringify({ kind: 'edit', id: 'p1', edit: { generation: 'old', epoch: 0, base: 0 } }),
    );
    await settle();

    should(phone.downstream.frames.at(-1)).match({ kind: 'error', id: 'p1', code: 'shared_draft_stale' });
    should(phone.downstream.closed).be.undefined();
  });

  it('closes on a frame it cannot read, and on a binary frame', async () => {
    const { open } = world();
    const one = await open({ peer: 'one' });
    const two = await open({ peer: 'two' });

    one.handler.fromClient('{not json');
    two.handler.fromClient(new Uint8Array([1]));

    should(one.downstream.closed).deepEqual(SHARED_DRAFT_STREAM_CLOSES.malformed);
    should(two.downstream.closed).deepEqual(SHARED_DRAFT_STREAM_CLOSES.malformed);
    // A closed stream ignores whatever arrives after.
    one.handler.fromClient(edit('p1', ['x'], 0));
  });

  it('L1: a stream closed while catching up never joins, so it never stays behind in presence', async () => {
    // Arrange — a draft that is slow to load from disk.
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const service = new SharedDraftService(
      { has: async () => true },
      {
        load: async () => {
          await gate;
          return undefined;
        },
        save: async () => undefined,
      },
      { now: () => AT },
      { after: () => ({ cancel: () => undefined }) },
      { next: () => G },
    );
    const presence = new SharedDraftPresence();
    const downstream = new RecordingDownstream();
    const handler = new SharedDraftStreamHandler(
      service,
      presence,
      { sessionId: 's1', peer: 'gone', device: 'Phone' },
      downstream,
      { nowMs: () => 0 },
    );

    // Act — the composer leaves before the draft has loaded.
    const opening = handler.open();
    handler.close();
    release?.();
    await opening;

    // Assert
    should(presence.members('s1')).equal(0);
    should(downstream.readyAt).be.undefined();
  });

  it('L2: sends a draft too big for one frame in parts, every part within the budget', async () => {
    const quotes = '"'.repeat(SHARED_DRAFT_MAX_CHARS);
    const frames = snapshotFrames({
      v: 1,
      sessionId: 's1',
      generation: G,
      epoch: 0,
      rev: 1,
      text: quotes,
      items: [],
      updatedAt: AT,
    });
    should(frames.length).be.above(1);
    for (const frame of frames) should(sharedDraftFrameBytes(frame)).be.belowOrEqual(SHARED_DRAFT_STREAM_FRAME_BUDGET);
    should(frames[0]).match({ kind: 'snapshot', more: frames.length - 1 });
    const text = frames.map(frame =>
      frame.kind === 'snapshot' ? frame.snapshot.text : frame.kind === 'snapshot-text' ? frame.text : '',
    );
    should(text.join('')).equal(quotes);
    // Never a surrogate pair cut across two parts.
    const emoji = '😀'.repeat(SHARED_DRAFT_MAX_CHARS / 2);
    const parts = snapshotFrames({
      v: 1,
      sessionId: 's1',
      generation: G,
      epoch: 0,
      rev: 1,
      text: emoji,
      items: [],
      updatedAt: AT,
    });
    for (const frame of parts) {
      const piece = frame.kind === 'snapshot' ? frame.snapshot.text : frame.kind === 'snapshot-text' ? frame.text : '';
      should(piece.length % 2).equal(0);
    }
  });

  it('L2: opens with a big draft in parts, and closes for a fresh start on an edit no frame can carry', async () => {
    // Arrange — a big draft already there, and an open stream.
    const { open, service } = world();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['"'.repeat(12_000)] });
    const phone = await open({ peer: 'phone' });
    should(phone.downstream.frames[0]).match({ kind: 'snapshot' });
    should(phone.downstream.frames.filter(frame => frame.kind === 'snapshot-text').length).be.above(0);

    // Act — an edit sent through the plain route, bigger than a frame.
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [-10_000, '\u0001'.repeat(7_000), 2_000] });

    // Assert
    should(phone.downstream.closed).deepEqual(SHARED_DRAFT_STREAM_CLOSES.oversized);
  });

  it('closes a reader that fell behind, and closes when the socket refuses a frame', async () => {
    const { open, service } = world();
    const slow = await open({ peer: 'slow' });
    const gone = await open({ peer: 'gone' });
    slow.downstream.buffered = SHARED_DRAFT_STREAM_MAX_BUFFER_BYTES + 1;
    gone.downstream.refuse = true;

    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['x'] });

    should(slow.downstream.closed).deepEqual(SHARED_DRAFT_STREAM_CLOSES.slowReader);
    // A refused frame is a reader not keeping up too: the socket is closed, not left with a dead handler.
    should(gone.downstream.closed).deepEqual(SHARED_DRAFT_STREAM_CLOSES.slowReader);
  });

  it('closes as unavailable when the draft cannot be read, or an edit fails for a reason of its own', async () => {
    // Arrange
    const presence = new SharedDraftPresence();
    const broken = {
      subscribe: () => () => undefined,
      since: async () => undefined,
      read: async () => {
        throw new Error('disk');
      },
    } as unknown as SharedDraftService;
    const failing = {
      subscribe: () => () => undefined,
      read: async () => ({
        v: 1,
        sessionId: 's1',
        generation: G,
        epoch: 0,
        rev: 0,
        text: '',
        items: [],
        updatedAt: AT,
      }),
      edit: async () => {
        throw new Error('bug');
      },
    } as unknown as SharedDraftService;
    const first = new RecordingDownstream();
    const second = new RecordingDownstream();
    const target = { sessionId: 's1', peer: 'p', device: 'Phone' };

    // Act
    await new SharedDraftStreamHandler(broken, presence, target, first, { nowMs: () => 0 }).open();
    const handler = new SharedDraftStreamHandler(failing, presence, target, second, { nowMs: () => 0 });
    await handler.open();
    handler.fromClient(edit('p1', ['x'], 0));
    await settle();

    // Assert
    should(first.closed).deepEqual(SHARED_DRAFT_STREAM_CLOSES.unavailable);
    should(second.closed).deepEqual(SHARED_DRAFT_STREAM_CLOSES.unavailable);
  });

  it("tells each composer where the owner's OTHER devices are typing, never its own, and when one closes", async () => {
    // Arrange
    const { open } = world();
    const phone = await open({ peer: 'phone', device: 'Kirin’s iPhone' });
    const laptop = await open({ peer: 'laptop', device: 'Desktop (Chrome)' });

    // Act
    phone.handler.fromClient(JSON.stringify({ kind: 'presence', typing: true, selection: [3, 3] }));
    laptop.handler.fromClient(JSON.stringify({ kind: 'presence', typing: false }));
    const tablet = await open({ peer: 'tablet', device: 'Tablet' });
    phone.handler.close();

    // Assert
    should(laptop.downstream.frames.filter(frame => frame.kind !== 'snapshot')).deepEqual([
      { kind: 'presence', peer: 'phone', device: 'Kirin’s iPhone', typing: true, selection: [3, 3] },
      { kind: 'left', peer: 'phone' },
    ]);
    should(phone.downstream.frames.filter(frame => frame.kind === 'presence')).deepEqual([
      { kind: 'presence', peer: 'laptop', device: 'Desktop (Chrome)', typing: false },
    ]);
    // One that opens later sees the others' last word at once.
    should(tablet.downstream.frames.filter(frame => frame.kind !== 'snapshot').map(frame => frame.kind)).deepEqual([
      'presence',
      'presence',
      'left',
    ]);
  });

  it('drops caret reports past the per-second budget instead of queueing them', async () => {
    // Arrange
    const { open, tick } = world();
    const phone = await open({ peer: 'phone' });
    const laptop = await open({ peer: 'laptop' });
    const report = JSON.stringify({ kind: 'presence', typing: true });

    // Act
    for (let index = 0; index < SHARED_DRAFT_PRESENCE_PER_SECOND + 3; index += 1) phone.handler.fromClient(report);
    tick(1_000);
    phone.handler.fromClient(report);

    // Assert
    should(laptop.downstream.frames.filter(frame => frame.kind === 'presence')).have.length(
      SHARED_DRAFT_PRESENCE_PER_SECOND + 1,
    );
  });

  it('delivers an edit made DURING the catch-up exactly once, whichever way the catch-up went', async () => {
    // Arrange
    const { service, presence } = world();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['a'] });
    const replayed = new RecordingDownstream();
    const fresh = new RecordingDownstream();
    const clock = { nowMs: () => 0 };

    // Act — both streams start opening, and an edit lands before either has finished.
    const opening = [
      new SharedDraftStreamHandler(
        service,
        presence,
        { sessionId: 's1', peer: 'r', device: 'R', position: { generation: G, epoch: 0, rev: 1 } },
        replayed,
        clock,
      ).open(),
      new SharedDraftStreamHandler(service, presence, { sessionId: 's1', peer: 'f', device: 'F' }, fresh, clock).open(),
    ];
    await service.edit('s1', { generation: G, epoch: 0, base: 1, text: [1, 'b'] });
    await Promise.all(opening);
    await service.edit('s1', { generation: G, epoch: 0, base: 2, text: [-2], sent: true });

    // Assert — revision 2 once each, then the send that moves the epoch on.
    should(replayed.frames.map(frame => [frame.kind, 'rev' in frame ? frame.rev : -1])).deepEqual([
      ['edit', 2],
      ['edit', 0],
    ]);
    const freshRevs = fresh.frames.map(frame =>
      frame.kind === 'snapshot' ? ['snapshot', frame.snapshot.rev] : [frame.kind, 'rev' in frame ? frame.rev : -1],
    );
    should(freshRevs.filter(([kind]) => kind === 'edit').length + (freshRevs[0]?.[1] === 2 ? 1 : 0)).equal(2);
  });

  it('closes when the socket throws on send', async () => {
    const { service, presence } = world();
    const throwing = new RecordingDownstream();
    throwing.send = () => {
      throw new Error('socket gone');
    };
    const handler = new SharedDraftStreamHandler(
      service,
      presence,
      { sessionId: 's1', peer: 'x', device: 'X' },
      throwing,
      { nowMs: () => 0 },
    );
    await handler.open();
    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['x'] });
    should(throwing.closed).deepEqual(SHARED_DRAFT_STREAM_CLOSES.slowReader);
  });

  it('stops hearing edits once closed', async () => {
    const { open, service } = world();
    const phone = await open({ peer: 'phone' });
    phone.handler.close();
    phone.handler.close();

    await service.edit('s1', { generation: G, epoch: 0, base: 0, text: ['x'] });

    should(phone.downstream.kinds()).deepEqual(['snapshot']);
  });
});

describe('SharedDraftPresence', () => {
  it('ignores a report from a composer that never joined, and a leave that already happened', () => {
    const presence = new SharedDraftPresence();
    const heard: unknown[] = [];
    const leave = presence.join('s1', 'a', 'A', frame => heard.push(frame));
    presence.publish('s1', 'ghost', { typing: true });
    presence.publish('s2', 'a', { typing: true });
    leave();
    leave();
    should(heard).be.empty();
  });
});
