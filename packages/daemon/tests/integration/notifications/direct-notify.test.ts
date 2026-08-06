import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { FileNotificationDeliveryLedger } from '../../../src/adapters/notifications/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { StatePushRepository } from '../../../src/adapters/push/state-push-repository.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import {
  ApiDispatcher,
  ApiRouter,
  NO_GOVERNED_ROUTES_GUARD,
  createFoundationPaths,
  NotificationService,
  PushService,
  attentionRoutes,
  resolveStateHome,
  type PushDelivery,
  type PushDeliveryOutcome,
  type PushSubscriptionRecord,
  type WebPushTransport,
} from '../../../src/lib/index.ts';
import { jsonBody, request } from '../../unit/api/support.ts';
import { allEvents, deviceId, pushId, record } from '../../unit/push/support.ts';
import { CREDENTIALS, attentionService, human, sessionView } from '../../unit/runtime/mounts/support.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const SESSION = 's1';
const AT = '2026-08-06T12:00:00.000Z';
const REQUEST_ID = 'notification-request-1';

class RecordingTransport implements WebPushTransport {
  readonly deliveries: PushDelivery[] = [];

  async deliver(delivery: PushDelivery): Promise<PushDeliveryOutcome> {
    this.deliveries.push(delivery);
    return 'delivered';
  }
}

async function daemon(
  options: {
    readonly mode?: 'auto' | 'interactive';
    readonly records?: readonly PushSubscriptionRecord[];
  } = {},
) {
  const home = await tempDirectory('direct-notify');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  const store = new StatePushRepository(paths, files);
  for (const enrolment of options.records ?? []) await store.save(enrolment);
  const transport = new RecordingTransport();
  const granted = new Set((options.records ?? []).map(enrolment => enrolment.deviceId));
  const push = new PushService({
    store,
    keys: { publicKey: async () => 'not-used-for-delivery' },
    transport,
    devices: { granted: async () => granted },
    clock: { now: () => AT },
    ids: { next: () => '11111111-1111-4111-8111-111111111111' },
  });
  const ledger = new FileNotificationDeliveryLedger(paths, files);
  const sessions = new Map([
    [SESSION, sessionView(SESSION, { name: 'Notification Fixture', mode: options.mode ?? 'interactive' })],
  ]);
  const notifications = new NotificationService({
    ledger,
    sessions: {
      describe: async sessionId => {
        const view = sessions.get(sessionId);
        return view === undefined
          ? undefined
          : { name: view.config.name, interactive: view.config.mode === 'interactive' };
      },
    },
    push,
    serial: new KeyedSerialExecutor(),
    clock: { now: () => AT },
  });
  const routes = attentionRoutes(attentionService(), notifications);
  const surface = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
  return { paths, files, ledger, sessions, transport, routes, surface };
}

function post(body: string, requestId: string | null = REQUEST_ID) {
  return request({
    method: 'POST',
    path: `/v1/sessions/${SESSION}/notify`,
    headers: { ...human, ...(requestId === null ? {} : { 'x-fy-request-id': requestId }) },
    body: JSON.stringify({ body }),
  });
}

async function ledgerLines(world: Awaited<ReturnType<typeof daemon>>): Promise<readonly Record<string, unknown>[]> {
  const text = await world.files.readText(world.ledger.path);
  return (text ?? '')
    .trim()
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('direct notification over the composed daemon surface', () => {
  it('should deliver through real PushService and record requested before outcome', async () => {
    // Arrange
    const enrolment = record();
    const world = await daemon({ records: [enrolment] });

    // Act
    const response = await world.surface.dispatch(post('Release ready.'));
    const lines = await ledgerLines(world);

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ sessionId: SESSION, delivered: 1 });
    should(world.transport.deliveries).have.length(1);
    should(lines.map(line => line.phase)).deepEqual(['requested', 'outcome']);
    should(lines[0]).containDeep({
      origin: 'direct',
      attribution: 'admin-cli',
      sessionId: SESSION,
      request: { body: 'Release ready.', title: null, kind: null },
      sent: { kind: 'question', interactive: true, body: 'Release ready.' },
      enrolled: 1,
    });
    should(lines[1]).containDeep({ delivered: 1, failed: 0 });
  });

  it('should replay the same request id with a byte-identical body and exactly one delivery', async () => {
    // Arrange
    const world = await daemon({ records: [record()] });

    // Act
    const first = await world.surface.dispatch(post('Release ready.'));
    const second = await world.surface.dispatch(post('Release ready.'));

    // Assert
    should(first.status).equal(200);
    should(second.status).equal(200);
    should(second.body).equal(first.body);
    should(world.transport.deliveries).have.length(1);
    should(await ledgerLines(world)).have.length(2);
  });

  it('should reject a missing request id without evidence or delivery', async () => {
    // Arrange
    const world = await daemon({ records: [record()] });

    // Act
    const response = await world.surface.dispatch(post('Release ready.', null));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'missing_request_id');
    should(await world.files.readText(world.ledger.path)).be.undefined();
    should(world.transport.deliveries).be.empty();
  });

  it('should refuse one request id reused with a different body', async () => {
    // Arrange
    const world = await daemon({ records: [record()] });

    // Act
    const first = await world.surface.dispatch(post('Release ready.'));
    const changed = await world.surface.dispatch(post('Different notification.'));

    // Assert
    should(first.status).equal(200);
    should(changed.status).equal(400);
    should(jsonBody(changed)).have.property('code', 'invalid');
    should(world.transport.deliveries).have.length(1);
  });

  it('should count neither a device that declined questions nor its non-delivery as failed', async () => {
    // Arrange
    const declined = record({
      prefs: { ...allEvents, events: { ...allEvents.events, question: false } },
    });
    const world = await daemon({ records: [declined] });

    // Act
    const response = await world.surface.dispatch(post('Release ready.'));
    const lines = await ledgerLines(world);

    // Assert
    should(jsonBody(response)).deepEqual({ sessionId: SESSION, delivered: 0 });
    should(world.transport.deliveries).be.empty();
    should(lines[0]).containDeep({ enrolled: 1 });
    should(lines[1]).containDeep({ delivered: 0, failed: 0 });
  });

  it('should suppress interactive-only enrolments for an automatic session', async () => {
    // Arrange
    const interactiveOnly = record({ prefs: { ...allEvents, interactiveOnly: true } });
    const world = await daemon({ mode: 'auto', records: [interactiveOnly] });

    // Act
    const response = await world.surface.dispatch(post('Background agent update.'));
    const lines = await ledgerLines(world);

    // Assert
    should(jsonBody(response)).deepEqual({ sessionId: SESSION, delivered: 0 });
    should(world.transport.deliveries).be.empty();
    should(lines[0]).containDeep({ sent: { interactive: false } });
  });

  it('should replay a settled delivery after the session is deleted', async () => {
    // Arrange
    const world = await daemon({ records: [record()] });
    const first = await world.surface.dispatch(post('Release ready.'));
    world.sessions.delete(SESSION);

    // Act
    const replay = await world.surface.dispatch(post('Release ready.'));

    // Assert
    should(replay.status).equal(200);
    should(replay.body).equal(first.body);
    should(world.transport.deliveries).have.length(1);
  });

  it('should fail closed on a hand-planted complete malformed ledger line', async () => {
    // Arrange
    const world = await daemon({ records: [record()] });
    await world.files.appendLineDurable(world.ledger.path, 'not json');

    // Act
    const response = await world.surface.dispatch(post('Release ready.'));

    // Assert
    should(response.status).equal(500);
    should(jsonBody(response)).have.property('code', 'corrupt');
    should(world.transport.deliveries).be.empty();
  });

  it('should mount exactly the path literal the compiled CLI gateway calls', async () => {
    // Arrange
    const world = await daemon();

    // Act
    const literals = world.routes.map(route => `${route.method} ${route.path}`);

    // Assert
    should(literals).containEql('POST /v1/sessions/:sessionId/notify');
  });

  it('should keep direct request identities daemon-wide across different sessions', async () => {
    // Arrange
    const secondId = 's2';
    const firstDevice = record();
    const secondDevice = record({
      id: pushId('b'),
      deviceId: deviceId('b'),
      subscription: { ...firstDevice.subscription, endpoint: 'https://push.example.test/send/two' },
    });
    const world = await daemon({ records: [firstDevice, secondDevice] });
    world.sessions.set(secondId, sessionView(secondId, { mode: 'interactive' }));
    await world.surface.dispatch(post('Release ready.'));

    // Act
    const response = await world.surface.dispatch(
      request({
        method: 'POST',
        path: `/v1/sessions/${secondId}/notify`,
        headers: { ...human, 'x-fy-request-id': REQUEST_ID },
        body: JSON.stringify({ body: 'Release ready.' }),
      }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid');
    should(world.transport.deliveries).have.length(2);
  });
});
