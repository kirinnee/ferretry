import { describe, it } from 'bun:test';
import type { AuditRecord, DaemonId, PairingCode, PushDeliveryResult, PushDeviceView } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiError, type ApiRoute, ApiRouter, jsonResponse } from '../../../src/lib/api/index.ts';
import {
  AUDITED_ROUTES,
  type AuditEntry,
  AuditedPairingService,
  type AuditJournalPort,
  AuditLog,
  type AuditReading,
  auditActorOf,
  auditedRoutes,
  auditOutcomeOf,
  auditRecord,
  type NewDeviceAlertPush,
  newDeviceAlert,
  PAIRING_REFUSAL_WINDOW_MS,
  type PairedDeviceNotice,
  PushNewDeviceAlert,
} from '../../../src/lib/audit/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../src/lib/grants/index.ts';
import {
  type PairingCryptography,
  type PairingDeviceRecord,
  PairingDeviceRegistry,
  type PairingDeviceStore,
} from '../../../src/lib/pairing/index.ts';
import type { PushDispatch } from '../../../src/lib/push/index.ts';
import { auditRoutes } from '../../../src/lib/runtime/mounts/audit.ts';
import { jsonBody, request } from '../api/support.ts';
import { grantSubsystem } from '../runtime/mounts/support.ts';

const AT = '2026-10-13T12:00:00.000Z';
const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}` as DaemonId;
const DEVICE_ID = `fy_device_id_${'d'.repeat(22)}`;
const OTHER_DEVICE_ID = `fy_device_id_${'e'.repeat(22)}`;
const CODE = '7F3K-Q2ND' as PairingCode;
const DEVICE_TOKEN = `fy_device_${'t'.repeat(43)}`;

class MemoryJournal implements AuditJournalPort {
  readonly lines: string[] = [];
  failure: Error | undefined;

  async append(line: string): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.lines.push(line);
  }

  async recent(limit: number): Promise<AuditReading> {
    const records = this.lines.map(line => JSON.parse(line) as AuditRecord).reverse();
    return { records: records.slice(0, limit), unreadable: 0 };
  }
}

function auditLog() {
  const journal = new MemoryJournal();
  const failures: string[] = [];
  const log = new AuditLog({
    journal,
    clock: { now: () => AT },
    failures: { auditWriteFailed: message => failures.push(message) },
  });
  return { journal, failures, log };
}

const records = (journal: MemoryJournal): AuditRecord[] => journal.lines.map(line => JSON.parse(line) as AuditRecord);

describe('audit policy', () => {
  it('should name the caller from the derived credential, never from anything sent', () => {
    // Arrange / Act / Assert
    should(auditActorOf(undefined, undefined)).deepEqual({ kind: 'anonymous' });
    should(auditActorOf({ kind: 'authenticated', tokenClass: 'admin' }, undefined)).deepEqual({ kind: 'host' });
    should(auditActorOf({ kind: 'authenticated', tokenClass: 'warden' }, undefined)).deepEqual({ kind: 'warden' });
    should(auditActorOf({ kind: 'authenticated', tokenClass: 'device', deviceId: DEVICE_ID }, 'Pixel')).deepEqual({
      kind: 'device',
      deviceId: DEVICE_ID,
      deviceName: 'Pixel',
    });
    should(auditActorOf({ kind: 'authenticated', tokenClass: 'device', deviceId: DEVICE_ID }, undefined)).deepEqual({
      kind: 'device',
      deviceId: DEVICE_ID,
    });
  });

  it('should read a refusal as refused and a fault as failed', () => {
    // Arrange / Act / Assert
    should(auditOutcomeOf(200)).equal('succeeded');
    should(auditOutcomeOf(201)).equal('succeeded');
    should(auditOutcomeOf(403)).equal('refused');
    should(auditOutcomeOf(500)).equal('failed');
    should(auditOutcomeOf(undefined)).equal('failed');
  });

  it('should stamp a record and refuse one the reader could not parse', () => {
    // Arrange
    const entry: AuditEntry = { event: 'grants.changed', actor: { kind: 'host' }, outcome: 'succeeded' };

    // Act
    const record = auditRecord(entry, AT);

    // Assert
    should(record).deepEqual({ at: AT, event: 'grants.changed', actor: { kind: 'host' }, outcome: 'succeeded' });
    should(auditRecord({ ...entry, subject: 's', detail: { n: 1 } }, AT)).deepEqual({
      ...record,
      subject: 's',
      detail: { n: 1 },
    });
    should(() => auditRecord({ ...entry, subject: 'x'.repeat(161) }, AT)).throw();
    should(() => auditRecord({ ...entry, detail: { argv: 'a\nb' } }, AT)).throw();
  });

  it('should tell the other devices a new one was paired, in plain words', () => {
    // Arrange / Act
    const payload = newDeviceAlert({ deviceId: DEVICE_ID, deviceName: 'Pixel 8' }, 'workstation');

    // Assert
    should(payload.title).equal('A new device was paired');
    should(payload.body).startWith('A new device, Pixel 8, was paired with workstation.');
    should('kind' in payload).be.false();
  });
});

describe('AuditLog', () => {
  it('should append one stamped line per record and read it back', async () => {
    // Arrange
    const { journal, log } = auditLog();

    // Act
    await log.record({ event: 'device.revoked', actor: { kind: 'host' }, subject: DEVICE_ID, outcome: 'succeeded' });
    const reading = await log.recent(10);

    // Assert
    should(journal.lines).have.length(1);
    should(reading.records[0]).deepEqual({
      at: AT,
      event: 'device.revoked',
      actor: { kind: 'host' },
      subject: DEVICE_ID,
      outcome: 'succeeded',
    });
  });

  it('should say a failed write out loud rather than throw it into the request', async () => {
    // Arrange
    const { journal, failures, log } = auditLog();
    journal.failure = new Error('disk full');

    // Act
    await log.record({ event: 'device.revoked', actor: { kind: 'host' }, outcome: 'succeeded' });
    journal.failure = undefined;
    // A record the contract refuses is reported the same way, and a non-Error is still described.
    await log.record({ event: 'device.revoked', actor: { kind: 'host' }, subject: '', outcome: 'succeeded' });
    const throwing = new AuditLog({
      journal: {
        append: async () => {
          throw 'gone';
        },
        recent: journal.recent.bind(journal),
      },
      clock: { now: () => AT },
      failures: { auditWriteFailed: message => failures.push(message) },
    });
    await throwing.record({ event: 'grants.changed', actor: { kind: 'host' }, outcome: 'succeeded' });

    // Assert
    should(journal.lines).have.length(0);
    should(failures).have.length(3);
    should(failures[0]).match(/device\.revoked event, so it has a gap: disk full/u);
    should(failures[2]).match(/gap: gone$/u);
  });
});

class FakePush implements NewDeviceAlertPush {
  readonly sent: Array<{ readonly dispatch: PushDispatch; readonly to: readonly string[] | undefined }> = [];
  enrolled: readonly PushDeviceView[] = [];
  failure: unknown;

  async list(): Promise<readonly PushDeviceView[]> {
    if (this.failure !== undefined) throw this.failure;
    return this.enrolled;
  }

  async notify(dispatch: PushDispatch, to?: readonly string[]): Promise<PushDeliveryResult> {
    this.sent.push({ dispatch, to });
    return { delivered: to?.length ?? 0, failed: 0 };
  }
}

const enrolment = (id: string): PushDeviceView => ({
  id,
  deviceName: 'Laptop',
  createdAt: AT,
  updatedAt: AT,
  expirationTime: null,
  prefs: { events: { attention: true, question: true, failed: true, completed: true }, interactiveOnly: false },
});

describe('PushNewDeviceAlert', () => {
  const device: PairedDeviceNotice = { deviceId: DEVICE_ID, deviceName: 'Pixel 8' };

  it('should push to every enrolment that already existed, and to nobody when none did', async () => {
    // Arrange
    const push = new FakePush();
    const failures: string[] = [];
    const alert = new PushNewDeviceAlert(push, 'workstation', { auditWriteFailed: message => failures.push(message) });

    // Act
    await alert.newDevicePaired(device);
    push.enrolled = [enrolment('push-1'), enrolment('push-2')];
    await alert.newDevicePaired(device);

    // Assert
    should(push.sent).have.length(1);
    should(push.sent[0]?.to).deepEqual(['push-1', 'push-2']);
    should(push.sent[0]?.dispatch.payload.body).match(/Pixel 8, was paired with workstation/u);
    should(failures).deepEqual([]);
  });

  it('should report a failed alert without undoing anything', async () => {
    // Arrange
    const push = new FakePush();
    const failures: string[] = [];
    const alert = new PushNewDeviceAlert(push, 'workstation', { auditWriteFailed: message => failures.push(message) });

    // Act
    push.failure = new Error('offline');
    await alert.newDevicePaired(device);
    push.failure = 'gone';
    await alert.newDevicePaired(device);

    // Assert
    should(failures).deepEqual([
      'the other devices could not be told that Pixel 8 was paired: offline',
      'the other devices could not be told that Pixel 8 was paired: gone',
    ]);
  });
});

const CREDENTIALS = {
  admin: 'admin-secret',
  warden: 'warden-secret',
  devices: { identify: (token: string) => (token === 'device-secret' ? DEVICE_ID : undefined) },
};
const ADMIN = { authorization: 'Bearer admin-secret' };
const DEVICE = { authorization: 'Bearer device-secret' };
const WARDEN = { authorization: 'Bearer warden-secret' };

async function dispatcher(routes: readonly ApiRoute[]) {
  const grants = grantSubsystem({ grants: DEFAULT_CAPABILITY_GRANTS });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(routes), CREDENTIALS, grants);
}

function decorated(handlers: Partial<Record<string, ApiRoute['handle']>>) {
  const { journal, log } = auditLog();
  const names = new Map([
    [DEVICE_ID, 'Pixel 8'],
    [OTHER_DEVICE_ID, 'Old phone'],
  ]);
  const ok: ApiRoute['handle'] = async () => jsonResponse({ ok: true });
  const base: ApiRoute[] = [
    ...AUDITED_ROUTES.map(rule => ({
      method: rule.method,
      path: rule.path,
      minimum: 'operator' as const,
      handle: handlers[`${rule.method} ${rule.path}`] ?? ok,
    })),
    { method: 'GET', path: '/v1/unaudited', minimum: 'operator', handle: ok },
  ];
  const routes = auditedRoutes({ log, deviceName: async id => names.get(id) }, base);
  return { journal, routes };
}

describe('auditedRoutes', () => {
  it('should record each audited route with its actor, subject and outcome, and leave the rest alone', async () => {
    // Arrange
    const { journal, routes } = decorated({});
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(request({ method: 'POST', path: '/v1/pair/code', headers: ADMIN }));
    await api.dispatch(request({ method: 'DELETE', path: `/v1/pair/devices/${OTHER_DEVICE_ID}`, headers: DEVICE }));
    await api.dispatch(request({ method: 'POST', path: '/v1/sessions/s-1/terminals', headers: ADMIN }));
    await api.dispatch(request({ method: 'POST', path: '/v1/fleet/proposals/p-1/apply', headers: ADMIN }));
    await api.dispatch(request({ method: 'GET', path: '/v1/unaudited', headers: ADMIN }));

    // Assert
    should(records(journal)).deepEqual([
      { at: AT, event: 'pairing.code-minted', actor: { kind: 'host' }, outcome: 'succeeded', detail: { status: 200 } },
      {
        at: AT,
        event: 'device.revoked',
        actor: { kind: 'device', deviceId: DEVICE_ID, deviceName: 'Pixel 8' },
        subject: OTHER_DEVICE_ID,
        outcome: 'succeeded',
        detail: { deviceName: 'Old phone', status: 200 },
      },
      {
        at: AT,
        event: 'terminal.opened',
        actor: { kind: 'host' },
        subject: 's-1',
        outcome: 'succeeded',
        detail: { status: 200 },
      },
      {
        at: AT,
        event: 'fleet.configured',
        actor: { kind: 'host' },
        subject: 'p-1',
        outcome: 'succeeded',
        detail: { action: 'apply', status: 200 },
      },
    ]);
  });

  it('should record a refusal and a fault, and pass each through untouched', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'PATCH /v1/grants': async () => {
        throw new ApiError(403, 'no', 'grant_forbidden');
      },
      'POST /v1/fleet/login': async () => {
        throw new Error('boom');
      },
      'POST /v1/fleet/machine/tools/install': async () => {
        throw Object.assign(new Error('odd'), { status: 'teapot' });
      },
    });
    const api = await dispatcher(routes);

    // Act
    const refused = await api.dispatch(request({ method: 'PATCH', path: '/v1/grants', headers: ADMIN, body: '{}' }));
    const failed = await api.dispatch(request({ method: 'POST', path: '/v1/fleet/login', headers: ADMIN }));
    await api.dispatch(request({ method: 'POST', path: '/v1/fleet/machine/tools/install', headers: ADMIN }));

    // Assert
    should(refused.status).equal(403);
    should(failed.status).equal(500);
    should(records(journal).map(record => [record.event, record.outcome, record.detail])).deepEqual([
      ['grants.changed', 'refused', { status: 403 }],
      ['fleet.configured', 'failed', { action: 'sign-in' }],
      ['fleet.configured', 'failed', { action: 'install-tool' }],
    ]);
  });

  it('should take only the NAMES of the secrets used, never the output', async () => {
    // Arrange
    const many = Array.from({ length: 40 }, (_, index) => `SECRET_NUMBER_${String(index)}`);
    let answer: unknown = { outcome: 'exited', stdout: 'hunter2-the-value', stderr: '', used: ['API_KEY', 'DB_PASS'] };
    const { journal, routes } = decorated({ 'POST /v1/secrets/use': async () => jsonResponse(answer) });
    const api = await dispatcher(routes);
    const use = async () =>
      await api.dispatch(
        request({ method: 'POST', path: '/v1/secrets/use', headers: ADMIN, body: '{"command":["echo","hunter2"]}' }),
      );

    // Act
    await use();
    answer = { used: [] };
    await use();
    answer = { used: [1, 2] };
    await use();
    answer = { used: many };
    await use();

    // Assert
    const written = records(journal);
    should(written[0]?.detail).deepEqual({ used: 'API_KEY,DB_PASS', status: 200 });
    should(written[1]?.detail).deepEqual({ status: 200 });
    should(written[2]?.detail).deepEqual({ status: 200 });
    const joined = String(written[3]?.detail?.used);
    should(joined.length <= 160).be.true();
    should(joined).match(/^SECRET_NUMBER_0,.*,\+\d+$/u);
    should(journal.lines.join('\n')).not.containEql('hunter2');
  });

  it('should keep a non-JSON body out of the names', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'POST /v1/secrets/use': async () => ({ status: 200, headers: new Map(), body: 'not json' }),
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(request({ method: 'POST', path: '/v1/secrets/use', headers: ADMIN }));

    // Assert
    should(records(journal)[0]?.detail).deepEqual({ status: 200 });
  });
});

describe('GET /v1/audit', () => {
  it('should serve newest first, bounded, and refuse a limit past 200', async () => {
    // Arrange
    const { journal, log } = auditLog();
    for (const subject of ['one', 'two', 'three'])
      await log.record({ event: 'terminal.opened', actor: { kind: 'host' }, subject, outcome: 'succeeded' });
    const api = await dispatcher(auditRoutes({ recent: async limit => await journal.recent(limit) }));

    // Act
    const page = await api.dispatch(request({ path: '/v1/audit', query: [['limit', '2']], headers: ADMIN }));
    const fallback = await api.dispatch(request({ path: '/v1/audit', headers: ADMIN }));
    const tooMany = await api.dispatch(request({ path: '/v1/audit', query: [['limit', '201']], headers: ADMIN }));
    const warden = await api.dispatch(request({ path: '/v1/audit', headers: WARDEN }));

    // Assert
    should(page.status).equal(200);
    should((jsonBody(page) as { records: AuditRecord[] }).records.map(record => record.subject)).deepEqual([
      'three',
      'two',
    ]);
    should((jsonBody(fallback) as { records: unknown[] }).records).have.length(3);
    should(tooMany.status).equal(400);
    should(warden.status).equal(403);
  });

  it('should be refused when the operator switched pairing off for remote devices', async () => {
    // Arrange
    const grants = grantSubsystem({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: false, configure: false } },
    });
    await grants.refresh();
    const api = new ApiDispatcher(
      new ApiRouter(auditRoutes({ recent: async () => ({ records: [], unreadable: 0 }) })),
      CREDENTIALS,
      grants,
    );

    // Act
    const response = await api.dispatch(request({ path: '/v1/audit', headers: DEVICE }));

    // Assert
    should(response.status).equal(403);
  });
});

class Devices implements PairingDeviceStore {
  records: PairingDeviceRecord[] = [];
  async add(record: PairingDeviceRecord): Promise<void> {
    this.records.push(record);
  }
  async list(): Promise<readonly PairingDeviceRecord[]> {
    return this.records;
  }
  async remove(): Promise<boolean> {
    return false;
  }
}

class Cryptography implements PairingCryptography {
  pairingCode = (): string => CODE;
  pairingId = (): string => `fy_pair_${'p'.repeat(22)}`;
  deviceToken = (): string => DEVICE_TOKEN;
  deviceId = (): string => DEVICE_ID;
  hashDeviceToken = (daemonId: string, token: string): string => `hash:${daemonId}:${token}`;
}

function pairing(options: { readonly addFails?: boolean } = {}) {
  const { journal, log } = auditLog();
  const alerts: PairedDeviceNotice[] = [];
  let nowMs = Date.parse(AT);
  const devices = new Devices();
  if (options.addFails === true)
    devices.add = async () => {
      throw new Error('disk');
    };
  const cryptography = new Cryptography();
  const service = new AuditedPairingService(
    {
      daemonId: DAEMON_ID,
      daemonName: 'workstation',
      advertisement: { kind: 'address', url: 'https://workstation.example.test', origin: 'operator' },
      carriers: [],
      clock: { now: () => nowMs },
      cryptography,
      devices,
      credentials: new PairingDeviceRegistry(DAEMON_ID, cryptography),
      operatorPassword: { isSet: async () => true },
      clientName: 'fy',
    },
    { log, alert: { newDevicePaired: async device => void alerts.push(device) }, nowMs: () => nowMs },
  );
  return { journal, alerts, service, tick: (ms: number) => (nowMs += ms) };
}

describe('AuditedPairingService', () => {
  it('should record a direct pairing by id and name, and alert the others', async () => {
    // Arrange
    const { journal, alerts, service } = pairing();
    await service.mint();

    // Act
    const result = await service.redeem({ code: CODE, deviceName: 'Pixel 8' }, 'peer');

    // Assert
    should(result.kind).equal('paired');
    should(records(journal)).deepEqual([
      {
        at: AT,
        event: 'device.paired',
        actor: { kind: 'device', deviceId: DEVICE_ID, deviceName: 'Pixel 8' },
        subject: DEVICE_ID,
        outcome: 'succeeded',
        detail: { carrier: 'direct' },
      },
    ]);
    should(alerts).deepEqual([{ deviceId: DEVICE_ID, deviceName: 'Pixel 8' }]);
    // NAMES AND IDS ONLY: neither the code nor the issued credential reached the log.
    should(journal.lines.join('\n')).not.containEql(CODE).and.not.containEql(DEVICE_TOKEN);
  });

  it('should record a relayed pairing as relayed', async () => {
    // Arrange
    const { journal, service } = pairing();
    await service.mint();

    // Act
    await service.redeemOverRelay({ code: CODE, deviceName: 'Phone' });

    // Assert
    should(records(journal)[0]?.detail).deepEqual({ carrier: 'relay' });
  });

  it('should fold a burst of refusals into one record per window per carrier', async () => {
    // Arrange
    const { journal, alerts, service, tick } = pairing();

    // Act
    await service.redeem({ code: 'WRONG' }, 'peer');
    await service.redeem({ code: 'WRONG' }, 'peer');
    await service.redeem({ code: 'WRONG' }, 'peer');
    await service.redeemOverRelay({ code: 'WRONG', deviceName: 'x' });
    tick(PAIRING_REFUSAL_WINDOW_MS);
    await service.redeem({ code: 'WRONG' }, 'peer');
    tick(PAIRING_REFUSAL_WINDOW_MS);
    await service.redeem({ code: 'WRONG' }, 'peer');

    // Assert
    should(records(journal).map(record => [record.event, record.actor.kind, record.detail])).deepEqual([
      ['pairing.refused', 'anonymous', { carrier: 'direct' }],
      ['pairing.refused', 'anonymous', { carrier: 'relay' }],
      ['pairing.refused', 'anonymous', { carrier: 'direct', earlierRefusals: 2 }],
      ['pairing.refused', 'anonymous', { carrier: 'direct' }],
    ]);
    should(alerts).deepEqual([]);
    should(journal.lines.join('\n')).not.containEql('WRONG');
  });

  it('should record a pairing it cannot attribute without alerting anybody', async () => {
    // Arrange
    const { journal, alerts, service } = pairing();
    await service.mint();
    // A grant store that never shows the new device stands in for one that cannot be read back.
    (service as unknown as { devices: () => Promise<never[]> }).devices = async () => [];

    // Act
    await service.redeem({ code: CODE, deviceName: 'Pixel 8' }, 'peer');

    // Assert
    should(records(journal)).deepEqual([
      {
        at: AT,
        event: 'device.paired',
        actor: { kind: 'device' },
        outcome: 'succeeded',
        detail: { carrier: 'direct' },
      },
    ]);
    should(alerts).deepEqual([]);
  });

  it('should record a redemption the store refused as a refusal', async () => {
    // Arrange
    const { journal, service } = pairing({ addFails: true });
    await service.mint();

    // Act
    await service.redeem({ code: CODE, deviceName: 'Pixel 8' }, 'peer');

    // Assert
    should(records(journal).map(record => record.event)).deepEqual(['pairing.refused']);
  });
});
