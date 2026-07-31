import { describe, it } from 'bun:test';
import should from 'should';
import {
  CONTROLS_KEY,
  CONTROLS_VERSION,
  controlsFor,
  DaemonControlsStore,
  DEFAULT_DEVICE_CONTROLS,
  browserControlsStorage,
  emptyControlsRecord,
  evictDaemonScopes,
  MAX_DAEMON_SCOPES,
  parseControlsRecord,
  RETRY_DAEMON_SCOPES,
  withDaemonScope,
  withDeviceControls,
  withoutDaemonScope,
  type ControlsRecord,
  type ControlsStorage,
} from '../../src/lib/controls.ts';
import { daemonId } from '../../src/lib/daemon-connection.ts';

const alpha = daemonId('daemon-alpha');
const beta = daemonId('daemon-beta');

/** Records every write so a no-op patch can be proved to write nothing. */
class MemoryStorage implements ControlsStorage {
  readonly writes: string[] = [];
  #value: string | null;

  constructor(value: string | null = null) {
    this.#value = value;
  }

  getItem(): string | null {
    return this.#value;
  }

  setItem(_key: string, value: string): void {
    this.#value = value;
    this.writes.push(value);
  }

  record(): ControlsRecord {
    return parseControlsRecord(this.#value);
  }
}

const stored = (record: unknown): string => JSON.stringify(record);

const scopeRecord = (entries: readonly (readonly [string, string, number])[]): ControlsRecord => {
  let record = emptyControlsRecord();
  for (const [id, projectScope, seq] of entries) {
    record = { ...record, scopes: { ...record.scopes, [id]: { projectScope, seq } } };
  }
  return record;
};

describe('parseControlsRecord — kteam controls cases, on the new nested shape', () => {
  it('keeps every persisted device field and leaves density implicit', () => {
    const record = parseControlsRecord(
      stored({
        v: CONTROLS_VERSION,
        device: {
          query: 'transcript',
          mode: 'interactive',
          rcOnly: true,
          includeFinished: true,
          dashboardView: 'table',
          sidebarCollapsed: true,
        },
      }),
    );

    should(record.device).eql({
      query: 'transcript',
      mode: 'interactive',
      rcOnly: true,
      includeFinished: true,
      dashboardView: 'table',
      // Absent means "follow the device", not a written default.
      density: null,
      // A payload written before `chatWidth` existed degrades to 'full', which
      // IS the previous behaviour — so the field cannot change what an older
      // blob meant, which is why it needed no version bump.
      chatWidth: 'full',
      sidebarCollapsed: true,
    });
    // The old shape had no daemon scopes at all.
    should(Object.keys(record.scopes)).be.empty();
  });

  it('accepts a persisted scope per daemon and rejects non-strings and empty', () => {
    const record = parseControlsRecord(
      stored({
        v: CONTROLS_VERSION,
        scopes: {
          [alpha]: { projectScope: '/home/kirin/work', seq: 1 },
          // Empty string is not "scoped to a folder called nothing" — it is no
          // scope, so the entry is dropped rather than remembered as blank.
          [beta]: { projectScope: '', seq: 2 },
          'daemon-gamma': { projectScope: 42, seq: 3 },
        },
      }),
    );

    should(controlsFor(record, alpha).projectScope).equal('/home/kirin/work');
    should(controlsFor(record, beta).projectScope).be.null();
    should(controlsFor(record, daemonId('daemon-gamma')).projectScope).be.null();
  });

  it('preserves both existing chatWidth values, accepts balanced, and rejects anything else', () => {
    for (const chatWidth of ['full', 'balanced', 'readable'] as const) {
      should(parseControlsRecord(stored({ v: CONTROLS_VERSION, device: { chatWidth } })).device.chatWidth).equal(
        chatWidth,
      );
    }
    should(parseControlsRecord(stored({ v: CONTROLS_VERSION, device: { chatWidth: 'wide' } })).device.chatWidth).equal(
      'full',
    );
  });

  it('accepts each valid persisted density and mode, and rejects the rest', () => {
    for (const density of ['full', 'compact', 'minimal'] as const) {
      should(parseControlsRecord(stored({ v: CONTROLS_VERSION, device: { density } })).device.density).equal(density);
    }
    should(parseControlsRecord(stored({ v: CONTROLS_VERSION, device: { density: 'tiny' } })).device.density).be.null();

    for (const mode of ['all', 'auto', 'interactive'] as const) {
      should(parseControlsRecord(stored({ v: CONTROLS_VERSION, device: { mode } })).device.mode).equal(mode);
    }
    should(parseControlsRecord(stored({ v: CONTROLS_VERSION, device: { mode: 'headless' } })).device.mode).equal('all');
    should(
      parseControlsRecord(stored({ v: CONTROLS_VERSION, device: { dashboardView: 'grid' } })).device.dashboardView,
    ).be.null();
    const cards = parseControlsRecord(stored({ v: CONTROLS_VERSION, device: { dashboardView: 'cards' } }));
    should(cards.device.dashboardView).equal('cards');
  });

  it('falls back field by field so one bad field cannot poison the others', () => {
    const record = parseControlsRecord(
      stored({
        v: CONTROLS_VERSION,
        device: { query: 'keep me', density: 'tiny', sidebarCollapsed: 'yes', rcOnly: 1, includeFinished: null },
      }),
    );

    should(record.device.query).equal('keep me');
    should(record.device.density).be.null();
    should(record.device.sidebarCollapsed).be.false();
    should(record.device.rcOnly).be.false();
    should(record.device.includeFinished).be.false();
  });

  it('resets cleanly on a corrupt, non-object, array or wrong-version payload', () => {
    const defaults = emptyControlsRecord();
    should(parseControlsRecord('{')).eql(defaults);
    should(parseControlsRecord(null)).eql(defaults);
    should(parseControlsRecord(undefined)).eql(defaults);
    should(parseControlsRecord('')).eql(defaults);
    should(parseControlsRecord('"a string"')).eql(defaults);
    should(parseControlsRecord('null')).eql(defaults);
    should(parseControlsRecord(stored([1, 2]))).eql(defaults);
    should(parseControlsRecord(stored({ v: 2, device: { query: 'ignored' } }))).eql(defaults);
    should(parseControlsRecord(stored({ device: { query: 'ignored' } }))).eql(defaults);
  });

  it('ignores a kteam-shaped flat blob rather than migrating its un-namespaced scope', () => {
    // No `v: 1`, so this is a clean reset. The top-level projectScope kteam
    // wrote device-wide must never leak in without a daemon.
    const record = parseControlsRecord(
      stored({ query: 'transcript', chatWidth: 'readable', projectScope: '/home/kirin/work' }),
    );

    should(record).eql(emptyControlsRecord());
    should(controlsFor(record, alpha).projectScope).be.null();
  });

  it('drops individually unusable daemon entries and tolerates a non-object scopes field', () => {
    const record = parseControlsRecord(
      stored({
        v: CONTROLS_VERSION,
        scopes: {
          [alpha]: { projectScope: '/keep', seq: 3 },
          '': { projectScope: '/no-daemon', seq: 4 },
          'daemon-null': null,
          'daemon-text': 'not an object',
          'daemon-no-seq': { projectScope: '/x' },
          'daemon-bad-seq': { projectScope: '/x', seq: 'first' },
          'daemon-nan-seq': { projectScope: '/x', seq: Number.NaN },
        },
      }),
    );

    should(Object.keys(record.scopes)).eql([alpha]);
    should(Object.keys(parseControlsRecord(stored({ v: CONTROLS_VERSION, scopes: 'none' })).scopes)).be.empty();
    should(Object.keys(parseControlsRecord(stored({ v: CONTROLS_VERSION, scopes: [] })).scopes)).be.empty();
    should(Object.keys(parseControlsRecord(stored({ v: CONTROLS_VERSION, scopes: null })).scopes)).be.empty();
  });

  it('bounds a hand-edited overlong scope list on the way in, keeping the newest', () => {
    const entries = Array.from(
      { length: MAX_DAEMON_SCOPES + 5 },
      (_, index) => [`daemon-${index}`, `/project-${index}`, index] as const,
    );
    const record = parseControlsRecord(stored({ v: CONTROLS_VERSION, scopes: scopeRecord(entries).scopes }));

    should(Object.keys(record.scopes)).have.length(MAX_DAEMON_SCOPES);
    should(record.scopes['daemon-0']).be.undefined();
    should(record.scopes[`daemon-${MAX_DAEMON_SCOPES + 4}`]?.projectScope).equal(`/project-${MAX_DAEMON_SCOPES + 4}`);
  });
});

describe('pure transitions', () => {
  it('returns the SAME record when a device patch changes nothing', () => {
    const record = emptyControlsRecord();
    should(withDeviceControls(record, {})).be.exactly(record);
    should(withDeviceControls(record, { query: '', mode: 'all' })).be.exactly(record);
    // An explicitly undefined value leaves the field alone rather than clobbering it.
    should(withDeviceControls(record, { query: undefined })).be.exactly(record);
  });

  it('applies a device patch immutably and ignores explicit undefined and unknown keys', () => {
    const record = emptyControlsRecord();
    const next = withDeviceControls(record, { query: 'warden', density: 'compact' });

    should(next).not.be.exactly(record);
    should(record.device.query).equal('');
    should(next.device.query).equal('warden');
    should(next.device.density).equal('compact');

    const kept = withDeviceControls(next, { query: undefined, chatWidth: 'readable' } as Partial<
      typeof DEFAULT_DEVICE_CONTROLS
    >);
    should(kept.device.query).equal('warden');
    should(kept.device.chatWidth).equal('readable');
  });

  it('scopes a daemon, normalises blank to none, and never touches another daemon', () => {
    const record = emptyControlsRecord();
    const scoped = withDaemonScope(record, alpha, '/work/alpha');

    should(controlsFor(scoped, alpha).projectScope).equal('/work/alpha');
    should(controlsFor(scoped, beta).projectScope).be.null();
    // Re-asking for the identical scope is a no-op by identity.
    should(withDaemonScope(scoped, alpha, '/work/alpha')).be.exactly(scoped);
    // Blank and null both mean "whole fleet", so the entry is forgotten.
    should(controlsFor(withDaemonScope(scoped, alpha, ''), alpha).projectScope).be.null();
    should(Object.keys(withDaemonScope(scoped, alpha, null).scopes)).be.empty();
    // Clearing a daemon that never had a scope is a no-op by identity.
    should(withDaemonScope(record, alpha, null)).be.exactly(record);
    should(withoutDaemonScope(record, alpha)).be.exactly(record);
  });

  it('advances recency deterministically without a clock', () => {
    let record = emptyControlsRecord();
    record = withDaemonScope(record, alpha, '/work/alpha');
    record = withDaemonScope(record, beta, '/work/beta');

    should(record.scopes[alpha]?.seq).equal(0);
    should(record.scopes[beta]?.seq).equal(1);
    // Changing alpha's scope makes it the most recent.
    record = withDaemonScope(record, alpha, '/work/alpha-2');
    should(record.scopes[alpha]?.seq).equal(2);
  });

  it('evicts the least recently changed scope once the bound is exceeded', () => {
    let record = emptyControlsRecord();
    for (let index = 0; index <= MAX_DAEMON_SCOPES; index += 1) {
      record = withDaemonScope(record, daemonId(`daemon-${index}`), `/project-${index}`);
    }

    should(Object.keys(record.scopes)).have.length(MAX_DAEMON_SCOPES);
    should(record.scopes['daemon-0']).be.undefined();
    should(record.scopes[`daemon-${MAX_DAEMON_SCOPES}`]?.projectScope).equal(`/project-${MAX_DAEMON_SCOPES}`);
    // Within the bound, eviction is an identity no-op.
    const bounded = scopeRecord([['daemon-x', '/x', 1]]);
    should(evictDaemonScopes(bounded)).be.exactly(bounded);
  });
});

describe('DaemonControlsStore', () => {
  it('hydrates once from storage and keeps snapshot and merged views identity-stable', () => {
    const storage = new MemoryStorage(
      stored({
        v: CONTROLS_VERSION,
        device: { query: 'warden', chatWidth: 'balanced' },
        scopes: { [alpha]: { projectScope: '/work/alpha', seq: 0 } },
      }),
    );
    const store = new DaemonControlsStore(storage);

    should(store.snapshot()).be.exactly(store.snapshot());
    should(store.controls(alpha)).be.exactly(store.controls(alpha));
    should(store.controls(alpha).query).equal('warden');
    should(store.controls(alpha).projectScope).equal('/work/alpha');
  });

  it('gives two daemons the same device preferences and different scopes', () => {
    const store = new DaemonControlsStore(new MemoryStorage());

    store.setControls(alpha, { projectScope: '/work/alpha', density: 'compact' });
    store.setControls(beta, { projectScope: '/work/beta' });

    should(store.controls(alpha).projectScope).equal('/work/alpha');
    should(store.controls(beta).projectScope).equal('/work/beta');
    // The device preference is shared; the daemon-derived path is not.
    should(store.controls(alpha).density).equal('compact');
    should(store.controls(beta).density).equal('compact');
  });

  it('never lets a scope survive its daemon, and re-pairing starts unscoped', () => {
    const storage = new MemoryStorage();
    const store = new DaemonControlsStore(storage);
    store.setControls(alpha, { projectScope: '/work/alpha' });
    store.setControls(beta, { projectScope: '/work/beta' });

    should(store.clearDaemon(alpha)).be.true();
    should(store.controls(alpha).projectScope).be.null();
    should(store.controls(beta).projectScope).equal('/work/beta');
    // Clearing again changes nothing.
    should(store.clearDaemon(alpha)).be.false();
    // A daemon that pairs again is unscoped until the reader chooses a scope,
    // never restored to what a previous pairing had.
    should(new DaemonControlsStore(storage).controls(alpha).projectScope).be.null();
    should(new DaemonControlsStore(storage).controls(beta).projectScope).equal('/work/beta');
  });

  it('persists device and scope changes under the sole controls key', () => {
    const storage = new MemoryStorage();
    const store = new DaemonControlsStore(storage);

    store.setControls(alpha, { query: 'transcript', projectScope: '/work/alpha' });
    should(storage.writes).have.length(1);
    should(storage.record().device.query).equal('transcript');
    should(controlsFor(storage.record(), alpha).projectScope).equal('/work/alpha');
    should(CONTROLS_KEY).equal('fy-controls-v1');
  });

  it('writes nothing and notifies nobody for a patch that changes nothing', () => {
    const storage = new MemoryStorage();
    const store = new DaemonControlsStore(storage);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    const before = store.controls(alpha);
    should(store.setControls(alpha, { query: '', projectScope: null })).be.exactly(before);
    should(store.setControls(alpha, {})).be.exactly(before);
    // A no-op keeps the very same device object, not an equal copy.
    should(store.setDeviceControls({ mode: 'all' })).be.exactly(store.snapshot().device);
    should(storage.writes).be.empty();
    should(notifications).equal(0);

    store.setControls(alpha, { query: 'now different' });
    should(notifications).equal(1);
    should(storage.writes).have.length(1);

    unsubscribe();
    store.setControls(alpha, { query: 'after unsubscribe' });
    should(notifications).equal(1);
    should(storage.writes).have.length(2);
  });

  it('treats a present projectScope key of undefined as clearing the scope', () => {
    const store = new DaemonControlsStore(new MemoryStorage());
    store.setControls(alpha, { projectScope: '/work/alpha' });

    should(store.setControls(alpha, { projectScope: undefined }).projectScope).be.null();
  });

  it('treats a whitespace-only scope as no scope, and stores a valid one unmodified', () => {
    const store = new DaemonControlsStore(new MemoryStorage());

    // Empty and whitespace-only are both "no scope", per the same blank rule
    // `daemonId` and `upsertDraft` use.
    for (const blank of ['', ' ', '\t', '\n  ']) {
      should(store.setControls(alpha, { projectScope: blank }).projectScope).be.null();
    }
    const blankScope = parseControlsRecord(
      stored({ v: CONTROLS_VERSION, scopes: { [alpha]: { projectScope: '   ', seq: 1 } } }),
    );
    should(Object.keys(blankScope.scopes)).be.empty();

    // A real path survives byte for byte: a group key is compared against
    // daemon-supplied paths and must not be silently rewritten.
    should(store.setControls(alpha, { projectScope: '/work/a b' }).projectScope).equal('/work/a b');
  });

  it('reuses the merged view of a daemon whose scope did not change', () => {
    const store = new DaemonControlsStore(new MemoryStorage());
    store.setControls(alpha, { projectScope: '/work/alpha' });
    store.setControls(beta, { projectScope: '/work/beta' });
    const alphaBefore = store.controls(alpha);
    const betaBefore = store.controls(beta);

    // Only beta's scope moves, so alpha's view keeps its identity and a screen
    // reading alpha does not re-render.
    store.setControls(beta, { projectScope: '/work/beta-2' });
    should(store.controls(alpha)).be.exactly(alphaBefore);
    should(store.controls(beta)).not.be.exactly(betaBefore);
    should(store.controls(beta).projectScope).equal('/work/beta-2');

    // Clearing a daemon likewise leaves the others' identity intact.
    const betaScoped = store.controls(beta);
    store.clearDaemon(alpha);
    should(store.controls(beta)).be.exactly(betaScoped);

    // A device preference legitimately changes every daemon's view.
    store.setDeviceControls({ density: 'minimal' });
    should(store.controls(beta)).not.be.exactly(betaScoped);
    should(store.controls(beta).density).equal('minimal');
  });

  it('applies device preferences with no daemon in context', () => {
    const store = new DaemonControlsStore(new MemoryStorage());
    store.setControls(alpha, { projectScope: '/work/alpha' });

    should(store.setDeviceControls({ sidebarCollapsed: true }).sidebarCollapsed).be.true();
    // A device patch must not disturb any daemon's scope.
    should(store.controls(alpha).projectScope).equal('/work/alpha');
    should(store.controls(alpha).sidebarCollapsed).be.true();
  });

  it('works with no storage at all, keeping controls for the life of the tab', () => {
    const store = new DaemonControlsStore(undefined);

    should(store.controls(alpha)).eql({ ...DEFAULT_DEVICE_CONTROLS, projectScope: null });
    should(store.setControls(alpha, { projectScope: '/work/alpha', query: 'q' }).projectScope).equal('/work/alpha');
    should(store.controls(alpha).query).equal('q');
  });

  it('falls back to defaults when the storage read itself throws', () => {
    const store = new DaemonControlsStore({
      getItem: () => {
        throw new Error('storage denied');
      },
      setItem: () => undefined,
    });

    should(store.snapshot()).eql(emptyControlsRecord());
  });

  it('retries a quota-denied write with only the most recent scopes', () => {
    let attempts = 0;
    const written: string[] = [];
    const store = new DaemonControlsStore({
      getItem: () =>
        stored({
          v: CONTROLS_VERSION,
          scopes: Object.fromEntries(
            Array.from({ length: RETRY_DAEMON_SCOPES + 3 }, (_, index) => [
              `daemon-${index}`,
              { projectScope: `/project-${index}`, seq: index },
            ]),
          ),
        }),
      setItem: (_key, value) => {
        attempts += 1;
        if (attempts === 1) throw new Error('QuotaExceededError');
        written.push(value);
      },
    });

    store.setControls(alpha, { query: 'busy' });

    should(attempts).equal(2);
    const retried = parseControlsRecord(written[0] ?? null);
    should(Object.keys(retried.scopes)).have.length(RETRY_DAEMON_SCOPES);
    // The in-memory controls are unaffected by how much of them persisted.
    should(store.controls(alpha).query).equal('busy');
  });

  it('keeps working when every write is denied', () => {
    const store = new DaemonControlsStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });

    should(store.setControls(alpha, { projectScope: '/work/alpha' }).projectScope).equal('/work/alpha');
    should(store.controls(alpha).projectScope).equal('/work/alpha');
  });

  it('detects a real browser store and refuses anything that only looks like one', () => {
    const backing = new MemoryStorage();
    should(browserControlsStorage({ localStorage: backing })).be.exactly(backing);

    should(browserControlsStorage({})).be.undefined();
    should(browserControlsStorage({ localStorage: null })).be.undefined();
    should(browserControlsStorage({ localStorage: { getItem: 'not a function' } })).be.undefined();
    should(browserControlsStorage({ localStorage: { getItem: () => null } })).be.undefined();

    // Reading `localStorage` at all throws in some privacy modes; that is an
    // ordinary condition, not an error the reader can act on. Injected rather
    // than done to the real global, which the rest of the suite depends on.
    should(
      browserControlsStorage({
        get localStorage() {
          throw new Error('access denied');
        },
      }),
    ).be.undefined();
  });

  it('uses the ambient browser store when constructed with no argument', () => {
    // Whatever this environment provides, resolving it must not throw and a
    // default-constructed store must still answer with usable controls.
    const ambient = browserControlsStorage();
    if (ambient !== undefined) {
      should(ambient.getItem).be.a.Function();
      should(ambient.setItem).be.a.Function();
    }
    should(new DaemonControlsStore().controls(alpha)).have.property('projectScope');
  });

  it('supports a daemon ID that collides with an object prototype key', () => {
    // A DaemonId is any non-blank string. On an ordinary object
    // `scopes.__proto__ = entry` hits the prototype setter and stores nothing,
    // and `'toString' in scopes` is true for a daemon with no scope at all.
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const hostile = daemonId(name);
      const storage = new MemoryStorage();
      const store = new DaemonControlsStore(storage);

      should(store.controls(hostile).projectScope).be.null();
      // No scope yet, so clearing must be a no-op rather than a spurious write.
      should(store.clearDaemon(hostile)).be.false();
      should(storage.writes).be.empty();

      should(store.setControls(hostile, { projectScope: `/work/${name}` }).projectScope).equal(`/work/${name}`);
      should(store.controls(hostile).projectScope).equal(`/work/${name}`);
      // It has to survive a reload, and must not leak onto another daemon.
      should(new DaemonControlsStore(storage).controls(hostile).projectScope).equal(`/work/${name}`);
      should(new DaemonControlsStore(storage).controls(alpha).projectScope).be.null();

      should(store.clearDaemon(hostile)).be.true();
      should(store.controls(hostile).projectScope).be.null();
      should(new DaemonControlsStore(storage).controls(hostile).projectScope).be.null();
    }
  });

  it('parses a persisted __proto__ entry as an own key without polluting anything', () => {
    // Hand-written JSON, because a `__proto__:` object literal would set the
    // prototype instead of creating the key this must survive.
    const record = parseControlsRecord('{"v":1,"scopes":{"__proto__":{"projectScope":"/p","seq":1}}}');

    should(Object.getPrototypeOf(record.scopes)).be.null();
    should(Object.keys(record.scopes)).eql(['__proto__']);
    should(controlsFor(record, daemonId('__proto__')).projectScope).equal('/p');
    // Nothing has been grafted onto ordinary objects.
    should(({} as Record<string, unknown>).projectScope).be.undefined();
    should(controlsFor(record, alpha).projectScope).be.null();
  });
});
