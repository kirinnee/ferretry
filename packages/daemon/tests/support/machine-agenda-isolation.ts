import { AgendaActionRequestSchema, MACHINE_AGENDA_ID } from '@ferretry/protocol';
import should from 'should';
import { AgendaService, MachineAgenda, type AgendaLedgerRepository } from '../../src/lib/agenda/index.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../src/lib/api/capability.ts';
import { ApiDispatcher, ApiRouter } from '../../src/lib/api/index.ts';
import { agendaMachineRoutes } from '../../src/lib/runtime/mounts/agenda-machine.ts';
import { agendaRoutes } from '../../src/lib/runtime/mounts/agenda.ts';
import { bodyReads, jsonBody, request } from '../unit/api/support.ts';

const NOW = '2026-11-06T10:00:00.000Z';
const HUMAN = { authorization: 'Bearer test-admin', 'x-ferretry-client': 'cli' };
const AGENT = { ...HUMAN, 'x-ferretry-session-id': 's1' };
const FERRET_TOKEN = `fys_${'f'.repeat(43)}`;
const SESSION_CREDENTIAL = { authorization: `Bearer ${FERRET_TOKEN}` };
export const ASK = {
  title: 'Choose a region',
  subject: 'Which region?',
  why: 'The rollout waits.',
  premise: 'A release is ready.',
  context: 'Two regions are available.',
  howToResolve: 'Name the region.',
  ask: { kind: 'open-question' as const },
};

// Every POST verb, with valid bodies: refusals must precede both parsing and mutation side effects.
const ACTIONS = [
  { action: 'add', ...ASK },
  { action: 'edit', id: 'A1', subject: 'Updated' },
  { action: 'resolve', id: 'A1' },
  { action: 'resolve', id: 'A1', response: { kind: 'open-question', answer: 'eu' } },
  { action: 'dismiss', id: 'A1' },
  { action: 'progress', id: 'A1', step: 0, done: true },
  { action: 'needs-info', id: 'A1', note: 'Which one?' },
  { action: 'discuss', id: 'A1', note: 'Let us discuss.' },
  { action: 'surface', id: 'A1' },
  { action: 'rest', id: 'A1', why: 'Checking regions.' },
  { action: 'log', id: 'A1', mode: 'reply', text: 'Understood.' },
  { action: 'merge', id: 'A1', from: 'A2' },
  { action: 'split', id: 'A1', item: ASK },
  { action: 'snooze', id: 'A1', until: '2026-11-07T10:00:00.000Z' },
  { action: 'unsnooze', id: 'A1' },
].map(action => AgendaActionRequestSchema.parse(action));

/** Production's topology: the session service redirects daemon notices to a SEPARATE machine service/repository. */
export async function machineAgendaWorld(
  sessionRepository: AgendaLedgerRepository,
  machineRepository: AgendaLedgerRepository,
) {
  const clock = { now: () => NOW };
  const observer = { raised: async () => undefined };
  const machineService = new AgendaService(
    machineRepository,
    clock,
    { has: async id => id === MACHINE_AGENDA_ID },
    observer,
  );
  let members: Readonly<Record<string, readonly string[]>> = {};
  const machine = new MachineAgenda(
    machineService,
    {
      read: async () => members,
      write: async next => {
        members = next;
      },
    },
    clock,
  );
  await machine.raiseOrUpdate('warden:orphans', {
    kind: 'info',
    notice: true,
    subject: 'A card needs a ferret',
    why: 'Nobody holds it.',
    howToResolve: 'Assign a ferret.',
  });
  const effects: string[] = [];
  const service = new AgendaService(
    sessionRepository,
    clock,
    {
      has: async id => {
        effects.push('session-directory');
        return id === 's1';
      },
    },
    observer,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      list: async () => {
        effects.push('machine-list');
        return await machine.list();
      },
      raiseOrUpdate: async (...args) => {
        effects.push('machine-raise');
        return await machine.raiseOrUpdate(...args);
      },
      resolve: async (...args) => {
        effects.push('machine-resolve');
        return await machine.resolve(...args);
      },
    },
  );
  const routes = agendaRoutes(
    service,
    {
      enrolledDevices: async () => {
        effects.push('enrolled');
        return 0;
      },
    },
    {
      pending: async () => {
        effects.push('pending');
        return undefined;
      },
      delivery: async () => {
        effects.push('delivery');
        return undefined;
      },
      sendNow: async id => {
        effects.push(`sendNow:${id}`);
      },
    },
  );
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...routes, ...agendaMachineRoutes(machineService)]),
    {
      admin: 'test-admin',
      sessions: { resolve: async token => (token === FERRET_TOKEN ? { sessionId: 's1' } : undefined) },
    },
    NO_GOVERNED_ROUTES_GUARD,
  );
  return { dispatcher, routes, service, machineService, machine, effects, sessionRepository, machineRepository };
}

type MachineAgendaWorld = Awaited<ReturnType<typeof machineAgendaWorld>>;

/** The same route matrix runs over memory in unit and independent on-disk ledgers in integration. */
export async function assertMachineAgendaIsolation(world: MachineAgendaWorld): Promise<void> {
  const before = await world.machineRepository.read(MACHINE_AGENDA_ID);
  for (const headers of [HUMAN, AGENT, SESSION_CREDENTIAL]) {
    for (const route of world.routes) {
      const path = route.path.replace(':sessionId', MACHINE_AGENDA_ID).replace(':id', 'A1').replace(':version', '1');
      const bodies =
        route.method === 'POST' && /\/agenda$/u.test(path) ? ACTIONS : [path.endsWith('/seen') ? { version: 1 } : {}];
      for (const body of [...bodies, '{malformed']) {
        const reads = bodyReads();
        const response = await world.dispatcher.dispatch(
          request({
            method: route.method,
            path,
            headers,
            loopback: true,
            privilegedLoopback: true,
            body: typeof body === 'string' ? body : JSON.stringify(body),
            query: [['index', 'bad']],
            reads,
          }),
        );
        const personOnlyAgent = route.caller === 'person' && headers !== HUMAN;
        should(response.status).equal(personOnlyAgent ? 403 : 404, `${route.method} ${path} ${JSON.stringify(body)}`);
        if (!personOnlyAgent) {
          should(jsonBody(response)).containDeep({ code: 'not-found' });
          should(String(jsonBody(response).error)).containEql('/v1/machine/agenda');
        }
        should(reads.consumed).be.false();
      }
    }
  }
  // Percent-encoded spellings have the same refusal after path decoding.
  should(
    (await world.dispatcher.dispatch(request({ path: '/v1/sessions/%6dachine-agenda/agenda', headers: AGENT }))).status,
  ).equal(404);
  should(world.effects).be.empty();
  should(await world.machineRepository.read(MACHINE_AGENDA_ID)).deepEqual(before);
  should(await world.sessionRepository.read(MACHINE_AGENDA_ID)).be.null();
}

export async function assertOwnerAndSessionRoutes(world: MachineAgendaWorld): Promise<void> {
  for (const headers of [AGENT, SESSION_CREDENTIAL]) {
    for (const method of ['GET', 'POST']) {
      should(
        (
          await world.dispatcher.dispatch(
            request({
              method,
              path: '/v1/machine/agenda',
              headers,
              loopback: true,
              privilegedLoopback: true,
              body: JSON.stringify({ action: 'dismiss', id: 'A1' }),
            }),
          )
        ).status,
      ).equal(403);
    }
  }
  const listed = await world.dispatcher.dispatch(request({ path: '/v1/machine/agenda', headers: HUMAN }));
  should(listed.status).equal(200);
  should(jsonBody(listed).items).have.length(1);
  should(
    (
      await world.dispatcher.dispatch(
        request({
          method: 'POST',
          path: '/v1/machine/agenda',
          headers: HUMAN,
          body: JSON.stringify({ action: 'dismiss', id: 'A1' }),
        }),
      )
    ).status,
  ).equal(200);
  should((await world.machine.list()).items).be.empty();
  const path = '/v1/sessions/s1/agenda';
  should(
    (
      await world.dispatcher.dispatch(
        request({ method: 'POST', path, headers: AGENT, body: JSON.stringify({ action: 'add', ...ASK }) }),
      )
    ).status,
  ).equal(200);
  should((await world.dispatcher.dispatch(request({ path, headers: HUMAN }))).status).equal(200);
  should(
    (await world.dispatcher.dispatch(request({ method: 'POST', path: `${path}/replies`, headers: HUMAN, body: '{}' })))
      .status,
  ).equal(200);
  should(world.effects).containEql('sendNow:s1');
}
