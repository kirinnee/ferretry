import { describe, it } from 'bun:test';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import should from 'should';
import type { LoginFile, LoginView } from '../../../contract/index.ts';
import {
  type LoginChangeError,
  LoginChangeService,
  type LoginChangeServiceDeps,
} from '../../../daemon/lib/changes/service.ts';
import { loginChangesPort } from '../../../daemon/lib/changes/port.ts';
import { changeRoutes } from '../../../daemon/lib/routes/changes.ts';
import { call } from '../../support/call-route.ts';

const WRITTEN: ConfigWriteOutcome = { kind: 'written', etag: 'e', loosened: [] };

function world(overrides: Partial<LoginChangeServiceDeps> = {}) {
  let files = new Map<string, LoginFile>([['work', { harness: 'claude-code', store: 'ferretry' }]]);
  const writes: unknown[] = [];
  const events: unknown[] = [];
  let tick = 1_000;
  let n = 0;
  const service = new LoginChangeService({
    files: () => files,
    presets: async () => [],
    machineName: () => 'this machine',
    usedBy: async () => [],
    view: async id =>
      id === 'work'
        ? ({
            signOut: { available: true, sentence: 'Sign out of work? Every runtime on it then needs sign-in.' },
          } as unknown as LoginView)
        : undefined,
    signOut: async () => ({
      outcome: 'failed',
      reason: 'the harness could not sign out',
      credential: { id: 'work' } as unknown as LoginView,
    }),
    write: async (id, patch) => {
      writes.push({ id, patch });
      files = new Map(files).set(id, {
        ...(files.get(id) ?? { harness: 'claude-code', store: 'ferretry' }),
        ...patch,
      } as LoginFile);
      return WRITTEN;
    },
    remove: async id => {
      writes.push({ id, removed: true });
      return WRITTEN;
    },
    changed: (id, change) => events.push({ id, change }),
    now: () => tick,
    mintId: () => {
      n += 1;
      return `chg${String(n)}`;
    },
    ...overrides,
  });
  return {
    service,
    writes,
    events,
    advance: (ms: number) => {
      tick += ms;
    },
    setFiles: (next: Map<string, LoginFile>) => {
      files = next;
    },
  };
}

describe('LoginChangeService', () => {
  it('should stage a change, show what it does, and apply exactly what was previewed', async () => {
    const { service, writes, events } = world();

    const view = await service.stage({ kind: 'login.label', id: 'work', label: 'Work' });
    const outcome = await service.apply(view.id);

    should(view).containDeep({ summary: 'Label login work Work', state: 'pending' });
    should(outcome).deepEqual({ outcome: 'applied' });
    should(writes).deepEqual([{ id: 'work', patch: { label: 'Work' } }]);
    should(events).deepEqual([{ id: 'work', change: 'edited' }]);
  });

  it('should say which file a change saves and which runtimes are on the login', async () => {
    const { service } = world({ usedBy: async () => ['alpha'] });

    const label = await service.stage({ kind: 'login.label', id: 'work', label: 'Work' });
    const disable = await service.stage({ kind: 'login.disable', id: 'work' });
    const signOut = await service.stage({ kind: 'login.signout', id: 'work' });

    should(label.saves).deepEqual(['logins/work.yaml']);
    should(label.runtimes).deepEqual(['alpha']);
    should(disable.saves).deepEqual(['logins/work.yaml']);
    should(signOut.saves).be.undefined();
    should(signOut.runtimes).be.undefined();
  });

  it('should name no runtimes, and still stage, when the runtimes cannot be read', async () => {
    const { service } = world({
      usedBy: async () => {
        throw new Error('nothing answers');
      },
    });

    const view = await service.stage({ kind: 'login.enable', id: 'work' });

    should(view.runtimes).be.undefined();
    should(view.saves).deepEqual(['logins/work.yaml']);
  });

  it('should refuse to apply the same change twice', async () => {
    const { service } = world();
    const view = await service.stage({ kind: 'login.enable', id: 'work' });
    await service.apply(view.id);

    const error = (await service.apply(view.id).catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_consumed');
  });

  it('should refuse a change whose logins moved after it was reviewed, and keep it reviewable', async () => {
    const { service, writes, setFiles } = world();
    const view = await service.stage({ kind: 'login.enable', id: 'work' });
    setFiles(new Map([['work', { harness: 'claude-code', store: 'ferretry', label: 'moved' }]]));

    const error = (await service.apply(view.id).catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_stale');
    should(writes).deepEqual([]);
    should(service.view(view.id).state).equal('pending');
  });

  it('should expire a change nobody applied', async () => {
    const { service, advance } = world();
    const view = await service.stage({ kind: 'login.enable', id: 'work' });
    advance(16 * 60 * 1000);

    const error = (await service.apply(view.id).catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_expired');
  });

  it('should say the owner holds a loosening edit rather than claiming it applied', async () => {
    const held: ConfigWriteOutcome = {
      kind: 'held',
      etag: 'e',
      id: 'h',
      sentences: ['login "this login"\'s daily hard limit in dollars is removed (was 5)'],
    };
    const { service } = world({ write: async () => held });
    const view = await service.stage({ kind: 'login.label', id: 'work', label: 'Work' });

    should(await service.apply(view.id)).deepEqual({ outcome: 'held', sentences: held.sentences });
  });

  it('should stage a sign-out with its consequence sentence and report a failed one as such', async () => {
    const { service, events } = world();
    const view = await service.stage({ kind: 'login.signout', id: 'work' });

    should(view.consequences).deepEqual(['Sign out of work? Every runtime on it then needs sign-in.']);
    should(await service.apply(view.id)).containDeep({
      outcome: 'sign-out-failed',
      reason: 'the harness could not sign out',
    });
    should(events).deepEqual([{ id: 'work', change: 'signed-out' }]);
  });

  it('should refuse a sign-out of a login that cannot be signed out, in its own words', async () => {
    const { service } = world({
      view: async () =>
        ({
          signOut: { available: false, sentence: 'This login comes from an environment variable.' },
        }) as unknown as LoginView,
    });

    const error = (await service
      .stage({ kind: 'login.signout', id: 'work' })
      .catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_refused');
    should(error.message).equal('This login comes from an environment variable.');
  });

  it('should hold at most eight changes awaiting review', async () => {
    const { service } = world();
    for (let index = 0; index < 8; index += 1) await service.stage({ kind: 'login.enable', id: 'work' });

    const error = (await service
      .stage({ kind: 'login.enable', id: 'work' })
      .catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_refused');
  });
});

describe('LoginChangeService: login.env', () => {
  const envFiles = () =>
    new Map<string, LoginFile>([
      ['gate', { harness: 'claude-code', store: 'environment', env: { ANTHROPIC_BASE_URL: 'http://localhost:4000' } }],
    ]);

  it('should stage the variable change, write only the changed keys on apply, and announce an edit', async () => {
    const { service, writes, events, setFiles } = world();
    setFiles(envFiles());

    const view = await service.stage({
      kind: 'login.env',
      id: 'gate',
      env: { ANTHROPIC_BASE_URL: 'http://localhost:4001', TZ: 'UTC' },
    });
    const outcome = await service.apply(view.id);

    should(view).containDeep({ summary: 'Change the variables of login gate', state: 'pending' });
    should(outcome).deepEqual({ outcome: 'applied' });
    should(writes).deepEqual([
      {
        id: 'gate',
        patch: { env: { ANTHROPIC_BASE_URL: 'http://localhost:4001', TZ: 'UTC' }, cloudCredential: undefined },
      },
    ]);
    should(events).deepEqual([{ id: 'gate', change: 'edited' }]);
  });

  it('should refuse a raw secret at staging, hold nothing, and never put the value in the sentence', async () => {
    const { service, writes, setFiles } = world();
    setFiles(envFiles());
    const rawKey = 'sk-ant-api03-abcdefghijklmnopq';

    const error = (await service
      .stage({ kind: 'login.env', id: 'gate', env: { ANTHROPIC_BASE_URL: 'http://x', EXTRA: rawKey } })
      .catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_refused');
    should(error.message).match(/looks like a secret/u);
    should(error.message).not.containEql(rawKey);
    should(writes).deepEqual([]);
  });
});

describe('LoginChangeService: what an apply reports and announces', () => {
  it('should report a finished sign-out with the login as it stands now', async () => {
    const { service, events } = world({
      signOut: async () => ({ outcome: 'signed-out', credential: { id: 'work' } as unknown as LoginView }),
    });
    const view = await service.stage({ kind: 'login.signout', id: 'work' });

    should(await service.apply(view.id)).deepEqual({ outcome: 'signed-out', login: { id: 'work' } });
    should(events).deepEqual([{ id: 'work', change: 'signed-out' }]);
  });

  it('should announce an added login and a disabled login by what happened to them', async () => {
    const { service, events } = world();
    const added = await service.stage({ kind: 'login.add', id: 'second', harness: 'claude-code' });
    await service.apply(added.id);
    const disabled = await service.stage({ kind: 'login.disable', id: 'work' });
    await service.apply(disabled.id);

    should(events).deepEqual([
      { id: 'second', change: 'added' },
      { id: 'work', change: 'disabled' },
    ]);
  });

  it('should say the file moved while the apply ran, and keep the change reviewable', async () => {
    const { service } = world({ write: async () => ({ kind: 'conflict' }) });
    const view = await service.stage({ kind: 'login.enable', id: 'work' });

    const error = (await service.apply(view.id).catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_stale');
    should(error.message).equal('login work changed while this was being applied; review it again');
    should(service.view(view.id).state).equal('pending');
  });

  it('should carry the reasons a file was refused, or say the file was refused when none were given', async () => {
    const issues = [
      { path: 'label', message: 'too long' },
      { path: 'env', message: 'not a map' },
    ];
    const named = world({ write: async () => ({ kind: 'refused', reason: 'schema', issues }) });
    const bare = world({ write: async () => ({ kind: 'refused', reason: 'schema', issues: [] }) });

    for (const [subject, sentence] of [
      [named, 'too long; not a map'],
      [bare, 'the file was refused'],
    ] as const) {
      const view = await subject.service.stage({ kind: 'login.enable', id: 'work' });
      const error = (await subject.service.apply(view.id).catch(caught => caught)) as LoginChangeError;
      should(error.code).equal('login_change_failed');
      should(error.message).equal(sentence);
    }
  });

  it('should let an unexpected failure pass as itself rather than dress it as a hold refusal', async () => {
    const { service } = world({
      mintId: () => {
        throw new Error('the clock of ids broke');
      },
    });

    const error = (await service.stage({ kind: 'login.enable', id: 'work' }).catch(caught => caught)) as Error;

    should(error.message).equal('the clock of ids broke');
    should(error).not.have.property('code');
  });

  it('should give up minting a handle when every one it tries is already held', async () => {
    const { service } = world({ mintId: () => 'same' });
    await service.stage({ kind: 'login.enable', id: 'work' });

    const error = (await service
      .stage({ kind: 'login.enable', id: 'work' })
      .catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_refused');
    should(error.message).equal('could not mint an unused login change handle');
  });
});

describe('changeRoutes', () => {
  it('should stage and apply over the routes, a refusal as a 409 with its code and an unknown change as a 404', async () => {
    const { service } = world();
    const routes = changeRoutes(service);

    const staged = await call(routes, 'POST /v1/logins/changes', { body: { kind: 'login.enable', id: 'work' } });
    const id = (JSON.parse(String((staged as { body: unknown }).body)) as { id: string }).id;
    const applied = await call(routes, 'POST /v1/logins/changes/:changeId/apply', {
      path: `/v1/logins/changes/${id}/apply`,
    });
    const unknown = await call(routes, 'GET /v1/logins/changes/:changeId', { path: '/v1/logins/changes/nope' }).catch(
      caught => caught,
    );
    const invalid = await call(routes, 'POST /v1/logins/changes', { body: { kind: 'login.zap', id: 'work' } }).catch(
      caught => caught,
    );

    should(JSON.parse(String((applied as { body: unknown }).body))).deepEqual({ outcome: 'applied' });
    should(unknown).containDeep({ status: 404, code: 'login_change_unknown' });
    should(invalid).containDeep({ status: 400, code: 'invalid_request' });
  });
});

// ── Removing a login that runtimes use (C10) — Logins asks `logins.used-by` and fails closed ─────────────────────

const IN_USE = '1 runtime still uses this login (claude-default). Move it to another login first.';
const UNKNOWN = 'Ferretry cannot check what uses this login right now, so it was not removed.';

describe('LoginChangeService: removing a login', () => {
  it('should refuse a login runtimes use with the C10 sentence, hold nothing and write nothing', async () => {
    const { service, writes } = world({ usedBy: async () => ['claude-default'] });

    const error = (await service
      .stage({ kind: 'login.remove', id: 'work' })
      .catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_refused');
    should(error.message).equal(IN_USE);
    should(writes).deepEqual([]);
  });

  it('should remove a login nothing uses', async () => {
    const { service, writes, events } = world({ usedBy: async () => [] });

    const view = await service.stage({ kind: 'login.remove', id: 'work' });
    const outcome = await service.apply(view.id);

    should(outcome).deepEqual({ outcome: 'applied' });
    should(writes).deepEqual([{ id: 'work', removed: true }]);
    should(events).deepEqual([{ id: 'work', change: 'removed' }]);
  });

  it('should ask which runtimes use THAT login', async () => {
    const asked: string[] = [];
    const { service } = world({
      usedBy: async id => {
        asked.push(id);
        return [];
      },
    });

    await service.stage({ kind: 'login.remove', id: 'work' });

    should(asked).deepEqual(['work']);
  });

  it('should refuse a removal when nothing can say what uses the login (no provider), and write nothing', async () => {
    const { service, writes } = world({
      usedBy: async () => {
        throw new Error('nothing answers which runtimes use a login');
      },
    });

    const error = (await service
      .stage({ kind: 'login.remove', id: 'work' })
      .catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_refused');
    should(error.message).equal(UNKNOWN);
    should(writes).deepEqual([]);
  });

  it('should refuse a removal when the provider throws, without repeating what it threw', async () => {
    const { service } = world({
      usedBy: () => Promise.reject(new Error('503 runtimes is not running with secret sk-ant-api03-abcdefghijklmnopq')),
    });

    const error = (await service
      .stage({ kind: 'login.remove', id: 'work' })
      .catch(caught => caught)) as LoginChangeError;

    should(error.message).equal(UNKNOWN);
  });

  it('should ask again at apply: a runtime that moved onto the login after the review refuses the removal and keeps it reviewable', async () => {
    let users: readonly string[] = [];
    const { service, writes } = world({ usedBy: async () => users });
    const view = await service.stage({ kind: 'login.remove', id: 'work' });
    users = ['claude-default'];

    const error = (await service.apply(view.id).catch(caught => caught)) as LoginChangeError;
    users = [];
    const again = await service.apply(view.id);

    should(error.code).equal('login_change_refused');
    should(error.message).equal(IN_USE);
    should(again).deepEqual({ outcome: 'applied' });
    should(writes).deepEqual([{ id: 'work', removed: true }]);
  });

  it('should fail closed at apply too when the provider stops answering after the review', async () => {
    let answers = true;
    const { service, writes } = world({
      usedBy: async () => {
        if (!answers) throw new Error('gone');
        return [];
      },
    });
    const view = await service.stage({ kind: 'login.remove', id: 'work' });
    answers = false;

    const error = (await service.apply(view.id).catch(caught => caught)) as LoginChangeError;

    should(error.message).equal(UNKNOWN);
    should(writes).deepEqual([]);
  });

  it('should not count runtimes the caller moves first at staging, but ask plainly at apply, when the move has landed', async () => {
    let users: readonly string[] = ['claude-default'];
    const { service, writes } = world({ usedBy: async () => users });
    const port = loginChangesPort(service);

    const view = await port.stage({ kind: 'login.remove', id: 'work' }, { usersMovedFirst: ['claude-default'] });
    // The move did not take: the provider still says it uses the login. Nothing is excluded now.
    const error = (await port.apply(view.id).catch(caught => caught)) as LoginChangeError;
    users = [];
    const outcome = await port.apply(view.id);

    should(error.code).equal('login_change_refused');
    should(error.message).equal(IN_USE);
    should(outcome).deepEqual({ outcome: 'applied' });
    should(writes).deepEqual([{ id: 'work', removed: true }]);
  });

  it('should refuse to apply a change that waits on a move through the route, and keep it for the port', async () => {
    let users: readonly string[] = ['claude-default'];
    const { service, writes } = world({ usedBy: async () => users });
    const port = loginChangesPort(service);
    const routes = changeRoutes(service);
    const view = await port.stage({ kind: 'login.remove', id: 'work' }, { usersMovedFirst: ['claude-default'] });
    users = [];

    const viaRoute = await call(routes, 'POST /v1/logins/changes/:changeId/apply', {
      path: `/v1/logins/changes/${view.id}/apply`,
    }).catch(caught => caught);

    should(viaRoute).containDeep({ status: 409, code: 'login_change_refused' });
    should(writes).deepEqual([]);
    should(service.view(view.id).state).equal('pending');
    should(await port.apply(view.id)).deepEqual({ outcome: 'applied' });
    should(writes).deepEqual([{ id: 'work', removed: true }]);
  });

  it('should refuse a list naming something that is not a runtime when the provider still says what uses the login', async () => {
    // A caller names invented runtimes as "moved first": they are excluded at staging, but at apply the provider is
    // asked plainly and still names them, so the removal is refused through either door.
    const { service, writes } = world({ usedBy: async () => ['claude-default'] });
    const port = loginChangesPort(service);
    const view = await port.stage(
      { kind: 'login.remove', id: 'work' },
      { usersMovedFirst: ['claude-default', 'zzz-not-a-runtime'] },
    );

    const viaPort = (await port.apply(view.id).catch(caught => caught)) as LoginChangeError;
    const viaRoute = await call(changeRoutes(service), 'POST /v1/logins/changes/:changeId/apply', {
      path: `/v1/logins/changes/${view.id}/apply`,
    }).catch(caught => caught);

    should(viaPort.message).equal(IN_USE);
    should(viaRoute).containDeep({ status: 409, code: 'login_change_refused' });
    should(writes).deepEqual([]);
  });

  it('should forget a held change that is discarded, and say it is unknown afterwards', async () => {
    const { service, writes } = world();
    const port = loginChangesPort(service);
    const view = await port.stage({ kind: 'login.remove', id: 'work' }, { usersMovedFirst: [] });

    await port.discard(view.id);
    const error = (await port.apply(view.id).catch(caught => caught)) as LoginChangeError;

    should(error.code).equal('login_change_unknown');
    should(writes).deepEqual([]);
  });

  for (const [what, answer] of [
    ['undefined', undefined],
    ['a string', 'claude-default'],
    ['a Set', new Set(['claude-default'])],
    ['an object with a length', { length: 1 }],
    ['names that are not strings', [1]],
  ] as const) {
    it(`should refuse in the fixed sentence, at staging and at apply, when the provider answers ${what}`, async () => {
      // Staging.
      const staging = world({ usedBy: async () => answer as never });
      const refused = (await staging.service
        .stage({ kind: 'login.remove', id: 'work' })
        .catch(caught => caught)) as LoginChangeError;

      // Apply: the provider answered properly at the review, then garbage.
      let garbage = false;
      const applying = world({ usedBy: async () => (garbage ? (answer as never) : []) });
      const view = await applying.service.stage({ kind: 'login.remove', id: 'work' });
      garbage = true;
      const later = (await applying.service.apply(view.id).catch(caught => caught)) as LoginChangeError;

      should(refused.code).equal('login_change_refused');
      should(refused.message).equal(UNKNOWN);
      should(later.code).equal('login_change_refused');
      should(later.message).equal(UNKNOWN);
      should(staging.writes).deepEqual([]);
      should(applying.writes).deepEqual([]);
    });
  }

  const BUDGETED = new Map<string, LoginFile>([
    ['work', { harness: 'claude-code', store: 'ferretry', budget: { daily: { hard: 5 } } } as LoginFile],
  ]);
  const WOULD_HOLD: ConfigWriteOutcome = {
    kind: 'refused',
    reason: 'would_hold',
    issues: [],
    sentences: ['login "work"\'s daily hard limit in dollars is removed (was 5)'],
  };
  const BUDGET_FIRST =
    'This login has a budget, so it was not removed: first drop its budget (you confirm that), then remove the login.';

  it('should remove a budgeted login in ONE step when the kernel lets the removal in (the owner)', async () => {
    const { service, writes, events } = world({ files: () => BUDGETED });

    const view = await service.stage({ kind: 'login.remove', id: 'work' });
    const outcome = await service.apply(view.id);

    should(outcome).deepEqual({ outcome: 'applied' });
    should(writes).deepEqual([{ id: 'work', removed: true }]);
    should(events).deepEqual([{ id: 'work', change: 'removed' }]);
  });

  it('should refuse a budgeted removal the kernel would hold, naming both steps, with nothing removed or held (the port and the route)', async () => {
    const held = world({ files: () => BUDGETED, remove: async () => WOULD_HOLD });
    const port = loginChangesPort(held.service);

    const staged = await port.stage({ kind: 'login.remove', id: 'work' });
    const viaPort = (await port.apply(staged.id).catch(caught => caught)) as LoginChangeError;
    const again = await port.stage({ kind: 'login.remove', id: 'work' });
    const viaRoute = await call(changeRoutes(held.service), 'POST /v1/logins/changes/:changeId/apply', {
      path: `/v1/logins/changes/${again.id}/apply`,
    }).catch(caught => caught);

    should(viaPort.code).equal('login_change_refused');
    should(viaPort.message).equal(BUDGET_FIRST);
    should(viaRoute).containDeep({ status: 409, code: 'login_change_refused', message: BUDGET_FIRST });
    should(held.events).deepEqual([]);
    should(held.writes).deepEqual([]);
  });

  it('should still ask what uses the login at apply, before the removal, when it has a budget', async () => {
    let users: readonly string[] = [];
    const asked: string[] = [];
    const { service, writes } = world({
      files: () => BUDGETED,
      usedBy: async id => {
        asked.push(id);
        return users;
      },
    });
    const view = await service.stage({ kind: 'login.remove', id: 'work' });
    // A runtime moved onto the login after the review.
    users = ['claude-default'];

    const again = (await service.apply(view.id).catch(caught => caught)) as LoginChangeError;

    should(asked).deepEqual(['work', 'work']);
    should(again.code).equal('login_change_refused');
    should(again.message).equal(IN_USE);
    should(writes).deepEqual([]);
  });

  it('should still refuse when the runtimes named as moved first are not all of them', async () => {
    const { service } = world({ usedBy: async () => ['a', 'b'] });

    const error = (await service
      .stage({ kind: 'login.remove', id: 'work' }, { usersMovedFirst: ['a'] })
      .catch(caught => caught)) as LoginChangeError;

    should(error.message).equal('1 runtime still uses this login (b). Move it to another login first.');
  });

  it('should refuse over the route too, in the same sentence (the route has no way to say a runtime moved)', async () => {
    const { service } = world({ usedBy: async () => ['claude-default'] });
    const routes = changeRoutes(service);

    const refused = await call(routes, 'POST /v1/logins/changes', { body: { kind: 'login.remove', id: 'work' } }).catch(
      caught => caught,
    );
    const smuggled = await call(routes, 'POST /v1/logins/changes', {
      body: { kind: 'login.remove', id: 'work', usersMovedFirst: ['claude-default'] },
    }).catch(caught => caught);

    should(refused).containDeep({ status: 409, code: 'login_change_refused', message: IN_USE });
    should(smuggled).containDeep({ status: 400, code: 'invalid_request' });
  });
});

describe('LoginChangeService: what a variables change tells the person', () => {
  const gate = () =>
    new Map<string, LoginFile>([
      ['gate', { harness: 'claude-code', store: 'environment', env: { ANTHROPIC_BASE_URL: 'http://localhost:4000' } }],
    ]);

  it('should name the runtimes that start with the new variables, as today does', async () => {
    const { service, setFiles } = world({ usedBy: async () => ['alpha'] });
    setFiles(gate());

    const view = await service.stage({ kind: 'login.env', id: 'gate', env: { TZ: 'UTC' } });

    should(view.consequences).deepEqual([
      'alpha starts with the new variables next launch. Running sessions keep the old ones until restarted.',
    ]);
  });

  it('should name several runtimes in the plural', async () => {
    const { service, setFiles } = world({ usedBy: async () => ['alpha', 'beta'] });
    setFiles(gate());

    const view = await service.stage({ kind: 'login.env', id: 'gate', env: { TZ: 'UTC' } });

    should(view.consequences[0]).startWith('alpha, beta start with the new variables next launch.');
  });

  it('should fall back to the general sentence when no runtime uses it, or when nothing can say', async () => {
    const none = world({ usedBy: async () => [] });
    none.setFiles(gate());
    const unknown = world({
      usedBy: async () => {
        throw new Error('gone');
      },
    });
    unknown.setFiles(gate());

    const general = (await none.service.stage({ kind: 'login.env', id: 'gate', env: { TZ: 'UTC' } })).consequences;
    const fallback = (await unknown.service.stage({ kind: 'login.env', id: 'gate', env: { TZ: 'UTC' } })).consequences;

    should(general[0]).startWith('Runtimes on it launch with these variables.');
    should(fallback).deepEqual(general);
  });
});

describe('the Logins port parses what the route parses', () => {
  const long = (count: number) => 'x'.repeat(count);

  const CASES = [
    ['a label over 200 characters', { kind: 'login.label', id: 'work', label: long(201) }],
    ['an environment variable name over 128 characters', { kind: 'login.env', id: 'work', env: { [long(129)]: 'v' } }],
    ['an environment variable value over 4096 characters', { kind: 'login.env', id: 'work', env: { A: long(4097) } }],
    ['a login added with an over-long label', { kind: 'login.add', id: 'new', harness: 'codex', label: long(201) }],
  ] as const;

  for (const [what, change] of CASES) {
    it(`should refuse ${what} through the port exactly as through the route`, async () => {
      const { service, writes } = world();
      const port = loginChangesPort(service);

      const viaPort = (await port.stage(change as never).catch(caught => caught)) as LoginChangeError;
      const viaRoute = await call(changeRoutes(service), 'POST /v1/logins/changes', { body: change }).catch(
        caught => caught,
      );

      should(viaPort.code).equal('login_change_refused');
      should(viaRoute).containDeep({ status: 400, code: 'invalid_request' });
      // One refusal, in two transports: the issue the route names is the issue the port names.
      const routeMessage = String((viaRoute as { message: string }).message);
      should(routeMessage).containEql(viaPort.message.replace('the change is invalid — ', ''));
      should(writes).deepEqual([]);
    });
  }

  it('should stage and apply a valid change through the port, passing the moved-first runtimes on', async () => {
    let users: readonly string[] = ['claude-default'];
    const { service, writes } = world({ usedBy: async () => users });
    const port = loginChangesPort(service);

    const view = await port.stage({ kind: 'login.remove', id: 'work' }, { usersMovedFirst: ['claude-default'] });
    users = [];
    const outcome = await port.apply(view.id);

    should(outcome).deepEqual({ outcome: 'applied' });
    should(writes).deepEqual([{ id: 'work', removed: true }]);
  });
});
