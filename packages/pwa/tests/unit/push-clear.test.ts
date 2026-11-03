/**
 * A handled agenda item's alerts coming down (docs/notifications.md § When an alert is cleared). The owner: "when on 1
 * device is alr replied or resolved. then it should dismiss on other phones"; their decision !A324: an iPhone swaps in
 * a quiet note.
 */
import { describe, expect, it } from 'bun:test';
import { agendaItemPushTag, type PushClearPayload, type PushSeenResponse } from '@ferretry/protocol';
import { daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import { NOTIFICATION_BADGE, NOTIFICATION_ICON } from '../../src/lib/notify.ts';
import {
  applyClear,
  CLEARED_TAG_MEMORY_MS,
  type ClearRegistration,
  closeShownTags,
  HANDLED_BODY,
  HANDLED_TAG_PREFIX,
  HANDLED_TITLE,
  handledNotification,
  isApplePushService,
  planClear,
  RecentlyCleared,
  settleIfCleared,
  shownTag,
} from '../../src/lib/push-clear.ts';
import { agendaItemOpenedHandler, machinePushRegistration } from '../../src/lib/push-seen.ts';
import { postAgendaItemSeen } from '../../src/lib/push-subscriptions.ts';

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
    private readonly showing: Readonly<Record<string, number>>,
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

  async getNotifications(options: { tag: string }): Promise<readonly { close(): void }[]> {
    return Array.from({ length: this.showing[options.tag] ?? 0 }, () => ({
      close: () => void this.closed.push(options.tag),
    }));
  }

  async showNotification(title: string, options?: NotificationOptions): Promise<void> {
    this.shown.push({ title, ...(options === undefined ? {} : { options }) });
  }
}

describe('which push service delivers this registration', () => {
  it('should read Apple’s from its endpoint, whatever the device calls itself', () => {
    // Act / Assert
    expect(isApplePushService(APPLE)).toBe(true);
    expect(isApplePushService('https://api.push.apple.com/x')).toBe(true);
    expect(isApplePushService(FCM)).toBe(false);
    expect(isApplePushService('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(false);
    expect(isApplePushService('https://wns2-db5p.notify.windows.com/w/?token=x')).toBe(false);
    // Not Apple's just because the name ends like it.
    expect(isApplePushService('https://push.apple.com.example.test/x')).toBe(false);
  });

  it('should treat a subscription it cannot read as Apple’s, the answer that only costs a quiet line', () => {
    // Act / Assert
    expect(isApplePushService(null)).toBe(true);
    expect(isApplePushService(undefined)).toBe(true);
    expect(isApplePushService('not a url')).toBe(true);
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
      data: { url: `${ORIGIN}/d/${encodeURIComponent(WORK.daemonId)}` },
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

  const world = (options: { features?: readonly string[]; seen?: () => Promise<PushSeenResponse> } = {}) => {
    const registration = new FakeRegistration({ [itemTag]: 1, [stopTag]: 1 });
    const told: string[][] = [];
    const opened = agendaItemOpenedHandler({
      registration: async () => registration,
      health: async () => ({ features: options.features ?? ['push.clear.1'] }),
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

  it('should close the item’s line but tell nothing to a machine that does not list push.clear.1', async () => {
    // Arrange
    const { registration, told, opened } = world({ features: [] });

    // Act
    const result = await opened(connection, 'session-1', 'A3');

    // Assert
    expect(result).toEqual({ closed: 1, told: false });
    expect(told).toEqual([]);
    expect(registration.closed).toEqual([itemTag]);
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
      health: async () => ({ features: ['push.clear.1'] }),
      seen: async () => ({ cleared: true, tags: ['attention-session-1'] }),
    });
    const refusing = agendaItemOpenedHandler({
      registration: async () => ({
        getNotifications: async () => {
          throw new Error('notifications are blocked');
        },
      }),
      health: async () => ({ features: ['push.clear.1'] }),
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
      health: async () => ({ features: ['push.clear.1'] }),
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

    async getNotifications(options: { tag: string }): Promise<readonly { close(): void }[]> {
      return Array.from({ length: this.lines.get(options.tag) ?? 0 }, () => ({
        close: () => void this.lines.delete(options.tag),
      }));
    }

    async showNotification(title: string, options?: NotificationOptions): Promise<void> {
      this.shown.push({ title, tag: options?.tag });
      if (options?.tag !== undefined) this.lines.set(options.tag, 1);
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
    expect(registration.shown).toEqual([{ title: 'Work laptop · Handled on another device', tag }]);
  });

  it('should take the line down after it showed, when the clear ran while it was being shown', async () => {
    // Arrange — the push checked (nothing cleared yet), then the clear ran, then the line went up.
    const registration = new LiveRegistration(FCM);
    const recent = order();
    const push = recent.arrived();
    expect(await settleIfCleared(registration, tag, recent, push, WORK, ORIGIN)).toBe(false);
    await applyClear(registration, clear(['attention-session-1:A3']), WORK, ORIGIN, {
      recent,
      place: recent.arrived(),
    });
    await registration.showNotification('Work laptop · Deploy?', { tag });

    // Act
    const settled = await settleIfCleared(registration, tag, recent, push, WORK, ORIGIN);

    // Assert
    expect(settled).toBe(true);
    expect(registration.lines.has(tag)).toBe(false);
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
    expect(recent.clearedAfter(shownTag('attention-session-1:A4', WORK), 0)).toBe(false);
  });

  it(`should forget a clear after ${CLEARED_TAG_MEMORY_MS / 1000} s`, () => {
    // Arrange
    clock.now = 0;
    const recent = order();
    const push = recent.arrived();
    recent.remember([tag], recent.arrived());

    // Act
    clock.now = CLEARED_TAG_MEMORY_MS + 1;
    const forgotten = recent.clearedAfter(tag, push);
    recent.remember([shownTag('attention-session-1:A4', WORK)], recent.arrived());

    // Assert
    expect(forgotten).toBe(false);
    expect(recent.clearedAfter(tag, push)).toBe(false);
    clock.now = 0;
  });
});
