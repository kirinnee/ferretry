import { describe, expect, test } from 'bun:test';
import {
  applyTextOp,
  SHARED_DRAFT_STREAM_RESYNC_CLOSE,
  normalizeTextOp,
  type SharedDraftClientFrame,
  SharedDraftClientFrameSchema,
  type SharedDraftServerFrame,
  type TextOp,
  transformTextOps,
} from '@ferretry/protocol';
import { useMemo, useState } from 'react';
import {
  type SharedDraft,
  type SharedDraftTimers,
  sharedDraftTypingHint,
  useSharedDraft,
} from '../../src/hooks/use-shared-draft.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { DaemonStreamOpener } from '../../src/lib/event-transport.ts';
import type { RelayStreamRequest } from '../../src/lib/relay-carrier.ts';
import type { RelayClientSession } from '../../src/lib/relay-session.ts';
import { openSharedDraftStream, sharedDraftStreamPath } from '../../src/lib/shared-draft-stream.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

const daemon = daemonConnection({ daemonId: 'live', baseUrl: 'https://live.example.test', deviceId: 'device' });
const scope = daemonSessionScope(daemon, 'sess one');
const G = 'gen-1';
const AT = '2026-11-01T00:00:00.000Z';

interface FakeStream {
  readonly peer: string;
  readonly device: string;
  readonly deliver: (frame: SharedDraftServerFrame) => void;
  readonly closers: ((closed: { code: number; reason: string }) => void)[];
  readonly sent: SharedDraftClientFrame[];
  alive: boolean;
  closedBy?: number;
}

/**
 * The daemon's side of the stream, restated: one sequencer, a replay for a reconnect, presence for the
 * others. Frames go down asynchronously, as they would over a socket.
 */
class FakeDaemon {
  text = '';
  readonly history: { op: TextOp; id?: string }[] = [];
  readonly streams: FakeStream[] = [];
  devices: string[] = [];
  refuseNext = false;

  readonly open: DaemonStreamOpener = async (_daemon, request: RelayStreamRequest) => {
    const peer = `peer-${this.streams.length + 1}`;
    const stream: FakeStream = {
      peer,
      device: this.devices.shift() ?? 'Somewhere',
      deliver: frame =>
        queueMicrotask(() => stream.alive && request.onData({ kind: 'text', text: JSON.stringify(frame) })),
      closers: [],
      sent: [],
      alive: true,
    };
    this.streams.push(stream);
    const position = new Map(request.query ?? []);
    const rev = Number(position.get('rev'));
    if (position.get('generation') === G && rev <= this.history.length) {
      for (const [index, entry] of this.history.slice(rev).entries())
        stream.deliver({
          kind: 'edit',
          ...(entry.id === undefined ? {} : { id: entry.id }),
          applied: this.applied(entry.op, rev + index + 1),
          epoch: 0,
          rev: rev + index + 1,
        });
    } else
      stream.deliver({
        kind: 'snapshot',
        snapshot: {
          v: 1,
          sessionId: 'sess one',
          generation: G,
          epoch: 0,
          rev: this.history.length,
          text: this.text,
          items: [],
          updatedAt: AT,
        },
      });
    stream.deliver({ kind: 'ready' });
    const session = {
      sendStream: (frame: { kind: string; text?: string }) => this.receive(stream, frame.text ?? ''),
      closeStream: (code: number) => {
        stream.closedBy = code;
        this.drop(stream);
      },
      onStreamClosed: (listener: (closed: { code: number; reason: string }) => void) => stream.closers.push(listener),
    };
    return session as unknown as RelayClientSession;
  };

  /** The daemon (or the network) ends a stream from its side. */
  kill(stream: FakeStream): void {
    this.drop(stream);
    for (const closer of stream.closers) closer({ code: 1006, reason: 'gone' });
  }

  drop(stream: FakeStream): void {
    if (!stream.alive) return;
    stream.alive = false;
    for (const other of this.streams) if (other.alive) other.deliver({ kind: 'left', peer: stream.peer });
  }

  private applied(op: TextOp, rev: number) {
    return { generation: G, epoch: 0, rev, text: op, add: [], remove: [] };
  }

  private receive(stream: FakeStream, text: string): void {
    const frame = SharedDraftClientFrameSchema.parse(JSON.parse(text));
    stream.sent.push(frame);
    if (frame.kind === 'presence') {
      for (const other of this.streams)
        if (other !== stream && other.alive)
          other.deliver({ kind: 'presence', peer: stream.peer, device: stream.device, typing: frame.typing });
      return;
    }
    if (this.refuseNext || frame.edit.generation !== G || frame.edit.base > this.history.length) {
      this.refuseNext = false;
      stream.deliver({ kind: 'error', id: frame.id, code: 'shared_draft_stale', message: 'read it again' });
      return;
    }
    let op = frame.edit.text ?? [this.text.length];
    for (const entry of this.history.slice(frame.edit.base)) op = transformTextOps(entry.op, op)[1];
    op = normalizeTextOp(op);
    this.text = applyTextOp(this.text, op);
    this.history.push({ op, id: frame.id });
    const rev = this.history.length;
    for (const other of this.streams)
      if (other.alive)
        other.deliver(
          other === stream
            ? { kind: 'ack', id: frame.id, applied: this.applied(op, rev), epoch: 0, rev }
            : { kind: 'edit', id: frame.id, applied: this.applied(op, rev), epoch: 0, rev },
        );
  }
}

/** A clock and timers a test moves by hand. */
class ManualTimers implements SharedDraftTimers {
  clock = 1_000;
  private pending: { at: number; action: () => void; cancelled: boolean }[] = [];
  readonly now = () => this.clock;
  readonly after = (milliseconds: number, action: () => void) => {
    const entry = { at: this.clock + milliseconds, action, cancelled: false };
    this.pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  advance(milliseconds: number): void {
    this.clock += milliseconds;
    const due = this.pending.filter(entry => entry.at <= this.clock && !entry.cancelled);
    this.pending = this.pending.filter(entry => !due.includes(entry));
    for (const entry of due) entry.action();
  }
}

const settle = async (): Promise<void> =>
  await runAsync(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });

/** Two composers, each its own React tree with its own `draft` state, on one fake daemon. */
const mountDevices = (
  daemonSide: FakeDaemon,
  initial: Readonly<Record<string, string>>,
  options: { readonly open?: DaemonStreamOpener | null } = {},
) => {
  const timers = new ManualTimers();
  const hooks: Record<string, SharedDraft> = {};
  const texts: Record<string, string> = {};
  const setters: Record<string, (text: string) => void> = {};
  const remote: Record<string, TextOp[]> = {};
  const roots = Object.entries(initial).map(([name, text]) => {
    let id = 0;
    const ids = () => `${name}-${++id}`;
    const Device = () => {
      const [draft, setDraft] = useState(text);
      texts[name] = draft;
      setters[name] = setDraft;
      hooks[name] = useSharedDraft({
        daemon,
        scope,
        text: draft,
        setText: setDraft,
        onRemote: op => {
          remote[name] = [...(remote[name] ?? []), op];
        },
        ...(options.open === null ? {} : { open: options.open ?? daemonSide.open }),
        timers,
        ids,
      });
      return null;
    };
    return render(<Device />);
  });
  return {
    timers,
    hooks,
    texts,
    remote,
    type: (name: string, text: string) => run(() => setters[name]?.(text)),
    unmount: () =>
      run(() => {
        for (const root of roots) root.unmount();
      }),
  };
};

describe('useSharedDraft', () => {
  test('what the phone types appears on the laptop, with a hint saying where it is being typed', async () => {
    // Arrange
    const daemonSide = new FakeDaemon();
    daemonSide.devices = ['Kirin’s iPhone', 'Desktop (Chrome)'];
    const devices = mountDevices(daemonSide, { phone: '', laptop: '' });
    await settle();

    // Act
    devices.type('phone', 'grab the error screenshot');
    await settle();

    // Assert
    expect(devices.texts.laptop).toBe('grab the error screenshot');
    expect(devices.remote.laptop).toEqual([['grab the error screenshot']]);
    expect(devices.hooks.laptop?.live).toBe(true);
    expect(sharedDraftTypingHint(devices.hooks.laptop?.typing ?? [])).toBe('also typing on Kirin’s iPhone');
    expect(devices.hooks.phone?.typing).toEqual([]);

    // The hint lets go once the phone has been quiet long enough.
    run(() => devices.timers.advance(6_000));
    await settle();
    expect(devices.hooks.laptop?.typing).toEqual([]);
    devices.unmount();
  });

  test('both typing at once end on the same words', async () => {
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { phone: '', laptop: '' });
    await settle();
    devices.type('phone', 'hello');
    await settle();

    devices.type('phone', 'hello world');
    devices.type('laptop', 'oh hello');
    await settle();

    expect(devices.texts.phone).toBe(daemonSide.text);
    expect(devices.texts.laptop).toBe(daemonSide.text);
    expect(daemonSide.text).toBe('oh hello world');
    devices.unmount();
  });

  test('a send empties the draft on every device', async () => {
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { phone: '', laptop: '' });
    await settle();
    devices.type('laptop', 'ship it');
    await settle();

    run(() => devices.hooks.laptop?.sent());
    await settle();

    expect(devices.texts.phone).toBe('');
    expect(daemonSide.streams[1]?.sent.at(-2)).toMatchObject({ kind: 'edit', edit: { sent: true } });
    devices.unmount();
  });

  test('a phone that drops off catches up on what it missed, and its own edit is not sent twice', async () => {
    // Arrange
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { phone: '', laptop: '' });
    await settle();
    devices.type('phone', 'on the train');
    await settle();
    const first = daemonSide.streams[0] as FakeStream;

    // Act — the phone loses its stream; the laptop keeps typing; the phone comes back.
    daemonSide.kill(first);
    await settle();
    expect(devices.hooks.phone?.live).toBe(false);
    devices.type('laptop', 'on the train, then the office');
    await settle();
    run(() => devices.timers.advance(1_000));
    await settle();

    // Assert — caught up edit by edit (no second snapshot), on the same words as the daemon.
    expect(devices.hooks.phone?.live).toBe(true);
    expect(devices.texts.phone).toBe('on the train, then the office');
    expect(daemonSide.history).toHaveLength(2);
    devices.unmount();
  });

  test('an edit in flight when the stream dropped is sent again on the new stream, once', async () => {
    // Arrange — the phone's edit goes up, but the stream dies before anything comes back.
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { phone: '' });
    await settle();
    const first = daemonSide.streams[0] as FakeStream;
    first.alive = false;
    devices.type('phone', 'lost in a tunnel');
    await settle();

    // Act
    daemonSide.kill(first);
    await settle();
    run(() => devices.timers.advance(1_000));
    await settle();

    // Assert
    expect(daemonSide.text).toBe('lost in a tunnel');
    expect(daemonSide.history).toHaveLength(1);
    devices.unmount();
  });

  test('offers back words that could not be merged, added to what is there when restored', async () => {
    // Arrange — the daemon already holds the phone's words; the laptop still holds old local ones.
    const daemonSide = new FakeDaemon();
    daemonSide.text = 'from the phone';
    daemonSide.history.push({ op: ['from the phone'] });
    const devices = mountDevices(daemonSide, { laptop: 'old laptop draft' });
    await settle();
    expect(devices.texts.laptop).toBe('from the phone');
    expect(devices.hooks.laptop?.conflict).toBe('old laptop draft');

    // Act
    run(() => devices.hooks.laptop?.restoreConflict());
    await settle();

    // Assert
    expect(devices.hooks.laptop?.conflict).toBeNull();
    expect(daemonSide.text).toBe('from the phone\nold laptop draft');
    run(() => devices.hooks.laptop?.restoreConflict());
    devices.unmount();
  });

  test('dismisses an offer without touching the draft', async () => {
    const daemonSide = new FakeDaemon();
    daemonSide.text = 'theirs';
    daemonSide.history.push({ op: ['theirs'] });
    const devices = mountDevices(daemonSide, { laptop: 'mine' });
    await settle();
    run(() => devices.hooks.laptop?.dismissConflict());
    expect(devices.hooks.laptop?.conflict).toBeNull();
    expect(daemonSide.text).toBe('theirs');
    devices.unmount();
  });

  test('a refused edit makes the composer start again from the whole draft', async () => {
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { phone: '' });
    await settle();
    daemonSide.refuseNext = true;
    devices.type('phone', 'refused');
    await settle();
    run(() => devices.timers.advance(1_000));
    await settle();
    expect(devices.hooks.phone?.conflict).toBe('refused');
    expect(daemonSide.streams.at(-1)?.alive).toBe(true);
    devices.unmount();
  });

  test('without a carrier the composer stays its own, and keeps trying with a growing wait', async () => {
    let attempts = 0;
    const devices = mountDevices(
      new FakeDaemon(),
      { phone: 'local only' },
      {
        open: async () => {
          attempts += 1;
          throw new Error('no carrier');
        },
      },
    );
    await settle();
    devices.type('phone', 'still local');
    run(() => devices.timers.advance(1_000));
    await settle();
    run(() => devices.timers.advance(1_999));
    await settle();
    expect(attempts).toBe(2);
    run(() => devices.timers.advance(1));
    await settle();
    expect(attempts).toBe(3);
    expect(devices.texts.phone).toBe('still local');
    expect(devices.hooks.phone?.live).toBe(false);
    devices.unmount();
  });

  test('with no store at all the composer simply stays local', async () => {
    const devices = mountDevices(new FakeDaemon(), { phone: 'no store' }, { open: null });
    await settle();
    expect(devices.hooks.phone?.live).toBe(false);
    run(() => devices.hooks.phone?.sent());
    devices.unmount();
  });

  test('a composer that goes away while its stream is still opening closes it the moment it opens', async () => {
    // Arrange — an open that waits until the test lets it finish.
    const daemonSide = new FakeDaemon();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const devices = mountDevices(
      daemonSide,
      { phone: '' },
      {
        open: async (target, request) => {
          await gate;
          return await daemonSide.open(target, request);
        },
      },
    );

    // Act
    devices.unmount();
    release?.();
    await settle();

    // Assert
    expect(daemonSide.streams[0]?.closedBy).toBe(1000);
  });

  test('runs on the browser clock when none is given', async () => {
    const daemonSide = new FakeDaemon();
    let setDraft: ((text: string) => void) | undefined;
    const Device = () => {
      const [draft, set] = useState('');
      setDraft = set;
      useSharedDraft({ daemon, scope, text: draft, setText: set, open: daemonSide.open });
      return null;
    };
    const root = render(<Device />);
    await settle();
    run(() => setDraft?.('typed'));
    await settle();
    expect(daemonSide.text).toBe('typed');
    run(() => root.unmount());
  });

  test('a stream the daemon closes for a frame too big is reopened without a position, for the whole draft', async () => {
    const daemonSide = new FakeDaemon();
    const queries: (readonly (readonly [string, string])[] | undefined)[] = [];
    const watching: DaemonStreamOpener = async (target, request) => {
      queries.push(request.query);
      return await daemonSide.open(target, request);
    };
    const devices = mountDevices(daemonSide, { phone: '' }, { open: watching });
    await settle();
    devices.type('phone', 'x');
    await settle();
    const first = daemonSide.streams[0] as FakeStream;
    daemonSide.drop(first);
    for (const closer of first.closers) closer({ code: SHARED_DRAFT_STREAM_RESYNC_CLOSE, reason: 'too large' });
    await settle();
    run(() => devices.timers.advance(1_000));
    await settle();
    expect(queries).toHaveLength(2);
    expect(queries[1]).toBeUndefined();
    devices.unmount();
  });

  test('a composer that goes away closes its stream and opens nothing more', async () => {
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { phone: '' });
    await settle();
    devices.unmount();
    expect(daemonSide.streams[0]?.closedBy).toBe(1000);
  });
});

/** One id for every edit: stable across renders, as the hook's inputs must be. */
const fixedId = () => 'x';

describe('switching sessions (review M1)', () => {
  test("the stream of the session just left never writes into the next session's composer", async () => {
    // Arrange — session A's stream is slow to open (a relay), and can answer before it settles.
    const daemonB = new FakeDaemon();
    daemonB.text = 'words for B';
    daemonB.history.push({ op: ['words for B'] });
    daemonB.devices = ['Laptop', 'Kirin’s iPhone'];
    let answerA: RelayStreamRequest['onData'] | undefined;
    let settleA: (() => void) | undefined;
    const closedA: number[] = [];
    const open: DaemonStreamOpener = async (target, request) => {
      if (request.path.includes('/sess%20A/')) {
        answerA = request.onData;
        await new Promise<void>(resolve => {
          settleA = resolve;
        });
        return {
          sendStream: () => undefined,
          closeStream: (code: number) => closedA.push(code),
          onStreamClosed: () => undefined,
        } as unknown as RelayClientSession;
      }
      return await daemonB.open(target, request);
    };
    const timers = new ManualTimers();
    const seen: { text?: string; hook?: SharedDraft; switchTo?: (id: string) => void } = {};
    const Composer = () => {
      const [sessionId, setSession] = useState('sess A');
      const [draft, setDraft] = useState('');
      const scope = useMemo(() => daemonSessionScope(daemon, sessionId), [sessionId]);
      seen.text = draft;
      seen.switchTo = setSession;
      seen.hook = useSharedDraft({ daemon, scope, text: draft, setText: setDraft, open, timers, ids: fixedId });
      return null;
    };
    const root = render(<Composer />);
    await settle();

    // Act — the person moves to B; B's stream opens, and another device is typing there.
    run(() => seen.switchTo?.('sess one'));
    await settle();
    run(() => daemonB.streams[0]?.deliver({ kind: 'presence', peer: 'p', device: 'Kirin’s iPhone', typing: true }));
    await settle();
    expect(seen.text).toBe('words for B');
    expect(seen.hook?.live).toBe(true);

    // A's stream answers late, then its open settles.
    run(() =>
      answerA?.({
        kind: 'text',
        text: JSON.stringify({
          kind: 'snapshot',
          snapshot: {
            v: 1,
            sessionId: 'sess A',
            generation: 'gA',
            epoch: 0,
            rev: 3,
            text: 'words meant for session A',
            items: [],
            updatedAt: AT,
          },
        }),
      }),
    );
    await settle();
    settleA?.();
    await settle();

    // Assert — B's composer is untouched: its words, its stream, its peers.
    expect(seen.text).toBe('words for B');
    expect(seen.hook?.live).toBe(true);
    expect(seen.hook?.typing.map(peer => peer.device)).toEqual(['Kirin’s iPhone']);
    expect(seen.hook?.conflict).toBeNull();
    expect(daemonB.text).toBe('words for B');
    // And A's stream, once it opened, was closed as left.
    expect(closedA).toEqual([1000]);
    run(() => root.unmount());
  });

  test('refuses a snapshot that names another session', async () => {
    const daemonSide = new FakeDaemon();
    const wrong: DaemonStreamOpener = async (target, request) => {
      const session = await daemonSide.open(target, request);
      queueMicrotask(() =>
        request.onData({
          kind: 'text',
          text: JSON.stringify({
            kind: 'snapshot',
            snapshot: {
              v: 1,
              sessionId: 'someone else',
              generation: G,
              epoch: 0,
              rev: 0,
              text: 'not yours',
              items: [],
              updatedAt: AT,
            },
          }),
        }),
      );
      return session;
    };
    const devices = mountDevices(daemonSide, { phone: 'mine' }, { open: wrong });
    await settle();
    await settle();
    expect(devices.texts.phone).not.toBe('not yours');
    devices.unmount();
  });
});

describe('sharedDraftTypingHint', () => {
  const peer = (device: string) => ({ peer: device, device, typing: true, seenAt: 0 });
  test('names one device, or several, once each', () => {
    expect(sharedDraftTypingHint([])).toBeNull();
    expect(sharedDraftTypingHint([peer('Phone'), peer('Phone')])).toBe('also typing on Phone');
    expect(sharedDraftTypingHint([peer('Phone'), peer('Tablet'), peer('Desktop')])).toBe(
      'also typing on Phone, Tablet and Desktop',
    );
  });
});

describe('openSharedDraftStream', () => {
  const fakeSession = () => {
    const closed: number[] = [];
    let listener: ((closed: { code: number; reason: string }) => void) | undefined;
    const session = {
      sendStream: () => undefined,
      closeStream: (code: number) => closed.push(code),
      onStreamClosed: (next: typeof listener) => {
        listener = next;
      },
    };
    return {
      session: session as unknown as RelayClientSession,
      closed,
      end: () => listener?.({ code: 1011, reason: 'x' }),
    };
  };

  test('asks for the session’s own stream, with the position when it has one', async () => {
    const requests: RelayStreamRequest[] = [];
    const { session } = fakeSession();
    await openSharedDraftStream(
      async (_d, request) => {
        requests.push(request);
        return session;
      },
      daemon,
      scope,
      { generation: G, epoch: 2, rev: 7 },
      { onFrame: () => undefined, onClosed: () => undefined },
    );
    expect(sharedDraftStreamPath(scope)).toBe('/v1/sessions/sess%20one/shared-draft/stream');
    expect(requests[0]?.path).toBe('/v1/sessions/sess%20one/shared-draft/stream');
    expect(requests[0]?.query).toEqual([
      ['generation', G],
      ['epoch', '2'],
      ['rev', '7'],
    ]);
  });

  test('ends the stream on a frame it cannot read, even one that arrives before the open settles', async () => {
    const { session, closed } = fakeSession();
    const ended: number[] = [];
    await openSharedDraftStream(
      async (_d, request) => {
        request.onData({ kind: 'text', text: '{"kind":"nonsense"}' });
        request.onData({ kind: 'text', text: '{"kind":"ready"}' });
        return session;
      },
      daemon,
      scope,
      undefined,
      { onFrame: () => undefined, onClosed: code => ended.push(code) },
    );
    expect(closed).toEqual([1003]);
    expect(ended).toEqual([1003]);
  });

  test('ends on bytes and on text that is not JSON, reports the daemon closing once, and sends nothing after', async () => {
    const one = fakeSession();
    const two = fakeSession();
    const ended: number[] = [];
    const handlers = { onFrame: () => undefined, onClosed: (code: number) => ended.push(code) };
    let deliver: RelayStreamRequest['onData'] | undefined;
    await openSharedDraftStream(
      async (_d, request) => {
        deliver = request.onData;
        return one.session;
      },
      daemon,
      scope,
      undefined,
      handlers,
    );
    deliver?.({ kind: 'bytes', bytes: new Uint8Array([1]) });
    const link = await openSharedDraftStream(
      async (_d, request) => {
        deliver = request.onData;
        return two.session;
      },
      daemon,
      scope,
      undefined,
      handlers,
    );
    two.end();
    two.end();
    const three = fakeSession();
    await openSharedDraftStream(
      async (_d, request) => {
        request.onData({ kind: 'text', text: 'not json' });
        return three.session;
      },
      daemon,
      scope,
      undefined,
      handlers,
    );
    link.send({ kind: 'presence', typing: true });
    link.close();
    expect(ended).toEqual([1003, 1011, 1003]);
  });

  test('puts a draft sent in parts back together before the composer sees it', async () => {
    const { session } = fakeSession();
    const frames: SharedDraftServerFrame[] = [];
    let deliver: RelayStreamRequest['onData'] | undefined;
    await openSharedDraftStream(
      async (_d, request) => {
        deliver = request.onData;
        return session;
      },
      daemon,
      scope,
      undefined,
      { onFrame: frame => frames.push(frame), onClosed: () => undefined },
    );
    const text = (frame: object) => deliver?.({ kind: 'text', text: JSON.stringify(frame) });
    text({
      kind: 'snapshot',
      snapshot: { v: 1, sessionId: 'sess one', generation: G, epoch: 0, rev: 1, text: 'ab', items: [], updatedAt: AT },
      more: 2,
    });
    text({ kind: 'snapshot-text', text: 'cd' });
    expect(frames).toEqual([]);
    text({ kind: 'snapshot-text', text: 'ef' });
    text({ kind: 'ready' });
    expect(frames).toEqual([
      {
        kind: 'snapshot',
        snapshot: {
          v: 1,
          sessionId: 'sess one',
          generation: G,
          epoch: 0,
          rev: 1,
          text: 'abcdef',
          items: [],
          updatedAt: AT,
        },
      },
      { kind: 'ready' },
    ]);
  });

  test('ends the stream on a part out of place: a part with no draft, or another frame inside one', async () => {
    const ended: number[] = [];
    for (const sequence of [
      [{ kind: 'snapshot-text', text: 'x' }],
      [
        {
          kind: 'snapshot',
          snapshot: {
            v: 1,
            sessionId: 'sess one',
            generation: G,
            epoch: 0,
            rev: 1,
            text: 'a',
            items: [],
            updatedAt: AT,
          },
          more: 1,
        },
        { kind: 'ready' },
      ],
    ]) {
      await openSharedDraftStream(
        async (_d, request) => {
          for (const frame of sequence) request.onData({ kind: 'text', text: JSON.stringify(frame) });
          return fakeSession().session;
        },
        daemon,
        scope,
        undefined,
        { onFrame: () => undefined, onClosed: code => ended.push(code) },
      );
    }
    expect(ended).toEqual([1003, 1003]);
  });

  test('refuses a scope from another daemon', async () => {
    const other = daemonConnection({ daemonId: 'other', baseUrl: 'https://o.example.test', deviceId: 'd' });
    await expect(
      openSharedDraftStream(async () => fakeSession().session, other, scope, undefined, {
        onFrame: () => undefined,
        onClosed: () => undefined,
      }),
    ).rejects.toThrow('draft scope must belong to the requested daemon');
  });
});
