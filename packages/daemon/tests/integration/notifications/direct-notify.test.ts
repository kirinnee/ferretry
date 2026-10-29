import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileNotificationDeliveryLedger } from '../../../src/adapters/notifications/index.ts';
import { StatePushRepository } from '../../../src/adapters/push/state-push-repository.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import {
  ApiDispatcher,
  ApiRouter,
  AttentionService,
  attentionRoutes,
  createFoundationPaths,
  NO_GOVERNED_ROUTES_GUARD,
  NotificationService,
  type PushDelivery,
  type PushDeliveryOutcome,
  PushService,
  type PushSubscriptionRecord,
  resolveStateHome,
  type WebPushTransport,
} from '../../../src/lib/index.ts';
import { jsonBody, request } from '../../unit/api/support.ts';
import { record } from '../../unit/push/support.ts';
import {
  CREDENTIALS,
  FakeLedgerRepository,
  human,
  NO_HELD_REPLIES,
  sessionView,
} from '../../unit/runtime/mounts/support.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const SESSION = 's1';
const AT = '2026-08-06T12:00:00.000Z';

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
  const attention = new AttentionService(
    new FakeLedgerRepository(),
    { now: () => AT },
    { has: async sessionId => sessionId === SESSION },
    notifications,
  );
  const routes = attentionRoutes(attention, notifications, NO_HELD_REPLIES);
  const surface = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
  return { files, ledger, transport, routes, surface };
}

function post(body: Record<string, unknown>) {
  return request({
    method: 'POST',
    path: `/v1/sessions/${SESSION}/notify`,
    headers: { ...human },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('notify over the composed daemon surface', () => {
  it('should raise the card and buzz nothing: a plain notify only moves the Inbox, however many devices are enrolled', async () => {
    // Arrange
    const world = await daemon({ records: [record()] });

    // Act
    const response = await world.surface.dispatch(post({ title: 'Release ready', body: 'The release is cut.' }));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ sessionId: SESSION, delivered: 0 });
    should(world.transport.deliveries).be.empty();
    should(await world.files.readText(world.ledger.path)).be.undefined();
  });

  it('should buzz nothing for an automatic session either, nor for the same notify sent twice', async () => {
    // Arrange
    const world = await daemon({ mode: 'auto', records: [record()] });

    // Act
    const first = await world.surface.dispatch(post({ body: 'Background agent update.' }));
    const second = await world.surface.dispatch(post({ body: 'Background agent update.' }));

    // Assert
    should(jsonBody(first)).have.property('delivered', 0);
    should(jsonBody(second)).have.property('delivered', 0);
    should(world.transport.deliveries).be.empty();
  });

  it('should refuse a notify that says it is progress or finishing, raising and pushing nothing', async () => {
    // Arrange
    const world = await daemon({ records: [record()] });

    // Act
    const response = await world.surface.dispatch(post({ body: 'All done.', kind: 'completed' }));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid');
    should(world.transport.deliveries).be.empty();
    should(await world.files.readText(world.ledger.path)).be.undefined();
  });

  it('should answer delivered 0 and still raise the card when no device is enrolled', async () => {
    // Arrange
    const world = await daemon();

    // Act
    const response = await world.surface.dispatch(post({ body: 'Release ready.' }));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ sessionId: SESSION, delivered: 0 });
    should(world.transport.deliveries).be.empty();
  });

  it('should answer delivered 0, not an error, when the notification ledger is damaged', async () => {
    // Arrange
    const world = await daemon({ records: [record()] });
    await world.files.appendLineDurable(world.ledger.path, 'not json');

    // Act
    const response = await world.surface.dispatch(post({ body: 'Release ready.' }));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).have.property('delivered', 0);
    should(world.transport.deliveries).be.empty();
  });

  it('should mount exactly the path literal older CLIs call', async () => {
    // Arrange
    const world = await daemon();

    // Act
    const literals = world.routes.map(route => `${route.method} ${route.path}`);

    // Assert
    should(literals).containEql('POST /v1/sessions/:sessionId/notify');
  });
});
