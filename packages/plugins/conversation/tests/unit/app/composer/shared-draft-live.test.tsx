import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import {
  applyTextOp,
  normalizeTextOp,
  DRAFT_STREAM_RESYNC_CLOSE,
  type DraftClientFrame,
  DraftClientFrameSchema,
  type DraftItem,
  type DraftSent,
  type DraftServerFrame,
  type TextOp,
  transformTextOps,
} from '../../../../contract/index.ts';
import { useMemo, useState } from 'react';
import {
  type SharedDraft,
  type SharedDraftSendMark,
  type SharedDraftTimers,
  sharedDraftTypingHint,
  useSharedDraft,
} from '../../../../app/composer/use-shared-draft.ts';
import { ensureDom, render, run, runAsync } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { DaemonDraftStore } from '../../../../app/composer/drafts.ts';
import { daemonConnection, daemonFerretScope } from '../../../../app/composer/seam.ts';
import { openSharedDraftStream, SHARED_DRAFT_STREAM_ROUTE } from '../../../../app/composer/shared-draft-stream.ts';

ensureDom();

/**
 * The stream as these suites drive it: one open per call, answered synchronously, as the half's client socket is.
 * `clientOf` puts it behind `PluginClient.socket`; a close the composer makes is the socket's `close()`, and a close
 * the daemon makes reaches the composer as a reason that starts with its code (`./seam-drafts.ts`).
 */
interface StreamRequest {
  readonly ferretId: string;
  readonly onData: (
    data: { readonly kind: 'text'; readonly text: string } | { readonly kind: 'bytes'; readonly bytes: Uint8Array },
  ) => void;
}
interface StreamSession {
  sendStream(frame: { readonly kind: string; readonly text?: string }): void;
  closeStream(code: number): void;
  onStreamClosed(listener: (closed: { code: number; reason: string }) => void): void;
}
type DaemonStreamOpener = (request: StreamRequest) => StreamSession;

const clientOf = (open: DaemonStreamOpener, keys: string[] = []): Pick<PluginClient, 'socket'> => ({
  socket: (key, params, listeners) => {
    keys.push(key);
    const session = open({
      ferretId: params.ferretId ?? '',
      onData: data => listeners.onFrame(data.kind === 'text' ? data.text : data.bytes),
    });
    session.onStreamClosed(closed => listeners.onClose(`${closed.code} ${closed.reason}`));
    return {
      send: frame => session.sendStream({ kind: 'text', text: String(frame) }),
      close: () => session.closeStream(1000),
    };
  },
});

const daemon = daemonConnection('live');
const scope = daemonFerretScope(daemon, 'sess-one');
const G = 'gen-1';
const AT = '2026-11-01T00:00:00.000Z' as Instant;

interface FakeStream {
  readonly peer: string;
  readonly device: string;
  readonly deliver: (frame: DraftServerFrame) => void;
  readonly closers: ((closed: { code: number; reason: string }) => void)[];
  readonly sent: DraftClientFrame[];
  alive: boolean;
  closedBy?: number;
}

/**
 * The daemon's side of the stream, restated: one sequencer, a replay for a reconnect, presence for the
 * others. Frames go down asynchronously, as they would over a socket.
 */
class FakeDaemon {
  text = '';
  epoch = 0;
  items: DraftItem[] = [];
  readonly history: { op: TextOp; id?: string }[] = [];
  readonly streams: FakeStream[] = [];
  devices: string[] = [];
  refuseNext = false;

  readonly open: DaemonStreamOpener = (request: StreamRequest) => {
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
    // GAP(app-shell): the client socket carries no position, so every stream starts from the whole draft.
    stream.deliver({
      kind: 'snapshot',
      snapshot: {
        v: 1,
        ferret: 'sess-one' as FerretId,
        generation: G,
        epoch: this.epoch,
        rev: this.history.length,
        text: this.text,
        items: this.items,
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
    return session;
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

  private applied(op: TextOp, rev: number, add: readonly DraftItem[] = [], remove: readonly string[] = []) {
    return { generation: G, epoch: 0, rev, text: op, add, remove };
  }

  private receive(stream: FakeStream, text: string): void {
    const frame = DraftClientFrameSchema.parse(JSON.parse(text));
    stream.sent.push(frame);
    if (frame.kind === 'presence') {
      for (const other of this.streams)
        if (other !== stream && other.alive)
          other.deliver({
            kind: 'presence',
            peer: stream.peer,
            device: stream.device,
            typing: frame.typing,
            ...(frame.uploading === undefined ? {} : { uploading: frame.uploading }),
          });
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
    // The daemon's own item rule: remove first, then add what is not already there.
    const removing = frame.edit.remove ?? [];
    const remove = this.items.filter(item => removing.includes(item.id)).map(item => item.id);
    this.items = this.items.filter(item => !removing.includes(item.id));
    const add = (frame.edit.add ?? []).filter(item => !this.items.some(existing => existing.id === item.id));
    this.items = [...this.items, ...add];
    this.history.push({ op, id: frame.id });
    const rev = this.history.length;
    const applied = this.applied(op, rev, add, remove);
    for (const other of this.streams)
      if (other.alive)
        other.deliver(
          other === stream
            ? { kind: 'ack', id: frame.id, applied, epoch: 0, rev }
            : { kind: 'edit', id: frame.id, applied, epoch: 0, rev },
        );
  }
}

/** One device's browser storage. */
class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
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
  options: {
    readonly open?: DaemonStreamOpener | null;
    /** Each device's own browser storage for words waiting to be restored; fresh ones unless given. */
    readonly restore?: Readonly<Record<string, DaemonDraftStore>>;
  } = {},
) => {
  const timers = new ManualTimers();
  const restores: Record<string, DaemonDraftStore> = {};
  const hooks: Record<string, SharedDraft> = {};
  const texts: Record<string, string> = {};
  const setters: Record<string, (text: string) => void> = {};
  const remote: Record<string, TextOp[]> = {};
  const roots = Object.entries(initial).map(([name, text]) => {
    let id = 0;
    const ids = () => `${name}-${++id}`;
    const restoreStore = options.restore?.[name] ?? new DaemonDraftStore(new MemoryStorage(), 'restore');
    restores[name] = restoreStore;
    // One client per device for its life, as the half hands one to every surface: `null` is a client with no socket.
    const client = options.open === null ? {} : clientOf(options.open ?? daemonSide.open);
    const Device = () => {
      const [draft, setDraft] = useState(text);
      texts[name] = draft;
      setters[name] = setDraft;
      hooks[name] = useSharedDraft({
        client,
        scope,
        text: draft,
        setText: setDraft,
        onRemote: op => {
          remote[name] = [...(remote[name] ?? []), op];
        },
        timers,
        ids,
        restoreStore,
      });
      return null;
    };
    return render(<Device />);
  });
  return {
    restores,
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

    run(() => {
      const hook = devices.hooks.laptop;
      if (hook !== undefined) hook.sent(hook.markSend());
    });
    await settle();

    expect(devices.texts.phone).toBe('');
    expect(daemonSide.streams[1]?.sent.filter(frame => frame.kind === 'edit').at(-1)).toMatchObject({
      kind: 'edit',
      edit: { sent: true },
    });
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
        open: () => {
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

  test('with a client that opens no socket the composer simply stays local', async () => {
    const devices = mountDevices(new FakeDaemon(), { phone: 'no store' }, { open: null });
    await settle();
    expect(devices.hooks.phone?.live).toBe(false);
    run(() => {
      const hook = devices.hooks.phone;
      if (hook !== undefined) hook.sent(hook.markSend());
    });
    devices.unmount();
  });

  test('runs on the browser clock when none is given', async () => {
    const daemonSide = new FakeDaemon();
    const client = clientOf(daemonSide.open);
    let setDraft: ((text: string) => void) | undefined;
    const Device = () => {
      const [draft, set] = useState('');
      setDraft = set;
      useSharedDraft({ client, scope, text: draft, setText: set });
      return null;
    };
    const root = render(<Device />);
    await settle();
    run(() => setDraft?.('typed'));
    await settle();
    expect(daemonSide.text).toBe('typed');
    run(() => root.unmount());
  });

  test('a stream the daemon closes for a frame too big is reopened for the whole draft', async () => {
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { phone: '' });
    await settle();
    devices.type('phone', 'x');
    await settle();
    const first = daemonSide.streams[0] as FakeStream;
    daemonSide.drop(first);
    for (const closer of first.closers) closer({ code: DRAFT_STREAM_RESYNC_CLOSE, reason: 'too large' });
    await settle();
    run(() => devices.timers.advance(1_000));
    await settle();
    expect(daemonSide.streams).toHaveLength(2);
    expect(daemonSide.streams[1]?.alive).toBe(true);
    expect(devices.texts.phone).toBe(daemonSide.text);
    devices.unmount();
  });

  test('a file attached on the phone shows on the laptop, a removal anywhere goes everywhere, and a send clears them', async () => {
    // Arrange
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { phone: '', laptop: '' });
    await settle();
    const shot = { kind: 'attachment' as const, id: 'att_1', name: 'login-error.png', mime: 'image/png', bytes: 412 };
    const pdf = { kind: 'attachment' as const, id: 'att_2', name: 'auth-flow.pdf', mime: 'application/pdf', bytes: 9 };

    // Act / Assert — attached on the phone.
    run(() => devices.hooks.phone?.changeItems({ add: [shot] }));
    await settle();
    expect(devices.hooks.laptop?.items).toEqual([shot]);

    // The laptop adds one and removes the phone's.
    run(() => devices.hooks.laptop?.changeItems({ add: [pdf], remove: ['att_1'] }));
    await settle();
    expect(devices.hooks.phone?.items).toEqual([pdf]);
    expect(daemonSide.items).toEqual([pdf]);

    // A send from the phone takes the words and the files with it, everywhere.
    devices.type('phone', 'see attached');
    await settle();
    run(() => {
      const hook = devices.hooks.phone;
      if (hook !== undefined) hook.sent(hook.markSend());
    });
    await settle();
    expect(devices.hooks.laptop?.items).toEqual([]);
    expect(devices.texts.laptop).toBe('');
    devices.unmount();
  });

  test('the laptop sees what the phone is still uploading, and that list follows it to a new stream', async () => {
    // Arrange
    const daemonSide = new FakeDaemon();
    daemonSide.devices = ['Kirin’s iPhone', 'Desktop (Chrome)'];
    const devices = mountDevices(daemonSide, { phone: '', laptop: '' });
    await settle();

    // Act — the phone starts an upload; telling again with the same names says nothing new.
    run(() => devices.hooks.phone?.reportUploading(['network-trace.png']));
    run(() => devices.hooks.phone?.reportUploading(['network-trace.png']));
    await settle();

    // Assert
    expect(devices.hooks.laptop?.uploads).toEqual([{ device: 'Kirin’s iPhone', name: 'network-trace.png' }]);
    const phoneStream = daemonSide.streams[0] as FakeStream;
    expect(phoneStream.sent.filter(frame => frame.kind === 'presence')).toHaveLength(1);

    // The phone's stream drops and comes back: the laptop hears about the upload again.
    daemonSide.kill(phoneStream);
    await settle();
    run(() => devices.timers.advance(1_000));
    await settle();
    expect(daemonSide.streams[2]?.sent.at(-1)).toMatchObject({ kind: 'presence', uploading: ['network-trace.png'] });

    // Finished: the placeholder goes, once the presence gap has passed.
    run(() => devices.hooks.phone?.reportUploading([]));
    run(() => devices.timers.advance(350));
    await settle();
    expect(devices.hooks.laptop?.uploads).toEqual([]);
    devices.unmount();
  });

  test('L3: a burst of upload changes never leaves a stale placeholder: the last word always arrives', async () => {
    // Arrange
    const daemonSide = new FakeDaemon();
    daemonSide.devices = ['Kirin’s iPhone', 'Desktop (Chrome)'];
    const devices = mountDevices(daemonSide, { phone: '', laptop: '' });
    await settle();

    // Act — three files start and finish inside a third of a second.
    for (const names of [['a.png'], ['a.png', 'b.png'], ['b.png'], []])
      run(() => devices.hooks.phone?.reportUploading(names));
    await settle();
    const phoneStream = daemonSide.streams[0] as FakeStream;
    const sentNow = phoneStream.sent.filter(frame => frame.kind === 'presence').length;
    run(() => devices.timers.advance(350));
    await settle();

    // Assert — one report then, one after the gap with how things stand: nothing uploading.
    expect(sentNow).toBe(1);
    expect(phoneStream.sent.filter(frame => frame.kind === 'presence')).toHaveLength(2);
    expect(devices.hooks.laptop?.uploads).toEqual([]);
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

describe('switching ferrets (review M1)', () => {
  test("the stream of the ferret just left never writes into the next ferret's composer", async () => {
    // Arrange — ferret A's stream stays open, and can still answer after the person has moved on.
    const daemonB = new FakeDaemon();
    daemonB.text = 'words for B';
    daemonB.history.push({ op: ['words for B'] });
    daemonB.devices = ['Laptop', 'Kirin’s iPhone'];
    let answerA: StreamRequest['onData'] | undefined;
    const closedA: number[] = [];
    const client = clientOf(request => {
      if (request.ferretId === 'sess-A') {
        answerA = request.onData;
        return {
          sendStream: () => undefined,
          closeStream: (code: number) => closedA.push(code),
          onStreamClosed: () => undefined,
        };
      }
      return daemonB.open(request);
    });
    const timers = new ManualTimers();
    const seen: { text?: string; hook?: SharedDraft; switchTo?: (id: string) => void } = {};
    const Composer = () => {
      const [ferretId, setFerret] = useState('sess-A');
      const [draft, setDraft] = useState('');
      const scope = useMemo(() => daemonFerretScope(daemon, ferretId), [ferretId]);
      seen.text = draft;
      seen.switchTo = setFerret;
      seen.hook = useSharedDraft({ client, scope, text: draft, setText: setDraft, timers, ids: fixedId });
      return null;
    };
    const root = render(<Composer />);
    await settle();

    // Act — the person moves to B; B's stream opens, and another device is typing there.
    run(() => seen.switchTo?.('sess-one'));
    await settle();
    run(() => daemonB.streams[0]?.deliver({ kind: 'presence', peer: 'p', device: 'Kirin’s iPhone', typing: true }));
    await settle();
    expect(seen.text).toBe('words for B');
    expect(seen.hook?.live).toBe(true);

    // A's stream answers late.
    run(() =>
      answerA?.({
        kind: 'text',
        text: JSON.stringify({
          kind: 'snapshot',
          snapshot: {
            v: 1,
            ferret: 'sess-A' as FerretId,
            generation: 'gA',
            epoch: 0,
            rev: 3,
            text: 'words meant for ferret A',
            items: [],
            updatedAt: AT,
          },
        }),
      }),
    );
    await settle();

    // Assert — B's composer is untouched: its words, its stream, its peers.
    expect(seen.text).toBe('words for B');
    expect(seen.hook?.live).toBe(true);
    expect(seen.hook?.typing.map(peer => peer.device)).toEqual(['Kirin’s iPhone']);
    expect(seen.hook?.conflict).toBeNull();
    expect(daemonB.text).toBe('words for B');
    // And A's stream was closed as left when the person moved on.
    expect(closedA).toEqual([1000]);
    run(() => root.unmount());
  });

  test('refuses a snapshot that names another ferret', async () => {
    const daemonSide = new FakeDaemon();
    const wrong: DaemonStreamOpener = request => {
      const session = daemonSide.open(request);
      queueMicrotask(() =>
        request.onData({
          kind: 'text',
          text: JSON.stringify({
            kind: 'snapshot',
            snapshot: {
              v: 1,
              ferret: 'someone-else' as FerretId,
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
  const peer = (device: string) => ({ peer: device, device, typing: true, uploading: [], seenAt: 0 });
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
    const session: StreamSession = {
      sendStream: () => undefined,
      closeStream: (code: number) => closed.push(code),
      onStreamClosed: next => {
        listener = next;
      },
    };
    return { session, closed, end: () => listener?.({ code: 1011, reason: 'x' }) };
  };

  test('asks for the ferret’s own stream, by its route key and id', async () => {
    const keys: string[] = [];
    const requests: StreamRequest[] = [];
    const { session } = fakeSession();
    await openSharedDraftStream(
      clientOf(request => {
        requests.push(request);
        return session;
      }, keys),
      scope,
      { generation: G, epoch: 2, rev: 7 },
      { onFrame: () => undefined, onClosed: () => undefined },
    );
    expect(keys).toEqual([SHARED_DRAFT_STREAM_ROUTE]);
    expect(SHARED_DRAFT_STREAM_ROUTE).toBe('GET /v1/ferrets/:ferretId/shared-draft/stream');
    expect(requests[0]?.ferretId).toBe('sess-one');
  });

  test('ends the stream on a frame it cannot read, even one that arrives before the open settles', async () => {
    const { session, closed } = fakeSession();
    const ended: number[] = [];
    await openSharedDraftStream(
      clientOf(request => {
        request.onData({ kind: 'text', text: '{"kind":"nonsense"}' });
        request.onData({ kind: 'text', text: '{"kind":"ready"}' });
        return session;
      }),
      scope,
      undefined,
      { onFrame: () => undefined, onClosed: code => ended.push(code) },
    );
    // The client socket closes with no code of its own; the composer is told why (1003).
    expect(closed).toEqual([1000]);
    expect(ended).toEqual([1003]);
  });

  test('ends on bytes and on text that is not JSON, reports the daemon closing once, and sends nothing after', async () => {
    const one = fakeSession();
    const two = fakeSession();
    const ended: number[] = [];
    const handlers = { onFrame: () => undefined, onClosed: (code: number) => ended.push(code) };
    let deliver: StreamRequest['onData'] | undefined;
    await openSharedDraftStream(
      clientOf(request => {
        deliver = request.onData;
        return one.session;
      }),
      scope,
      undefined,
      handlers,
    );
    deliver?.({ kind: 'bytes', bytes: new Uint8Array([1]) });
    const link = await openSharedDraftStream(
      clientOf(request => {
        deliver = request.onData;
        return two.session;
      }),
      scope,
      undefined,
      handlers,
    );
    two.end();
    two.end();
    const three = fakeSession();
    await openSharedDraftStream(
      clientOf(request => {
        request.onData({ kind: 'text', text: 'not json' });
        return three.session;
      }),
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
    const frames: DraftServerFrame[] = [];
    let deliver: StreamRequest['onData'] | undefined;
    await openSharedDraftStream(
      clientOf(request => {
        deliver = request.onData;
        return session;
      }),
      scope,
      undefined,
      { onFrame: frame => frames.push(frame), onClosed: () => undefined },
    );
    const text = (frame: object) => deliver?.({ kind: 'text', text: JSON.stringify(frame) });
    text({
      kind: 'snapshot',
      snapshot: {
        v: 1,
        ferret: 'sess-one' as FerretId,
        generation: G,
        epoch: 0,
        rev: 1,
        text: 'ab',
        items: [],
        updatedAt: AT,
      },
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
          ferret: 'sess-one' as FerretId,
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
            ferret: 'sess-one' as FerretId,
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
        clientOf(request => {
          for (const frame of sequence) request.onData({ kind: 'text', text: JSON.stringify(frame) });
          return fakeSession().session;
        }),
        scope,
        undefined,
        { onFrame: () => undefined, onClosed: code => ended.push(code) },
      );
    }
    expect(ended).toEqual([1003, 1003]);
  });

  test('opens no stream for an item’s own draft, nor through a client with no socket', async () => {
    const opened: StreamRequest[] = [];
    const client = clientOf(request => {
      opened.push(request);
      return fakeSession().session;
    });
    const handlers = { onFrame: () => undefined, onClosed: () => undefined };
    await expect(
      openSharedDraftStream(client, daemonFerretScope(daemon, 'sess-one', 'A5'), undefined, handlers),
    ).rejects.toThrow('an item draft has no live stream yet');
    await expect(openSharedDraftStream({}, scope, undefined, handlers)).rejects.toThrow(
      'this client opens no live stream',
    );
    expect(opened).toEqual([]);
  });
});

describe('the second review (nathanael) — acceptance', () => {
  test('1: a send that lands after another device added words takes out only what was sent', async () => {
    // Arrange — the laptop holds "hello" and presses send; the reply is slow.
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { phone: '', laptop: '' });
    await settle();
    devices.type('laptop', 'hello');
    await settle();
    let mark: SharedDraftSendMark | undefined;
    run(() => {
      mark = devices.hooks.laptop?.markSend();
    });
    let carried: DraftSent | undefined;
    await runAsync(async () => {
      if (mark !== undefined) carried = await devices.hooks.laptop?.sendClear(mark);
    });

    // Act — the phone adds words before the send's answer comes back; then the send completes.
    devices.type('phone', 'hello unsent addition');
    await settle();
    expect(devices.texts.laptop).toBe('hello unsent addition');
    let left: string | null | undefined;
    run(() => {
      if (mark !== undefined) left = devices.hooks.laptop?.sent(mark);
    });
    await settle();

    // Assert — only "hello" went; the phone's words stay, everywhere.
    expect(left).toBe(' unsent addition');
    expect(daemonSide.text).toBe(' unsent addition');
    expect(devices.texts.phone).toBe(' unsent addition');
    expect(carried).toMatchObject({ base: 1, text: [-5] });
    devices.unmount();
  });

  test('3: a device closed before another device sent never republishes the sent words: they are offered instead', async () => {
    // Arrange — the daemon's draft was used and sent: epoch 1, empty. The phone's browser still holds the old words.
    const daemonSide = new FakeDaemon();
    daemonSide.epoch = 1;
    const devices = mountDevices(daemonSide, { phone: 'already sent' });

    // Act — the phone opens.
    await settle();

    // Assert — nothing was published; the old words wait behind "Restore them".
    expect(daemonSide.text).toBe('');
    expect(daemonSide.history).toHaveLength(0);
    expect(devices.texts.phone).toBe('');
    expect(devices.hooks.phone?.conflict).toBe('already sent');
    devices.unmount();
  });

  test('4: words waiting to be restored survive a remount (a reload, a session change), until restored or dismissed', async () => {
    // Arrange — offline words meet a draft with other words: they wait to be restored.
    const daemonSide = new FakeDaemon();
    daemonSide.text = 'canonical server text';
    daemonSide.history.push({ op: ['canonical server text'] });
    const storage = { phone: new DaemonDraftStore(new MemoryStorage(), 'restore') };
    const first = mountDevices(daemonSide, { phone: 'offline unique words' }, { restore: storage });
    await settle();
    expect(first.hooks.phone?.conflict).toBe('offline unique words');

    // Act — the page goes away and comes back, as the canonical text.
    first.unmount();
    const second = mountDevices(daemonSide, { phone: 'canonical server text' }, { restore: storage });
    await settle();

    // Assert — still offered; and a second conflict adds to it rather than replacing it.
    expect(second.hooks.phone?.conflict).toBe('offline unique words');
    run(() => second.hooks.phone?.dismissConflict());
    expect(storage.phone.load(daemonFerretScope(daemon, 'sess-one'))).toBe('');
    second.unmount();
  });
});

describe('the send mark (rose N1, N3) and kept copies (N2)', () => {
  test("N1: pressing send in A then working in B throws nothing, leaves B alone, and A's finish touches nothing here", async () => {
    // Arrange — A has words; the person presses send there, then moves to B.
    const daemonA = new FakeDaemon();
    daemonA.text = 'words for A';
    daemonA.history.push({ op: ['words for A'] });
    const daemonB = new FakeDaemon();
    // A different length from A's, so a mark carried over from A could not even be applied here.
    daemonB.text = 'words for session B';
    daemonB.history.push({ op: ['words for session B'] });
    const client = clientOf(request => (request.ferretId === 'sess-A' ? daemonA : daemonB).open(request));
    const timers = new ManualTimers();
    const seen: { text?: string; hook?: SharedDraft; switchTo?: (id: string) => void; type?: (t: string) => void } = {};
    const Composer = () => {
      const [ferretId, setFerret] = useState('sess-A');
      const [draft, setDraft] = useState('');
      const scope = useMemo(() => daemonFerretScope(daemon, ferretId), [ferretId]);
      Object.assign(seen, { text: draft, switchTo: setFerret, type: setDraft });
      seen.hook = useSharedDraft({
        client,
        scope,
        text: draft,
        setText: setDraft,
        timers,
        ids: fixedId,
        restoreStore: new DaemonDraftStore(new MemoryStorage(), 'r'),
      });
      return null;
    };
    const root = render(<Composer />);
    await settle();
    let mark: SharedDraftSendMark | undefined;
    run(() => {
      mark = seen.hook?.markSend();
    });

    // Act — B, with its own words in the box as the composer shows them: type, and hear another device's edit.
    run(() => {
      seen.switchTo?.('sess-one');
      seen.type?.('words for session B');
    });
    await settle();
    run(() => seen.type?.('words for session B, and mine'));
    await settle();
    run(() =>
      daemonB.streams[0]?.deliver({
        kind: 'edit',
        applied: { generation: G, epoch: 0, rev: 9, text: ['> ', 29], add: [], remove: [] },
        epoch: 0,
        rev: 9,
      }),
    );
    await settle();
    let finished: string | null | undefined;
    run(() => {
      if (mark !== undefined) finished = seen.hook?.sent(mark);
    });

    // Assert
    expect(finished).toBeNull();
    expect(seen.text).toBe('> words for session B, and mine');
    run(() => root.unmount());
  });

  test('N1: a snapshot during a send never makes its finish throw, and never invents a clear', async () => {
    // Arrange — the laptop presses send on "hello", carrying its clear.
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { laptop: '' });
    await settle();
    devices.type('laptop', 'hello');
    await settle();
    let mark: SharedDraftSendMark | undefined;
    run(() => {
      mark = devices.hooks.laptop?.markSend();
    });
    await runAsync(async () => {
      if (mark !== undefined) await devices.hooks.laptop?.sendClear(mark);
    });

    // Act — the stream must start afresh (a whole snapshot, with words added elsewhere), then the send completes.
    daemonSide.text = 'hello and newer words';
    daemonSide.history.push({ op: [5, ' and newer words'] });
    const first = daemonSide.streams[0] as FakeStream;
    daemonSide.drop(first);
    for (const closer of first.closers) closer({ code: DRAFT_STREAM_RESYNC_CLOSE, reason: 'too large' });
    await settle();
    run(() => devices.timers.advance(1_000));
    await settle();
    expect(devices.texts.laptop).toBe('hello and newer words');
    let left: string | null | undefined;
    run(() => {
      if (mark !== undefined) left = devices.hooks.laptop?.sent(mark);
    });

    // Assert — no throw; the newer words stay; the clear is the daemon's, from what the send carried.
    expect(left).toBe('hello and newer words');
    expect(devices.texts.laptop).toBe('hello and newer words');
    devices.unmount();
  });

  test('N1: with the words lost and no clear carried, only a box still holding exactly what was sent is emptied', async () => {
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { laptop: '' });
    await settle();
    devices.type('laptop', 'same words');
    await settle();
    const lose = async () => {
      const first = daemonSide.streams.at(-1) as FakeStream;
      daemonSide.drop(first);
      for (const closer of first.closers) closer({ code: DRAFT_STREAM_RESYNC_CLOSE, reason: 'too large' });
      await settle();
      run(() => devices.timers.advance(1_000));
      await settle();
    };
    let mark: SharedDraftSendMark | undefined;
    run(() => {
      mark = devices.hooks.laptop?.markSend();
    });
    await lose();
    let left: string | null | undefined;
    run(() => {
      if (mark !== undefined) left = devices.hooks.laptop?.sent(mark);
    });
    await settle();
    expect(left).toBe('');
    expect(daemonSide.text).toBe('');

    // And when the box holds something else by then, it is left alone.
    devices.type('laptop', 'first');
    await settle();
    run(() => {
      mark = devices.hooks.laptop?.markSend();
    });
    daemonSide.text = 'first, then other';
    daemonSide.history.push({ op: [5, ', then other'] });
    await lose();
    run(() => {
      if (mark !== undefined) left = devices.hooks.laptop?.sent(mark);
    });
    expect(left).toBe('first, then other');
    devices.unmount();
  });

  test('N3: the clear waits for the last keystroke to be answered, then names the words exactly; it never blocks past the wait', async () => {
    // Arrange — the laptop's last keystroke is still on its way when send is pressed.
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { laptop: '' });
    await settle();
    const stream = daemonSide.streams[0] as FakeStream;
    devices.type('laptop', 'quick');
    let mark: SharedDraftSendMark | undefined;
    run(() => {
      mark = devices.hooks.laptop?.markSend();
    });
    let carried: DraftSent | undefined | 'pending' = 'pending';
    const waiting = (async () => {
      if (mark !== undefined) carried = await devices.hooks.laptop?.sendClear(mark);
    })();

    // Act — the keystroke is answered.
    await settle();
    await runAsync(async () => await waiting);

    // Assert — the clear is at the answered revision.
    expect(carried).toMatchObject({ base: 1, text: [-5] });
    expect(stream.sent.filter(frame => frame.kind === 'edit')).toHaveLength(1);

    // With no answer coming, it gives up at the wait and the send goes without it.
    stream.alive = false;
    devices.type('laptop', 'quick, and never answered');
    run(() => {
      mark = devices.hooks.laptop?.markSend();
    });
    let late: DraftSent | undefined | 'pending' = 'pending';
    const timedOut = (async () => {
      if (mark !== undefined) late = await devices.hooks.laptop?.sendClear(mark, 500);
    })();
    await settle();
    expect(late).toBe('pending');
    run(() => devices.timers.advance(500));
    await runAsync(async () => await timedOut);
    expect(late).toBeUndefined();
    devices.unmount();
  });

  test('N3: the wait ends at once on a session switch, with no clear', async () => {
    // Arrange — a live stream that will never answer this device's last edit.
    const daemonSide = new FakeDaemon();
    const client = clientOf(daemonSide.open);
    const timers = new ManualTimers();
    const seen: { hook?: SharedDraft; switchTo?: (id: string) => void; type?: (text: string) => void } = {};
    const Composer = () => {
      const [ferretId, setFerret] = useState('sess-one');
      const [draft, setDraft] = useState('');
      const scope = useMemo(() => daemonFerretScope(daemon, ferretId), [ferretId]);
      Object.assign(seen, { switchTo: setFerret, type: setDraft });
      seen.hook = useSharedDraft({
        client,
        scope,
        text: draft,
        setText: setDraft,
        timers,
        ids: fixedId,
        restoreStore: new DaemonDraftStore(new MemoryStorage(), 'r'),
      });
      return null;
    };
    const root = render(<Composer />);
    await settle();
    (daemonSide.streams[0] as FakeStream).alive = false;
    run(() => seen.type?.('typed, never answered'));
    await settle();
    const hook = seen.hook as SharedDraft;
    const mark = hook.markSend();
    let result: DraftSent | undefined | 'pending' = 'pending';
    const waiting = (async () => {
      result = await hook.sendClear(mark);
    })();
    await settle();
    expect(result).toBe('pending');

    // Act — the person moves to another session; no time passes.
    run(() => seen.switchTo?.('sess-A'));
    await runAsync(async () => await waiting);

    // Assert
    expect(result).toBeUndefined();
    run(() => root.unmount());
  });

  test('N3: a mark already given up, or a stream starting afresh, gets no clear and no wait', async () => {
    // Arrange
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { laptop: '' });
    await settle();
    devices.type('laptop', 'words');
    await settle();
    const hook = devices.hooks.laptop as SharedDraft;

    // Act — one mark abandoned (its send refused); another pressed while the stream starts afresh.
    const abandoned = hook.markSend();
    hook.abandonSend(abandoned);
    const first = daemonSide.streams[0] as FakeStream;
    daemonSide.drop(first);
    for (const closer of first.closers) closer({ code: DRAFT_STREAM_RESYNC_CLOSE, reason: 'too large' });
    await settle();
    const resyncing = (devices.hooks.laptop as SharedDraft).markSend();

    // Assert — both answered at once, with nothing.
    expect(hook.sendClear(abandoned)).toBeUndefined();
    expect((devices.hooks.laptop as SharedDraft).sendClear(resyncing)).toBeUndefined();
    devices.unmount();
  });

  test('N2: a second set of words waiting to be restored never costs the first, however long, across a reload', async () => {
    // Arrange — two conflicts, long enough together to pass one draft's bound.
    const daemonSide = new FakeDaemon();
    daemonSide.text = 'server';
    daemonSide.history.push({ op: ['server'] });
    const storage = { phone: new DaemonDraftStore(new MemoryStorage(), 'restore') };
    const first = mountDevices(daemonSide, { phone: 'a'.repeat(9_000) }, { restore: storage });
    await settle();
    first.unmount();
    const second = mountDevices(daemonSide, { phone: 'b'.repeat(8_000) }, { restore: storage });
    await settle();
    second.unmount();

    // Act — the page comes back.
    const third = mountDevices(daemonSide, { phone: 'server' }, { restore: storage });
    await settle();

    // Assert — both still offered.
    expect(third.hooks.phone?.conflict).toBe(`${'a'.repeat(9_000)}\n${'b'.repeat(8_000)}`);

    // And Restore puts back only what fits in one draft; the rest stays offered, across another reload.
    run(() => third.hooks.phone?.restoreConflict());
    await settle();
    expect(third.texts.phone).toBe(`server\n${'a'.repeat(9_000)}`);
    expect(third.hooks.phone?.conflict).toBe('b'.repeat(8_000));
    third.unmount();
    const fourth = mountDevices(daemonSide, { phone: `server\n${'a'.repeat(9_000)}` }, { restore: storage });
    await settle();
    expect(fourth.hooks.phone?.conflict).toBe('b'.repeat(8_000));
    fourth.unmount();
  });
});

describe('a send and the files beside it (review H1, phase 3)', () => {
  test('takes out the files that were there when send was pressed, and keeps one attached after', async () => {
    // Arrange — the phone attaches a screenshot and presses send; the answer is slow.
    const daemonSide = new FakeDaemon();
    const devices = mountDevices(daemonSide, { phone: '', laptop: '' });
    await settle();
    const shot = { kind: 'attachment' as const, id: 'att_1', name: 'shot.png', mime: 'image/png', bytes: 4 };
    const later = { kind: 'attachment' as const, id: 'att_2', name: 'later.pdf', mime: 'application/pdf', bytes: 9 };
    run(() => devices.hooks.phone?.changeItems({ add: [shot] }));
    devices.type('phone', 'see attached');
    await settle();
    let mark: SharedDraftSendMark | undefined;
    run(() => {
      mark = devices.hooks.phone?.markSend();
    });
    let carried: DraftSent | undefined;
    await runAsync(async () => {
      if (mark !== undefined) carried = await devices.hooks.phone?.sendClear(mark);
    });
    expect(carried?.remove).toEqual(['att_1']);

    // Act — the laptop attaches another file before the send completes.
    run(() => devices.hooks.laptop?.changeItems({ add: [later] }));
    await settle();
    run(() => {
      if (mark !== undefined) devices.hooks.phone?.sent(mark);
    });
    await settle();

    // Assert — only the sent file went.
    expect(daemonSide.items).toEqual([later]);
    expect(devices.hooks.laptop?.items).toEqual([later]);
    devices.unmount();
  });
});
