/**
 * Opening an agenda item here: this device closes its own lines for it, and tells the machine (docs/notifications.md
 * § When an alert is cleared). The clear itself, and the worker that runs it, are the shell's (`@ferretry/app`).
 */
import { describe, expect, it } from 'bun:test';
import { agendaItemPushTag, type PushSeenResponse } from '../../../contract/index.ts';
import {
  type ClearRegistration,
  daemonConnection,
  daemonId,
  type ShownNotification,
  shownTag,
} from '../../../app/shell-pairing.ts';
import { agendaItemOpenedHandler, machinePushRegistration } from '../../../app/lib/push-seen.ts';

const ORIGIN = 'https://ferretry.example.test';
const HOME = { daemonId: 'home', label: 'Home' };
const FCM = 'https://fcm.googleapis.com/fcm/send/abc';

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

describe('machinePushRegistration (which registration holds a machine’s lines here)', () => {
  const scope = `${ORIGIN}/push/home/`;
  const registration = new FakeRegistration({});

  it('should answer the machine’s own registration, and nothing for the app-wide one a lookup falls back to', async () => {
    // Arrange
    const asked: string[] = [];
    const own = machinePushRegistration(
      {
        serviceWorker: {
          getRegistration: async url => {
            asked.push(url);
            return Object.assign(registration, { scope });
          },
        },
      },
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
