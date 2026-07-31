import { describe, it } from 'bun:test';
import type { PinSnapshot } from '@ferretry/protocol';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonPinStore } from '../../src/lib/pin-store.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
const scopeA = daemonSessionScope(daemonA, 'same-session');
const scopeB = daemonSessionScope(daemonB, 'same-session');

const snapshot = (sessionId: string, updatedAt = '2026-07-31T00:00:00.000Z'): PinSnapshot => ({
  v: 1,
  sessionId,
  pins: [],
  updatedAt,
});

describe('daemon-scoped pin cache', () => {
  it('keeps matching session IDs from separate daemons in separate snapshots', () => {
    const store = new DaemonPinStore();
    should(store.applySnapshot(scopeA, snapshot('same-session', '2026-07-31T00:00:00.000Z'))).be.true();
    should(store.applySnapshot(scopeB, snapshot('same-session', '2026-07-31T01:00:00.000Z'))).be.true();

    should(store.pins(scopeA)?.updatedAt).equal('2026-07-31T00:00:00.000Z');
    should(store.pins(scopeB)?.updatedAt).equal('2026-07-31T01:00:00.000Z');
    should(store.status(scopeA)).equal('ready');
    should(store.status(scopeB)).equal('ready');
  });

  it('rejects malformed and mismatched daemon responses without replacing a valid cache entry', () => {
    const store = new DaemonPinStore();
    store.applySnapshot(scopeA, snapshot('same-session'));

    should(store.applySnapshot(scopeA, snapshot('other-session'))).be.false();
    should(store.applySnapshot(scopeA, { ...snapshot('same-session'), pins: [{ kind: 'note' }] })).be.false();
    should(store.pins(scopeA)?.sessionId).equal('same-session');
    should(store.status(scopeA)).equal('error');
  });

  it('publishes immutable transitions and avoids duplicate load notifications', () => {
    const store = new DaemonPinStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    const initial = store.getSnapshot();
    store.beginLoad(scopeA);
    const loading = store.getSnapshot();
    store.beginLoad(scopeA);
    store.applySnapshot(scopeA, snapshot('same-session'));

    should(initial).not.equal(loading);
    should(loading).not.equal(store.getSnapshot());
    should(notifications).equal(2);
    unsubscribe();
    store.fail(scopeA);
    should(notifications).equal(2);
  });

  it('forgets and disconnects only the requested daemon scope', () => {
    const store = new DaemonPinStore();
    store.applySnapshot(scopeA, snapshot('same-session'));
    store.applySnapshot(scopeB, snapshot('same-session'));

    should(store.forget(scopeA)).be.true();
    should(store.forget(scopeA)).be.false();
    should(store.pins(scopeA)).be.undefined();
    should(store.pins(scopeB)).not.be.undefined();
    store.clearDaemon(daemonB.daemonId);
    should(store.pins(scopeB)).be.undefined();
  });

  it('reconciles or restores an echo only while its exact scoped value is current', () => {
    const store = new DaemonPinStore();
    store.applySnapshot(scopeA, snapshot('same-session'));
    const echo = store.applyEcho(scopeA, snapshot('same-session', '2026-07-31T01:00:00.000Z'));

    should(echo.scope).equal(scopeA);
    should(store.reconcileEcho(echo, snapshot('same-session', '2026-07-31T02:00:00.000Z'))).be.true();
    should(store.pins(scopeA)?.updatedAt).equal('2026-07-31T02:00:00.000Z');
    should(store.restoreEcho(echo)).be.false();

    const replacement = store.applyEcho(scopeA, snapshot('same-session', '2026-07-31T03:00:00.000Z'));
    store.applySnapshot(scopeA, snapshot('same-session', '2026-07-31T04:00:00.000Z'));
    should(store.reconcileEcho(replacement, snapshot('same-session', '2026-07-31T05:00:00.000Z'))).be.false();
    should(store.restoreEcho(replacement)).be.false();

    const before = store.pins(scopeA);
    const rollback = store.applyEcho(scopeA, snapshot('same-session', '2026-07-31T06:00:00.000Z'));
    should(store.restoreEcho(rollback)).be.true();
    should(store.pins(scopeA)).equal(before);
  });

  it('uses an unloaded echo as a fence without inventing a board', () => {
    const store = new DaemonPinStore();
    const echo = store.applyEcho(scopeA, undefined);
    should(store.pins(scopeA)).be.undefined();
    should(store.reconcileEcho(echo, snapshot('same-session'))).be.true();
    should(store.pins(scopeA)?.sessionId).equal('same-session');

    const empty = store.applyEcho(scopeB, undefined);
    should(store.restoreEcho(empty)).be.true();
    should(store.pins(scopeB)).be.undefined();
    should(() => store.applyEcho(scopeA, snapshot('other-session'))).throw(
      'pin echo must describe its requested session',
    );
  });
});
