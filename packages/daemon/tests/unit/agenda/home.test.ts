import { describe, it } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import should from 'should';
import {
  AgendaHomes,
  handsOnItem,
  handsOnRaise,
  handsOnSource,
  type HomeSession,
  NO_MACHINE_AGENDA,
  SELF_AGENDA_HOME,
} from '../../../src/lib/agenda/home.ts';
import type { AgendaActor, RaiseAgendaRequest } from '../../../src/lib/agenda/state-machine.ts';

const session = (id: string, overrides: Partial<HomeSession> = {}): HomeSession => ({
  id,
  mode: 'auto',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

const homes = (sessions: readonly HomeSession[], machine?: string, unreadable: readonly string[] = []) =>
  new AgendaHomes(
    {
      get: async id => {
        if (unreadable.includes(id)) throw new Error('unreadable');
        return sessions.find(each => each.id === id);
      },
      all: async () => sessions.map(each => each.id),
    },
    machine === undefined ? undefined : { home: async () => machine },
  );

describe('AgendaHomes', () => {
  it('is the owner-started root of the lineage, never a sub-ferret', async () => {
    const world = homes([
      session('lead', { mode: 'interactive' }),
      session('child', { parent: 'lead', origin: 'session' }),
      session('grandchild', { parent: 'child', origin: 'session' }),
    ]);
    should(await world.of('grandchild')).equal('lead');
    should(await world.of('child')).equal('lead');
    should(await world.of('lead')).equal('lead');
  });

  it('reads a root with no stamp, or a human stamp, as the owner’s', async () => {
    const world = homes([session('a', { origin: 'human' }), session('b', { parent: 'a' })]);
    should(await world.of('b')).equal('a');
  });

  it('puts a warden-rooted lineage on the latest interactive session of the same project', async () => {
    const world = homes([
      session('warden', { origin: 'warden', projectId: 'P1' }),
      session('kid', { parent: 'warden', origin: 'warden', projectId: 'P1' }),
      session('old', { mode: 'interactive', projectId: 'P1' }),
      session('new', { mode: 'interactive', projectId: 'P1', updatedAt: '2026-10-02T10:00:00.000Z' }),
      session('other-project', { mode: 'interactive', projectId: 'P2', updatedAt: '2026-10-03T10:00:00.000Z' }),
      session('auto', { mode: 'auto', projectId: 'P1', updatedAt: '2026-10-04T10:00:00.000Z' }),
      session('sub', { mode: 'interactive', projectId: 'P1', parent: 'old', updatedAt: '2026-10-05T10:00:00.000Z' }),
      session('spawned', {
        mode: 'interactive',
        projectId: 'P1',
        origin: 'session',
        updatedAt: '2026-10-06T10:00:00.000Z',
      }),
    ]);
    should(await world.of('kid')).equal('new');
  });

  it('falls to the machine-wide agenda, and to the root while there is none', async () => {
    const sessions = [session('spawned', { origin: 'session' }), session('kid', { parent: 'spawned' })];
    should(await homes(sessions, 'machine').of('kid')).equal('machine');
    should(await homes(sessions).of('kid')).equal('spawned');
    should(await NO_MACHINE_AGENDA.home()).equal(undefined);
    const failing = new AgendaHomes(
      {
        get: async id => sessions.find(each => each.id === id),
        all: async () => {
          throw new Error('x');
        },
      },
      {
        home: async () => {
          throw new Error('x');
        },
      },
    );
    should(await failing.of('kid')).equal('spawned');
  });

  it('stops at the last known session when a parent cannot be read', async () => {
    should(await homes([session('kid', { parent: 'gone' })]).of('kid')).equal('kid');
    should(
      await homes([session('kid', { parent: 'broken' }), session('broken')], undefined, ['broken']).of('kid'),
    ).equal('kid');
    should(await homes([]).of('nobody')).equal('nobody');
  });

  it('walks a loop once', async () => {
    const world = homes([session('a', { parent: 'b' }), session('b', { parent: 'a' })]);
    should(['a', 'b']).containEql(await world.of('a'));
  });

  it('stops a chain longer than the bound', async () => {
    const chain = Array.from({ length: 30 }, (_, index) =>
      session(`s${String(index)}`, { parent: `s${String(index + 1)}` }),
    );
    const found = await homes(chain).of('s0');
    should(found).equal('s15');
  });

  it('treats an empty parent as none', async () => {
    should(await homes([session('a', { parent: '' })]).of('a')).equal('a');
    should(await SELF_AGENDA_HOME.of('x')).equal('x');
  });
});

const REQUEST: RaiseAgendaRequest = {
  source: 'task',
  sourceRef: 'r',
  subject: 's',
  why: 'w',
  howToResolve: 'h',
  kind: 'info',
};
const daemon = (cause: Extract<AgendaActor, { kind: 'daemon' }>['cause']): AgendaActor => ({ kind: 'daemon', cause });

describe('handsOnRaise', () => {
  const dummy = {} as never;
  it('keeps every hands-on card where it is', () => {
    for (const cause of ['harness-prompt', 'input-request', 'phone-approval', 'secure-copy', 'login-recipe'] as const) {
      should(handsOnRaise(REQUEST, daemon(cause))).be.true();
      should(handsOnSource(daemon(cause))).be.true();
    }
    for (const field of [
      'input',
      'phoneApproval',
      'copyPlan',
      'taskPlan',
      'signInRuleSuggestion',
      'twoFactorSeed',
      'confirms',
    ] as const) {
      should(handsOnRaise({ ...REQUEST, [field]: dummy }, daemon('system'))).be.true();
    }
  });

  it('sends everything else to the home', () => {
    for (const cause of ['source-reconciliation', 'warden-escalation', 'system'] as const) {
      should(handsOnRaise(REQUEST, daemon(cause))).be.false();
      should(handsOnSource(daemon(cause))).be.false();
    }
    should(handsOnRaise({ ...REQUEST, gate: dummy }, daemon('system'))).be.false();
    should(handsOnRaise({ ...REQUEST, input: dummy }, { kind: 'agent', sessionId: 's', name: null })).be.false();
    should(handsOnSource({ kind: 'human' })).be.false();
  });
});

describe('handsOnItem', () => {
  const item = (extra: Record<string, unknown>) => ({ source: 'task', ...extra }) as unknown as AgendaItem;
  it('reads a hands-on card from the item', () => {
    should(handsOnItem(item({ source: 'question' }))).be.true();
    for (const field of [
      'input',
      'phoneApproval',
      'copyPlan',
      'taskPlan',
      'signInRuleSuggestion',
      'twoFactorSeed',
      'confirms',
    ]) {
      should(handsOnItem(item({ [field]: {} }))).be.true();
    }
    should(handsOnItem(item({}))).be.false();
  });
});
