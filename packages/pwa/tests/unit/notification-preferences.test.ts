import { describe, it } from 'bun:test';
import should from 'should';

import { daemonId } from '../../src/lib/daemon-connection.ts';
import {
  DaemonNotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCES_KEY,
  type NotificationPreferenceStorage,
  parseNotificationPreferenceStore,
  parseNotificationPreferences,
} from '../../src/lib/notification-preferences.ts';

const daemonA = daemonId('daemon-a');
const daemonB = daemonId('daemon-b');

class MemoryStorage implements NotificationPreferenceStorage {
  readonly values = new Map<string, string>();
  getError: Error | null = null;
  setError: Error | null = null;

  getItem(key: string): string | null {
    if (this.getError) throw this.getError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.setError) throw this.setError;
    this.values.set(key, value);
  }
}

describe('notification preference parsing', () => {
  it('should default every field independently and migrate needsYou', () => {
    // Act
    const actual = parseNotificationPreferences({
      enabled: true,
      events: { needsYou: false, question: 'yes', failed: false },
      interactiveOnly: 'no',
      onlyWhenHidden: false,
    });

    // Assert
    should(actual).deepEqual({
      enabled: true,
      events: { attention: false, question: true, failed: false, completed: true },
      interactiveOnly: false,
      onlyWhenHidden: false,
    });
    should(parseNotificationPreferences(42)).deepEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it('should reject malformed stores without losing valid daemon rows', () => {
    // Arrange
    const raw = JSON.stringify({
      version: 1,
      daemons: {
        '': { enabled: true },
        [daemonA]: { enabled: true, events: { completed: false } },
        [daemonB]: 'broken',
      },
    });

    // Act
    const actual = parseNotificationPreferenceStore(raw);

    // Assert
    should(actual.size).equal(1);
    should(actual.get(daemonA)?.enabled).be.true();
    should(actual.get(daemonA)?.events.completed).be.false();
    should(parseNotificationPreferenceStore(null).size).equal(0);
    should(parseNotificationPreferenceStore('garbage').size).equal(0);
    should(parseNotificationPreferenceStore(JSON.stringify({ version: 2, daemons: {} })).size).equal(0);
    should(parseNotificationPreferenceStore(JSON.stringify([])).size).equal(0);
  });
});

describe('DaemonNotificationPreferences', () => {
  it('should load and update identical settings independently by daemon', () => {
    // Arrange
    const storage = new MemoryStorage();
    storage.values.set(
      NOTIFICATION_PREFERENCES_KEY,
      JSON.stringify({ version: 1, daemons: { [daemonA]: { enabled: true }, [daemonB]: { enabled: false } } }),
    );
    const store = new DaemonNotificationPreferences(storage);

    // Act
    const nextA = store.set(daemonA, { events: { completed: false }, interactiveOnly: true });
    const nextB = store.set(daemonB, { enabled: true, onlyWhenHidden: false });

    // Assert
    should(nextA).deepEqual({
      enabled: true,
      events: { attention: true, question: true, failed: true, completed: false },
      interactiveOnly: true,
      onlyWhenHidden: true,
    });
    should(nextB.events.completed).be.true();
    should(nextB.onlyWhenHidden).be.false();
    const persisted = parseNotificationPreferenceStore(storage.values.get(NOTIFICATION_PREFERENCES_KEY) ?? null);
    should(persisted.get(daemonA)?.events.completed).be.false();
    should(persisted.get(daemonB)?.events.completed).be.true();
  });

  it('should notify only the changed daemon and allow unsubscribe', () => {
    // Arrange
    const store = new DaemonNotificationPreferences();
    const calls: string[] = [];
    const offA = store.subscribe(daemonA, () => calls.push('a'));
    store.subscribe(daemonB, () => calls.push('b'));

    // Act
    store.set(daemonA, { enabled: true });
    offA();
    store.set(daemonA, { enabled: false });
    store.set(daemonB, { enabled: true });

    // Assert
    should(calls).deepEqual(['a', 'b']);
  });

  it('should clear one daemon without changing another', () => {
    // Arrange
    const storage = new MemoryStorage();
    const store = new DaemonNotificationPreferences(storage);
    store.set(daemonA, { enabled: true });
    store.set(daemonB, { enabled: true, events: { question: false } });
    let cleared = 0;
    store.subscribe(daemonA, () => cleared++);

    // Act
    const deleted = store.clearDaemon(daemonA);
    const deletedAgain = store.clearDaemon(daemonA);

    // Assert
    should(deleted).be.true();
    should(deletedAgain).be.false();
    should(cleared).equal(1);
    should(store.get(daemonA)).deepEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    should(store.get(daemonB).enabled).be.true();
    should(store.get(daemonB).events.question).be.false();
  });

  it('should keep memory state when browser storage is denied', () => {
    // Arrange
    const deniedRead = new MemoryStorage();
    deniedRead.getError = new Error('denied');
    const readStore = new DaemonNotificationPreferences(deniedRead);
    const deniedWrite = new MemoryStorage();
    const writeStore = new DaemonNotificationPreferences(deniedWrite);
    deniedWrite.setError = new Error('quota');

    // Act
    const initial = readStore.get(daemonA);
    const next = writeStore.set(daemonA, { enabled: true });

    // Assert
    should(initial).deepEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    should(next.enabled).be.true();
    should(writeStore.get(daemonA).enabled).be.true();
  });
  it('should persist opaque daemon IDs as data rather than object metaproperties', () => {
    // Arrange
    const storage = new MemoryStorage();
    const store = new DaemonNotificationPreferences(storage);
    const prototypeId = daemonId('__proto__');
    const constructorId = daemonId('constructor');

    // Act
    store.set(prototypeId, { enabled: true });
    store.set(constructorId, { events: { failed: false } });
    const raw = storage.values.get(NOTIFICATION_PREFERENCES_KEY) ?? null;
    const document = JSON.parse(raw ?? 'null') as { daemons?: Record<string, unknown> } | null;
    const restored = parseNotificationPreferenceStore(raw);

    // Assert
    should(document).not.be.null();
    should(Object.hasOwn(document?.daemons ?? {}, '__proto__')).be.true();
    should(Object.hasOwn(document?.daemons ?? {}, 'constructor')).be.true();
    should(restored.get(prototypeId)?.enabled).be.true();
    should(restored.get(constructorId)?.events.failed).be.false();
  });
});
