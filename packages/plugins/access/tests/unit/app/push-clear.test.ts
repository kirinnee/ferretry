/**
 * A handled agenda item's alerts coming down (docs/notifications.md § When an alert is cleared). The owner: "when on 1
 * device is alr replied or resolved. then it should dismiss on other phones"; their decision !A324: an iPhone swaps in
 * a quiet note.
 */
import { describe, expect, it } from 'bun:test';
import { agendaItemPushTag, type PushClearPayload, type PushSeenResponse } from '../../../contract/index.ts';
import { daemonConnection, daemonId, NOTIFICATION_BADGE, NOTIFICATION_ICON } from '../../../app/shell-pairing.ts';
import {
  applyClear,
  CLEARED_TAG_MEMORY_MS,
  type ClearRegistration,
  closeShownTags,
  HANDLED_BODY,
  HANDLED_TAG_PREFIX,
  HANDLED_TITLE,
  handledNotification,
  mustShowForEveryPush,
  planClear,
  RecentlyCleared,
  type ShownNotification,
  settleIfCleared,
  shownTag,
} from '../../../app/lib/push-clear.ts';
import { agendaItemOpenedHandler, machinePushRegistration } from '../../../app/lib/push-seen.ts';
import { postAgendaItemSeen } from '../../../app/lib/push-subscriptions.ts';

const ORIGIN = 'https://ferretry.example.test';
const WORK = { daemonId: 'sha256:work/one', label: 'Work laptop' };
const HOME = { daemonId: 'home', label: 'Home' };
const APPLE = 'https://web.push.apple.com/QGuEdBdHVcw';
const FCM = 'https://fcm.googleapis.com/fcm/send/abc';

const clear = (tags: readonly string[]): PushClearPayload => ({
  version: 1,
  kind: 'clear',
  eventKey: 'clear:session-1:agenda:session-1:A3:ping',
  sessionId: 'session-1',
  tags: [...tags],
});

/** A registration holding some notifications by shown tag, recording what was closed and shown. */
class FakeRegistration implements ClearRegistration {
  readonly closed: string[] = [];
  readonly shown: { title: string; options?: NotificationOptions }[] = [];
  readonly pushManager?: ClearRegistration['pushManager'];

  constructor(
    readonly showing: Record<string, number>,
    endpoint: string | null | 'throws' | 'absent' = FCM,
  ) {
    if (endpoint === 'absent') return;
    this.pushManager = {
      getSubscription: async () => {
        if (endpoint === 'throws') throw new Error('push manager unavailable');
        return endpoint === null ? null : { endpoint };
      },
    };
  }

  /** When each tag's line was shown; a tag not here was shown at 0, long ago, and one set to `undefined` has no stamp. */
  readonly stamps: Record<string, number | undefined> = {};

  async getNotifications(options?: { tag: string }): Promise<readonly ShownNotification[]> {
    // Asked for every line, it lists none: no quiet line it showed is kept here.
    if (options === undefined) return [];
    const stamp = options.tag in this.stamps ? this.stamps[options.tag] : 0;
    // A line closed is gone: closing the same tag again finds nothing more.
    const left = (this.showing[options.tag] ?? 0) - this.closed.filter(tag => tag === options.tag).length;
    return Array.from({ length: left }, () => ({
      close: () => void this.closed.push(options.tag),
      ...(stamp === undefined ? {} : { timestamp: stamp }),
    }));
  }

  async showNotification(title: string, options?: NotificationOptions): Promise<void> {
    this.shown.push({ title, ...(options === undefined ? {} : { options }) });
  }
}

describe('whether this registration’s push service needs every push to show something', () => {
  it('should let only FCM and WNS show nothing, read from the endpoint whatever the device calls itself', () => {
    // Act / Assert
    expect(mustShowForEveryPush(FCM)).toBe(false);
    expect(mustShowForEveryPush('https://wns2-db5p.notify.windows.com/w/?token=x')).toBe(false);
    expect(mustShowForEveryPush(APPLE)).toBe(true);
    expect(mustShowForEveryPush('https://api.push.apple.com/x')).toBe(true);
    // Mozilla's revokes a subscription whose pushes show nothing, once its quota is spent (review round 7).
    expect(mustShowForEveryPush('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    // Not a quiet service just because the name ends like one.
    expect(mustShowForEveryPush('https://notify.windows.com/x')).toBe(true);
    expect(mustShowForEveryPush('https://fcm.googleapis.com.example.test/x')).toBe(true);
  });

  it('should treat a subscription it cannot read as needing a line, the answer that only costs a quiet line', () => {
    // Act / Assert
    expect(mustShowForEveryPush(null)).toBe(true);
    expect(mustShowForEveryPush(undefined)).toBe(true);
    expect(mustShowForEveryPush('not a url')).toBe(true);
  });
});

describe('the quiet note', () => {
  it('should say only that it was handled: silent, branded, no item words, opening the machine', () => {
    // Act
    const note = handledNotification(WORK, ORIGIN, 'fy-push:x:attention-s:A3');

    // Assert
    expect(note.title).toBe('Work laptop · Handled on another device');
    expect(HANDLED_TITLE).toBe('Handled on another device');
    expect(note.options).toEqual({
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
      body: HANDLED_BODY,
      tag: 'fy-push:x:attention-s:A3',
      silent: true,
      renotify: false,
      data: { url: `${ORIGIN}/d/${encodeURIComponent(WORK.daemonId)}`, handled: true },
    });
    expect(HANDLED_BODY).toBe('Nothing to do here.');
  });

  it('should title the app-wide registration’s note Unverified', () => {
    // Act / Assert
    expect(handledNotification(null, ORIGIN, 'x').title).toBe('Unverified · Handled on another device');
  });
});

describe('planClear (owner decision !A324)', () => {
  const tagA = shownTag('attention-s:A1', WORK);
  const tagB = shownTag('attention-s', WORK);

  it('should close every match and show nothing on Android and desktop', () => {
    // Act / Assert
    expect(planClear([tagA, tagB], false, WORK, ORIGIN)).toEqual({ close: [tagA, tagB] });
  });

  it('should show nothing at all on Android and desktop when nothing matched', () => {
    // Act / Assert
    expect(planClear([], false, WORK, ORIGIN)).toEqual({ close: [] });
  });

  it('should replace the first match with the note under its own tag on Apple, and close the rest', () => {
    // Act
    const plan = planClear([tagA, tagB], true, WORK, ORIGIN);

    // Assert
    expect(plan.close).toEqual([tagB]);
    expect(plan.show?.options.tag).toBe(tagA);
    expect(plan.show?.title).toBe('Work laptop · Handled on another device');
  });

  it('should show one note under a fixed per-machine tag on Apple when nothing matched', () => {
    // Act
    const work = planClear([], true, WORK, ORIGIN);
    const app = planClear([], true, null, ORIGIN);

    // Assert
    expect(work).toEqual({
      close: [],
      show: handledNotification(WORK, ORIGIN, `${HANDLED_TAG_PREFIX}sha256%3Awork%2Fone`),
    });
    expect(app.show?.options.tag).toBe(`${HANDLED_TAG_PREFIX}app`);
  });
});

describe('applyClear', () => {
  it('should close only this machine’s lines, never another machine’s with the same daemon tag', async () => {
    // Arrange — both machines showed the same daemon tag; this registration serves WORK.
    const mine = shownTag('attention-session-1:A3', WORK);
    const theirs = shownTag('attention-session-1:A3', HOME);
    const registration = new FakeRegistration({ [mine]: 1, [theirs]: 1 });

    // Act
    const plan = await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN);

    // Assert
    expect(mine).toBe('fy-push:sha256%3Awork%2Fone:attention-session-1:A3');
    expect(registration.closed).toEqual([mine]);
    expect(registration.shown).toEqual([]);
    expect(plan).toEqual({ close: [mine] });
  });

  it('should close nothing and show nothing on Android when the line is already gone', async () => {
    // Arrange
    const registration = new FakeRegistration({});

    // Act
    await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN);

    // Assert
    expect([registration.closed, registration.shown]).toEqual([[], []]);
  });

  it('should swap the line for the note on an iPhone, under the same tag, and close the stop line', async () => {
    // Arrange
    const item = shownTag('attention-session-1:A3', WORK);
    const stop = shownTag('attention-session-1', WORK);
    const registration = new FakeRegistration({ [item]: 1, [stop]: 1 }, APPLE);

    // Act
    await applyClear(registration, clear(['attention-session-1:A3', 'attention-session-1']), WORK, ORIGIN);

    // Assert
    expect(registration.shown.map(shown => [shown.title, shown.options?.tag, shown.options?.silent])).toEqual([
      ['Work laptop · Handled on another device', item, true],
    ]);
    expect(registration.closed).toEqual([stop]);
  });

  it('should still show the note on an iPhone with nothing up, and wherever the service cannot be read', async () => {
    // Arrange
    const iphone = new FakeRegistration({}, APPLE);
    const unreadable = new FakeRegistration({}, 'throws');
    const noManager = new FakeRegistration({}, 'absent');

    // Act
    for (const registration of [iphone, unreadable, noManager])
      await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN);

    // Assert
    for (const registration of [iphone, unreadable, noManager]) {
      expect(registration.shown.map(shown => shown.options?.tag)).toEqual([`${HANDLED_TAG_PREFIX}sha256%3Awork%2Fone`]);
      expect(registration.closed).toEqual([]);
    }
  });

  it('should keep the app-wide registration inside its own namespace', async () => {
    // Arrange
    const unverified = shownTag('attention-session-1:A3', null);
    const registration = new FakeRegistration({ [unverified]: 1 });

    // Act
    await applyClear(registration, clear(['attention-session-1:A3']), null, ORIGIN);

    // Assert
    expect(unverified).toBe('fy-push-unverified:attention-session-1:A3');
    expect(registration.closed).toEqual([unverified]);
  });
});

describe('closeShownTags (the page’s own lines for an item opened here)', () => {
  it('should close every line under the named tags, once each, and count them', async () => {
    // Arrange
    const item = shownTag('attention-session-1:A3', WORK);
    const registration = new FakeRegistration({ [item]: 2 });

    // Act
    const closed = await closeShownTags(registration, ['attention-session-1:A3', 'attention-session-1:A3'], WORK);

    // Assert
    expect(closed).toBe(2);
    expect(registration.closed).toEqual([item, item]);
  });
});

describe('opening an item here (the owner opened it in the app)', () => {
  const connection = daemonConnection({ daemonId: 'home', baseUrl: 'https://home.example.test', deviceId: 'token-h' });
  const itemTag = shownTag(agendaItemPushTag('session-1', 'A3'), HOME);
  const stopTag = shownTag('attention-session-1', HOME);
  /** The page's clock at the open. */
  const OPENED_AT = 1_000;

  const world = (options: { seen?: () => Promise<PushSeenResponse> } = {}) => {
    const registration = new FakeRegistration({ [itemTag]: 1, [stopTag]: 1 });
    const told: string[][] = [];
    const opened = agendaItemOpenedHandler({
      registration: async () => registration,
      now: () => OPENED_AT,
      seen: async (daemon, sessionId, agendaId) => {
        told.push([daemon.daemonId, sessionId, agendaId]);
        return await (options.seen ?? (async () => ({ cleared: true, tags: ['attention-session-1'] })))();
      },
    });
    return { registration, told, opened };
  };

  it('should close the item’s line here, tell the machine, and close the tags it answers', async () => {
    // Arrange
    const { registration, told, opened } = world();

    // Act
    const result = await opened(connection, 'session-1', 'A3');

    // Assert
    expect(result).toEqual({ closed: 2, told: true });
    expect(told).toEqual([['home', 'session-1', 'A3']]);
    expect(registration.closed).toEqual([itemTag, stopTag]);
    expect(registration.shown).toEqual([]);
  });

  it('should leave a line shown after the open up when the answer names its tag: it is newer (review round 4)', async () => {
    // Arrange — the answer is slow; meanwhile the next item was raised and a new stop line went up under the same tag.
    const { registration, opened } = world();
    registration.stamps[stopTag] = OPENED_AT + 1;

    // Act
    const result = await opened(connection, 'session-1', 'A3');

    // Assert
    expect(result).toEqual({ closed: 1, told: true });
    expect(registration.closed).toEqual([itemTag]);
  });

  it('should close the item’s own line however new once the machine answers: it is about the item open here (review round 8)', async () => {
    // Arrange — one of the item's pushes lands here while the machine is asked, which the machine's clear skips.
    let landed = (): void => undefined;
    const { registration, opened } = world({
      seen: async () => {
        landed();
        return { cleared: true, tags: ['attention-session-1:A3'] };
      },
    });
    landed = () => {
      registration.showing[itemTag] = 2;
      registration.stamps[itemTag] = OPENED_AT + 1;
    };

    // Act
    const result = await opened(connection, 'session-1', 'A3');

    // Assert — the old line at the open, and the new one after the answer; the stop line was never named.
    expect(result).toEqual({ closed: 2, told: true });
    expect(registration.closed).toEqual([itemTag, itemTag]);
  });

  it('should leave a line the browser gives no time for up when the answer names its tag', async () => {
    // Arrange
    const { registration, opened } = world();
    registration.stamps[stopTag] = undefined;

    // Act
    await opened(connection, 'session-1', 'A3');

    // Assert — the item's own line, closed at the open itself, still comes down.
    expect(registration.closed).toEqual([itemTag]);
  });

  it('should close a line shown at the very moment of the open', async () => {
    // Arrange
    const { registration, opened } = world();
    registration.stamps[stopTag] = OPENED_AT;

    // Act
    await opened(connection, 'session-1', 'A3');

    // Assert
    expect(registration.closed).toEqual([itemTag, stopTag]);
  });

  it('should read the moment of the open from the page clock when none is given', async () => {
    // Arrange — a line stamped in the future is newer than this open.
    const registration = new FakeRegistration({ [itemTag]: 1, [stopTag]: 1 });
    registration.stamps[stopTag] = Date.now() + 60_000;
    const opened = agendaItemOpenedHandler({
      registration: async () => registration,
      seen: async () => ({ cleared: true, tags: ['attention-session-1'] }),
    });

    // Act
    await opened(connection, 'session-1', 'A3');

    // Assert
    expect(registration.closed).toEqual([itemTag]);
  });

  it('should tell the machine again when the item is opened again: it may have buzzed since, or the first try failed', async () => {
    // Arrange — the first try fails (offline), the second reaches the machine (review round 1).
    let calls = 0;
    const { told, opened } = world({
      seen: async () => {
        calls += 1;
        if (calls === 1) throw new Error('offline');
        return { cleared: true, tags: [] };
      },
    });

    // Act
    const first = await opened(connection, 'session-1', 'A3');
    const again = await opened(connection, 'session-1', 'A3');

    // Assert
    expect(first.told).toBe(false);
    expect(again.told).toBe(true);
    expect(told).toHaveLength(2);
  });


  it('should keep what it closed when the machine cannot be told', async () => {
    // Arrange
    const { opened } = world({
      seen: async () => {
        throw new Error('offline');
      },
    });

    // Act / Assert
    expect(await opened(connection, 'session-1', 'A3')).toEqual({ closed: 1, told: false });
  });

  it('should close nothing, and still tell the machine, when this browser cannot reach its notifications', async () => {
    // Arrange
    const failing = agendaItemOpenedHandler({
      registration: async () => {
        throw new Error('no service worker container');
      },
      seen: async () => ({ cleared: true, tags: ['attention-session-1'] }),
    });
    const refusing = agendaItemOpenedHandler({
      registration: async () => ({
        getNotifications: async () => {
          throw new Error('notifications are blocked');
        },
      }),
      seen: async () => ({ cleared: true, tags: ['attention-session-1'] }),
    });

    // Act / Assert
    expect(await failing(connection, 'session-1', 'A3')).toEqual({ closed: 0, told: true });
    expect(await refusing(connection, 'session-1', 'A3')).toEqual({ closed: 0, told: true });
  });

  it('should still tell the machine from a browser with no push worker for it', async () => {
    // Arrange
    const told: string[] = [];
    const opened = agendaItemOpenedHandler({
      registration: async () => null,
      seen: async (_daemon, _sessionId, agendaId) => {
        told.push(agendaId);
        return { cleared: false, tags: [] };
      },
    });

    // Act / Assert
    expect(await opened(connection, 'session-1', 'A3')).toEqual({ closed: 0, told: true });
    expect(told).toEqual(['A3']);
  });
});

describe('postAgendaItemSeen', () => {
  it('should POST the item, and nothing else, to that machine’s /v1/push/seen', async () => {
    // Arrange
    const calls: { url: string; init?: RequestInit }[] = [];
    const connection = daemonConnection({
      daemonId: 'home',
      baseUrl: 'https://home.example.test',
      deviceId: 'token-h',
    });
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({ cleared: true, tags: ['attention-session-1:A3'] }));
    };

    // Act
    const answer = await postAgendaItemSeen(connection, 'session-1', 'A3', fetcher);

    // Assert
    expect(answer).toEqual({ cleared: true, tags: ['attention-session-1:A3'] });
    expect(calls[0]?.url).toBe('https://home.example.test/v1/push/seen');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ sessionId: 'session-1', agendaId: 'A3' });
  });

  it('should refuse an id that is not an agenda id before anything is sent', async () => {
    // Arrange
    const connection = daemonConnection({
      daemonId: 'home',
      baseUrl: 'https://home.example.test',
      deviceId: 'token-h',
    });
    let sent = 0;
    const fetcher = async (): Promise<Response> => {
      sent += 1;
      return new Response('{}');
    };

    // Act / Assert
    await expect(postAgendaItemSeen(connection, 'session-1', 'not-an-id', fetcher)).rejects.toThrow();
    expect(sent).toBe(0);
  });
});

describe('machinePushRegistration (which registration holds a machine’s lines here)', () => {
  const scope = `${ORIGIN}/push/home/`;
  const registration = new FakeRegistration({});

  it('should answer the machine’s own registration, and nothing for the app-wide one a lookup falls back to', async () => {
    // Arrange
    const asked: string[] = [];
    const own = machinePushRegistration(
      { serviceWorker: { getRegistration: async url => (asked.push(url), Object.assign(registration, { scope })) } },
      ORIGIN,
    );
    const fallback = machinePushRegistration(
      {
        serviceWorker: {
          getRegistration: async () => Object.assign(new FakeRegistration({}), { scope: `${ORIGIN}/` }),
        },
      },
      ORIGIN,
    );

    // Act / Assert
    expect(await own(daemonId('home'))).toBe(registration);
    expect(asked).toEqual([scope]);
    expect(await fallback(daemonId('home'))).toBeNull();
  });

  it('should answer nothing without a service-worker container, or with no registration at all', async () => {
    // Act / Assert
    expect(await machinePushRegistration(undefined, ORIGIN)(daemonId('home'))).toBeNull();
    expect(await machinePushRegistration({}, ORIGIN)(daemonId('home'))).toBeNull();
    expect(
      await machinePushRegistration(
        { serviceWorker: { getRegistration: async () => undefined } },
        ORIGIN,
      )(daemonId('home')),
    ).toBeNull();
  });
});

describe('a push and its clear handled at once in one worker (review round 2)', () => {
  const tag = shownTag('attention-session-1:A3', WORK);

  /** A registration whose lines change as the worker shows and closes them. */
  class LiveRegistration implements ClearRegistration {
    readonly lines = new Map<string, number>();
    readonly shown: { title: string; tag?: string | undefined }[] = [];
    readonly pushManager: ClearRegistration['pushManager'];

    constructor(endpoint: string) {
      this.pushManager = { getSubscription: async () => ({ endpoint }) };
    }

    /** The tags whose line is a quiet note. */
    readonly notes = new Set<string>();

    async getNotifications(options?: { tag: string }): Promise<readonly ShownNotification[]> {
      const tags = options === undefined ? [...this.lines.keys()] : [options.tag];
      return tags.flatMap(each =>
        Array.from({ length: this.lines.get(each) ?? 0 }, () => ({
          tag: each,
          data: { handled: this.notes.has(each) },
          close: () => {
            this.lines.delete(each);
            this.notes.delete(each);
          },
        })),
      );
    }

    async showNotification(title: string, options?: NotificationOptions): Promise<void> {
      this.shown.push({ title, tag: options?.tag });
      if (options?.tag === undefined) return;
      this.lines.set(options.tag, 1);
      if ((options.data as { handled?: boolean } | undefined)?.handled === true) this.notes.add(options.tag);
      else this.notes.delete(options.tag);
    }
  }

  const clock = { now: 0 };
  const order = () => new RecentlyCleared(() => clock.now);

  it('should not let a push that read its filter while its clear ran put the stale line up (Android)', async () => {
    // Arrange — the push arrives first and is still reading its filter when the clear arrives and runs.
    const registration = new LiveRegistration(FCM);
    const recent = order();
    const push = recent.arrived();
    await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN, {
      recent,
      place: recent.arrived(),
    });

    // Act — the push resumes.
    const settled = await settleIfCleared(registration, tag, recent, push, WORK, ORIGIN);

    // Assert
    expect(settled).toBe(true);
    expect(registration.shown).toEqual([]);
    expect(registration.lines.size).toBe(0);
  });

  it('should show the quiet line in its place on an iPhone, never the item', async () => {
    // Arrange
    const registration = new LiveRegistration(APPLE);
    const recent = order();
    const push = recent.arrived();
    await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN, {
      recent,
      place: recent.arrived(),
    });
    registration.shown.splice(0);

    // Act
    await settleIfCleared(registration, tag, recent, push, WORK, ORIGIN);

    // Assert
    // Nothing of the item's was up when the clear ran, so both quiet lines go under the fixed tag: one line, never two.
    expect(registration.shown).toEqual([
      { title: 'Work laptop · Handled on another device', tag: `fy-handled:${encodeURIComponent(WORK.daemonId)}` },
    ]);
    expect(registration.lines.has(tag)).toBe(false);
  });

  it('should run a clear only after the show in progress, so it always finds the line that show put up', async () => {
    // Arrange — the push is part-way through showing when the clear arrives.
    const registration = new LiveRegistration(FCM);
    const recent = order();
    const push = recent.arrived();
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const showing = recent.serial(async () => {
      if (await settleIfCleared(registration, tag, recent, push, WORK, ORIGIN)) return;
      await held;
      await registration.showNotification('Work laptop · Deploy?', { tag });
    });
    const clearing = recent.serial(() =>
      applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN, { recent, place: recent.arrived() }),
    );

    // Act
    release();
    await Promise.all([showing, clearing]);

    // Assert
    expect(registration.shown).toEqual([{ title: 'Work laptop · Deploy?', tag }]);
    expect(registration.lines.has(tag)).toBe(false);
  });

  it('should keep running after one piece of work fails', async () => {
    // Arrange
    const recent = order();
    const failed = recent.serial(async () => {
      throw new Error('show failed');
    });

    // Act / Assert
    await expect(failed).rejects.toThrow('show failed');
    expect(await recent.serial(async () => 'next')).toBe('next');
  });

  it('should let a push that arrived after the clear show: it is a newer line (the item woke again)', async () => {
    // Arrange
    const registration = new LiveRegistration(FCM);
    const recent = order();
    await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN, {
      recent,
      place: recent.arrived(),
    });

    // Act / Assert
    expect(await settleIfCleared(registration, tag, recent, recent.arrived(), WORK, ORIGIN)).toBe(false);
    expect(recent.verdict(shownTag('attention-session-1:A4', WORK), 0)).toBe('show');
  });

  it('should keep one quiet line on an iPhone however many items are handled, the newest (review round 9)', async () => {
    // Arrange — two items' lines are up; each is handled on another device in turn.
    const registration = new LiveRegistration(APPLE);
    const other = shownTag('attention-session-1:A4', WORK);
    const stillWanted = shownTag('attention-session-1:A5', WORK);
    for (const each of [tag, other, stillWanted]) registration.lines.set(each, 1);

    // Act
    await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN);
    await applyClear(registration, clear(['attention-session-1:A4']), WORK, ORIGIN);

    // Assert — A3's quiet line went when A4's came; A5's real line was never touched.
    expect([...registration.lines.keys()].sort()).toEqual([other, stillWanted].sort());
    expect([...registration.notes]).toEqual([other]);
  });

  it('should never close another machine’s quiet line, whatever the browser lists (review round 10)', async () => {
    // Arrange — a quiet line under another machine's fixed tag, as a browser listing the whole origin would show it.
    const registration = new LiveRegistration(APPLE);
    const elsewhere = `fy-handled:${encodeURIComponent('sha256:home/two')}`;
    registration.lines.set(elsewhere, 1);
    registration.notes.add(elsewhere);
    registration.lines.set(tag, 1);

    // Act
    await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN);

    // Assert
    expect([...registration.notes].sort()).toEqual([elsewhere, tag].sort());
  });

  for (const [service, endpoint] of [
    ['Android', FCM],
    ['an iPhone', APPLE],
  ] as const) {
    it(`should never touch a newer push’s line when an older push resumes after its clear (${service}, review round 3)`, async () => {
      // Arrange — push1 arrives, clear2 takes A3 down, push3 (the item woke again) shows, then push1 resumes.
      const registration = new LiveRegistration(endpoint);
      const recent = order();
      const push1 = recent.arrived();
      await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN, {
        recent,
        place: recent.arrived(),
      });
      const push3 = recent.arrived();
      expect(await settleIfCleared(registration, tag, recent, push3, WORK, ORIGIN)).toBe(false);
      await registration.showNotification('Work laptop · Deploy again?', { tag });
      const before = registration.shown.length;

      // Act
      const settled = await settleIfCleared(registration, tag, recent, push1, WORK, ORIGIN);

      // Assert — push3's line stays; on an iPhone the old push shows only the fixed quiet line.
      expect(settled).toBe(true);
      expect(registration.lines.get(tag)).toBe(1);
      expect(registration.shown.slice(before)).toEqual(
        endpoint === APPLE
          ? [
              {
                title: 'Work laptop · Handled on another device',
                tag: `fy-handled:${encodeURIComponent(WORK.daemonId)}`,
              },
            ]
          : [],
      );
    });
  }

  it('should show the fixed quiet line, never one under the item’s tag, on an iPhone when nothing is up there (review round 3)', async () => {
    // Arrange — the clear's quiet line is gone (swiped away) when the old push resumes.
    const registration = new LiveRegistration(APPLE);
    const recent = order();
    const push = recent.arrived();
    await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN, {
      recent,
      place: recent.arrived(),
    });
    registration.lines.clear();
    registration.shown.splice(0);

    // Act
    await settleIfCleared(registration, tag, recent, push, WORK, ORIGIN);

    // Assert
    expect(registration.shown).toEqual([
      { title: 'Work laptop · Handled on another device', tag: `fy-handled:${encodeURIComponent(WORK.daemonId)}` },
    ]);
    expect(registration.lines.has(tag)).toBe(false);
  });

  it('should keep only the newest show under a tag', () => {
    // Arrange
    const recent = order();
    const older = recent.arrived();
    const cleared = recent.arrived();
    recent.remember([tag], cleared);
    const newer = recent.arrived();

    // Act
    recent.showed(tag, newer);
    recent.showed(tag, older);

    // Assert
    expect(recent.verdict(tag, older)).toBe('superseded');
  });

  it(`should forget a clear after ${CLEARED_TAG_MEMORY_MS / 1000} s`, () => {
    // Arrange
    clock.now = 0;
    const recent = order();
    const push = recent.arrived();
    recent.remember([tag], recent.arrived());
    recent.showed(tag, recent.arrived());

    // Act
    clock.now = CLEARED_TAG_MEMORY_MS + 1;
    const forgotten = recent.verdict(tag, push);
    recent.remember([shownTag('attention-session-1:A4', WORK)], recent.arrived());

    // Assert
    expect(forgotten).toBe('show');
    expect(recent.verdict(tag, push)).toBe('show');
    clock.now = 0;
  });
});
