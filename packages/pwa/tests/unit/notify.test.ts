import { describe, it } from 'bun:test';
import should from 'should';

import { daemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { buildNotification, summaryNotification } from '../../src/lib/notification-ledger.ts';
import {
  groupedNotificationBody,
  NOTIFICATION_PAYLOAD_VERSION,
  type NotificationDataLike,
  type NotificationPayload,
  type NotificationRegistrationLike,
  type NotificationSurface,
  type PageNotificationLike,
  notificationPayload,
  planNotificationPresentation,
  showGroupedNotification,
  showNotification,
} from '../../src/lib/notify.ts';
import { sessionView } from '../support/sessions.ts';

const daemonA = daemonId('daemon-a');
const daemonB = daemonId('daemon-b');

const scopeA = daemonSessionScope({ daemonId: daemonA }, 'ses-1');
const scopeB = daemonSessionScope({ daemonId: daemonB }, 'ses-1');

const questionSpec = (scope = scopeA) =>
  buildNotification(scope, sessionView(scope.sessionId, { state: { status: 'awaiting_question' } }), 'question', 3);

const payload = (over: Partial<NotificationPayload> = {}): NotificationPayload => ({
  ...notificationPayload(questionSpec()),
  ...over,
});

/** A registration whose already-shown notifications the test controls outright. */
const registration = (
  existing: readonly { readonly data?: unknown }[],
): NotificationRegistrationLike & { readonly shown: { title: string; options?: NotificationOptions }[] } => {
  const shown: { title: string; options?: NotificationOptions }[] = [];
  return {
    shown,
    getNotifications: async () => existing,
    showNotification: async (title, options) => {
      shown.push({ title, ...(options === undefined ? {} : { options }) });
    },
  };
};

interface SurfaceLog {
  readonly navigated: string[];
  readonly closed: number[];
  readonly created: { title: string; body: string; tag: string }[];
}

const surface = (
  over: Partial<NotificationSurface> = {},
): { readonly surface: NotificationSurface; readonly log: SurfaceLog; readonly last: () => PageNotificationLike } => {
  const log: SurfaceLog = { navigated: [], closed: [], created: [] };
  const pages: PageNotificationLike[] = [];
  const base: NotificationSurface = {
    permission: () => 'granted',
    requestPermission: async () => 'granted',
    registration: async () => null,
    showOnPage: (title, options) => {
      log.created.push({ title, body: options.body, tag: options.tag });
      const page: PageNotificationLike = {
        onclick: null,
        close: () => log.closed.push(pages.length),
      };
      pages.push(page);
      return page;
    },
    navigate: path => log.navigated.push(path),
  };
  return {
    surface: { ...base, ...over },
    log,
    last: () => {
      const page = pages.at(-1);
      if (page === undefined) throw new Error('no page notification was created');
      return page;
    },
  };
};

describe('notificationPayload', () => {
  it('carries the daemon of a session notification beside its qualified tag and path', () => {
    const spec = questionSpec();
    const result = notificationPayload(spec);

    should(result.version).equal(NOTIFICATION_PAYLOAD_VERSION);
    should(result.daemonId).equal(daemonA);
    should(result.sessionId).equal('ses-1');
    should(result.kind).equal('question');
    should(result.tag).equal(spec.tag);
    should(result.url).equal(spec.url);
    should(result.count).equal(3);
    should(result.eventKey).equal(spec.eventKey);
  });

  it('omits the session fields a fleet summary does not have', () => {
    const result = notificationPayload(summaryNotification(daemonA, 7));

    should(Object.hasOwn(result, 'sessionId')).be.false();
    should(Object.hasOwn(result, 'kind')).be.false();
    should(Object.hasOwn(result, 'daemonId')).be.false();
    should(result.title).equal('ferretry');
  });

  it('keeps two daemons apart even for the same session id', () => {
    should(notificationPayload(questionSpec(scopeA)).tag).not.equal(notificationPayload(questionSpec(scopeB)).tag);
  });
});

describe('groupedNotificationBody', () => {
  it('leaves a single line alone', () => {
    should(groupedNotificationBody('one line', 1)).equal('one line');
  });

  it('appends the collapsed remainder', () => {
    should(groupedNotificationBody('latest line', 4)).equal('latest line\n+3 more');
  });
});

describe('planNotificationPresentation', () => {
  it('skips the transport twin of a payload already on screen', () => {
    const incoming = payload();

    should(planNotificationPresentation(incoming, [{ eventKey: incoming.eventKey, count: 1 }]).action).equal('skip');
  });

  it('raises a session count above the active notification it replaces', () => {
    const plan = planNotificationPresentation(payload({ count: 1 }), [{ eventKey: 'other', count: 5 }]);

    should(plan.action).equal('show');
    if (plan.action !== 'show') return;
    should(plan.count).equal(6);
    should(plan.body).equal('Asked you a question.\n+5 more');
    should(plan.data.daemonId).equal(daemonA);
    should(plan.data.sessionId).equal('ses-1');
    should(plan.data.latestBody).equal('Asked you a question.');
  });

  it('keeps its own count when the payload already counts higher', () => {
    const plan = planNotificationPresentation(payload({ count: 9 }), [{ eventKey: 'other', count: 2 }]);

    should(plan.action).equal('show');
    if (plan.action !== 'show') return;
    should(plan.count).equal(9);
  });

  it('caps the merged count at one hundred', () => {
    const plan = planNotificationPresentation(payload({ count: 1 }), [{ eventKey: 'other', count: 100 }]);

    should(plan.action).equal('show');
    if (plan.action !== 'show') return;
    should(plan.count).equal(100);
  });

  it('ignores a malformed or absent count on an active notification', () => {
    const existing: readonly NotificationDataLike[] = [
      { eventKey: 'a', count: 'seven' },
      { eventKey: 'b' },
      { eventKey: 'c', count: 1.5 },
    ];
    const plan = planNotificationPresentation(payload({ count: 2 }), existing);

    should(plan.action).equal('show');
    if (plan.action !== 'show') return;
    should(plan.count).equal(2);
  });

  it('never raises a fleet summary from a previous summary', () => {
    const summary = notificationPayload(summaryNotification(daemonA, 5));
    const plan = planNotificationPresentation(summary, [{ eventKey: 'older', count: 40 }]);

    should(plan.action).equal('show');
    if (plan.action !== 'show') return;
    should(plan.count).equal(1);
    should(Object.hasOwn(plan.data, 'daemonId')).be.false();
    should(Object.hasOwn(plan.data, 'sessionId')).be.false();
  });
});

describe('showGroupedNotification', () => {
  it('shows a silent replacement under the daemon-qualified tag', async () => {
    const incoming = payload({ count: 2 });
    const target = registration([{ data: null }, { data: 'not an object' }, { data: { eventKey: 'older' } }]);

    should(await showGroupedNotification(target, incoming)).equal('shown');
    should(target.shown).have.length(1);
    should(target.shown[0]?.title).equal(incoming.title);
    should(target.shown[0]?.options?.tag).equal(incoming.tag);
    should((target.shown[0]?.options as { renotify?: boolean } | undefined)?.renotify).be.false();
  });

  it('reports the duplicate rather than re-alerting', async () => {
    const incoming = payload();
    const target = registration([{ data: { eventKey: incoming.eventKey } }]);

    should(await showGroupedNotification(target, incoming)).equal('duplicate');
    should(target.shown).be.empty();
  });
});

describe('showNotification', () => {
  it('suppresses everything until the reader has granted permission', async () => {
    const { surface: target, log } = surface({ permission: () => 'default' });

    should(await showNotification(target, payload())).equal('suppressed');
    should(log.created).be.empty();
  });

  it('prefers the registration when one exists', async () => {
    const target = registration([]);
    const { surface: withWorker, log } = surface({ registration: async () => target });

    should(await showNotification(withWorker, payload())).equal('shown');
    should(target.shown).have.length(1);
    should(log.created).be.empty();
  });

  it('falls back to the page when the registration lookup rejects', async () => {
    const {
      surface: broken,
      log,
      last,
    } = surface({
      registration: async () => {
        throw new Error('registration revoked mid-session');
      },
    });

    should(await showNotification(broken, payload({ count: 2 }))).equal('shown');
    should(log.created).have.length(1);
    should(log.created[0]?.body).equal('Asked you a question.\n+1 more');

    const page = last();
    page.onclick?.call(page, {});
    should(log.navigated).deepEqual([payload().url]);
    should(log.closed).have.length(1);
  });

  it('reports unavailable where the page constructor is absent', async () => {
    const { surface: pageless } = surface({ showOnPage: null });

    should(await showNotification(pageless, payload())).equal('unavailable');
  });

  it('reports unavailable when the page constructor throws', async () => {
    const { surface: refusing } = surface({
      showOnPage: () => {
        throw new Error('a worker controls this page');
      },
    });

    should(await showNotification(refusing, payload())).equal('unavailable');
  });
});
