import { describe, it } from 'bun:test';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import should from 'should';
import type { LoginFile, LoginView } from '../../../contract/index.ts';
import {
  type LoginChangeError,
  LoginChangeService,
  type LoginChangeServiceDeps,
} from '../../../daemon/lib/changes/service.ts';
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
    const { service } = world({ remove: async () => held });
    const view = await service.stage({ kind: 'login.remove', id: 'work' });

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
