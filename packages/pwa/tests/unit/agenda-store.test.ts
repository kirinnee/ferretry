import { describe, it } from 'bun:test';
import should from 'should';
import { DaemonAgendaStore } from '../../src/lib/agenda-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'token-b' });
const scopeA = daemonSessionScope(daemonA, 'same-session');
const scopeB = daemonSessionScope(daemonB, 'same-session');

const agenda = (sessionId: string, count = 1): unknown => ({
  v: 1,
  sessionId,
  items: Array.from({ length: count }, (_, index) => ({
    id: `A${index + 1}`,
    source: 'question',
    sourceRef: null,
    subject: `Question ${index + 1}`,
    why: 'A decision is needed.',
    waitingSince: '2026-07-31T00:00:00.000Z',
    howToResolve: 'Choose an option.',
    raisedBy: 'human',
    raisedBySession: null,
    raisedByName: null,
  })),
  resolved: [],
  count,
  parseErrors: 0,
  updatedAt: '2026-07-31T00:00:00.000Z',
});

describe('DaemonAgendaStore', () => {
  it('keeps matching session IDs from different daemons in distinct cache entries', () => {
    const store = new DaemonAgendaStore();

    should(store.applySnapshot(scopeA, agenda('same-session', 1))).be.true();
    should(store.applySnapshot(scopeB, agenda('same-session', 0))).be.true();

    should(store.agenda(scopeA)?.count).equal(1);
    should(store.agenda(scopeB)?.count).equal(0);
    should(store.count(scopeA)).equal(1);
    should(store.count(scopeB)).equal(0);
    should(store.status(scopeA)).equal('ready');
    should(store.status(scopeB)).equal('ready');
  });

  it('rejects malformed and scope-mismatched responses without overwriting valid data', () => {
    const store = new DaemonAgendaStore();
    store.applySnapshot(scopeA, agenda('same-session', 1));

    should(store.applySnapshot(scopeA, agenda('another-session', 1))).be.false();
    should(store.agenda(scopeA)?.count).equal(1);
    should(store.status(scopeA)).equal('error');
    should(store.applyCount(scopeB, { sessionId: 'wrong-session', count: 4 })).be.false();
    should(store.count(scopeB)).be.undefined();
    should(store.applyCount(scopeB, { sessionId: 'same-session', count: -1 })).be.false();
  });

  it('publishes transitions, supports count-only reads, and retains a stable idle state', () => {
    const store = new DaemonAgendaStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    should(store.getSnapshot().counts).have.size(0);
    should(store.status(scopeA)).equal('idle');
    store.beginLoad(scopeA);
    store.beginLoad(scopeA);
    should(store.applyCount(scopeA, { sessionId: 'same-session', count: 3 })).be.true();
    store.fail(scopeA);
    unsubscribe();
    store.beginLoad(scopeB);

    should(store.count(scopeA)).equal(3);
    should(store.agenda(scopeA)).be.undefined();
    should(store.status(scopeA)).equal('error');
    should(notifications).equal(3);
  });

  it('forgets one scoped value and clears only the selected daemon', () => {
    const store = new DaemonAgendaStore();
    store.applySnapshot(scopeA, agenda('same-session', 1));
    store.applySnapshot(scopeB, agenda('same-session', 1));

    should(store.forget(scopeA)).be.true();
    should(store.forget(scopeA)).be.false();
    should(store.agenda(scopeA)).be.undefined();
    should(store.agenda(scopeB)).not.be.undefined();
    store.clearDaemon(daemonB.daemonId);
    store.clearDaemon(daemonB.daemonId);
    should(store.agenda(scopeB)).be.undefined();
  });
});
