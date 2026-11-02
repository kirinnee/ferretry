import { describe, it } from 'bun:test';
import type { AuditRecord, DaemonId, PairingCode, PushDeliveryResult, PushDeviceView } from '@ferretry/protocol';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import {
  ApiDispatcher,
  ApiError,
  type ApiRoute,
  ApiRouter,
  jsonResponse,
  jsonTextResponse,
} from '../../../src/lib/api/index.ts';
import type { RouteContext } from '../../../src/lib/api/route.ts';
import type { SocketDownstream, SocketFrame, SocketRoute } from '../../../src/lib/api/socket.ts';
import {
  AUDIT_FOLD_WINDOW_MS,
  AUDIT_INVALID_TEXT,
  AUDIT_KEPT_DAILY_ALLOWANCE,
  AUDITED_ROUTES,
  AUDITED_SOCKET_ROUTES,
  type AuditEntry,
  AuditedPairingService,
  type AuditJournalPort,
  AuditLog,
  type AuditReading,
  type AuditRotation,
  type AuditStore,
  agentAuditDetail,
  auditActorOf,
  auditedRoutes,
  auditedSocketRoutes,
  auditFoldKey,
  auditOutcomeOf,
  auditRecord,
  isKeptAuditEntry,
  type NewDeviceAlertPush,
  newDeviceAlert,
  type PairedDeviceNotice,
  PushNewDeviceAlert,
  recordHandlerAct,
  withinAuditBounds,
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
/** An Ed25519 SPKI: the fixed DER prefix and 32 key bytes. */
const DEVICE_KEY = toBase64Url(
  new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...new Array(32).fill(5)]),
);

class MemoryJournal implements AuditJournalPort {
  readonly lines: string[] = [];
  readonly stores: AuditStore[] = [];
  readonly rotations: AuditRotation[] = [];
  failure: Error | undefined;
  /** When set, the kept store is full: a `never` append to it is refused. */
  keptFull = false;

  async append(line: string, store: AuditStore, rotation: AuditRotation = 'rotate'): Promise<boolean> {
    if (this.failure !== undefined) throw this.failure;
    if (store === 'kept' && this.keptFull && rotation === 'never') return false;
    this.lines.push(line);
    this.stores.push(store);
    this.rotations.push(rotation);
    return true;
  }

  async recent(limit: number, keptOffset: number): Promise<AuditReading> {
    const all = this.lines.map((line, index) => ({
      record: JSON.parse(line) as AuditRecord,
      store: this.stores[index],
    }));
    const of = (store: AuditStore) =>
      all
        .filter(entry => entry.store === store)
        .map(entry => entry.record)
        .reverse();
    const kept = of('kept');
    return {
      records: of('general').slice(0, limit),
      kept: kept.slice(keptOffset, keptOffset + limit),
      keptTotal: kept.length,
      unreadable: 0,
    };
  }
}

function auditLog() {
  const journal = new MemoryJournal();
  const failures: string[] = [];
  const clock = { nowMs: Date.parse(AT) };
  const log = new AuditLog({
    journal,
    clock: { now: () => new Date(clock.nowMs).toISOString() },
    failures: { auditWriteFailed: message => failures.push(message) },
  });
  return { journal, failures, log, tick: (ms: number) => (clock.nowMs += ms) };
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

  it('should log a ferret’s own credential as this host, and name the ferret in the detail', () => {
    // Arrange
    const own = { kind: 'authenticated', tokenClass: 'session', sessionId: 's1' } as const;

    // Act / Assert — on this machine, like the agent tools' records; never a warden, never the token itself.
    should(auditActorOf(own, undefined)).deepEqual({ kind: 'host' });
    should(agentAuditDetail(own)).deepEqual({ by: 'agent', session: 's1' });
    should(agentAuditDetail({ kind: 'authenticated', tokenClass: 'admin' })).deepEqual({});
    should(agentAuditDetail(undefined)).deepEqual({});
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
    const payload = newDeviceAlert(
      { deviceId: DEVICE_ID, deviceName: 'Pixel 8', carrier: 'relay', createdAt: AT },
      'workstation',
    );
    const direct = newDeviceAlert(
      { deviceId: DEVICE_ID, deviceName: 'this computer', carrier: 'direct', createdAt: AT },
      'workstation',
    );

    // Assert
    should(payload.title).equal('A new device was paired');
    // The chosen name is quoted beside the facts nobody chose: the short id, the carrier, the time.
    should(payload.body).equal(
      `A device calling itself “Pixel 8” (…dddddd) was paired with workstation over the relay at ${AT}. If that was not you, remove it in Settings.`,
    );
    should(direct.body).startWith(
      'A device calling itself “this computer” (…dddddd) was paired with workstation on the local network',
    );
    should(payload.eventKey).equal(`device-paired:${DEVICE_ID}`);
    // `kind` IS carried now, so a reader's own local "new device" switch can filter it; it is the
    // one kind a payload about no session may name.
    should(payload.kind).equal('device-paired');
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
    should(reading.records).deepEqual([]);
    should(reading.keptTotal).equal(1);
    should(reading.kept[0]).deepEqual({
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
    const tooMany = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`k${String(index)}`, index]));
    await log.record({ event: 'device.revoked', actor: { kind: 'host' }, detail: tooMany, outcome: 'succeeded' });
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

describe('recordHandlerAct', () => {
  /** A sink that keeps what it is told, or refuses every write with `failure`. */
  function subsystem(failure?: unknown) {
    const recorded: AuditEntry[] = [];
    const failures: string[] = [];
    return {
      recorded,
      failures,
      sink: {
        log: {
          record: async (entry: AuditEntry) => {
            if (failure !== undefined) throw failure;
            recorded.push(entry);
          },
        },
        failures: { auditWriteFailed: (message: string) => failures.push(message) },
        deviceName: async () => 'Owner’s phone',
      },
    };
  }

  const context = (credential: RouteContext['credential']): RouteContext => ({
    request: request({ method: 'POST', path: '/v1/sessions/s1/agenda' }),
    params: new Map(),
    ...(credential === undefined ? {} : { credential }),
  });

  it('should record the act as the boundary proved the caller, a paired device by its name', async () => {
    // Arrange
    const { recorded, failures, sink } = subsystem();

    // Act
    await recordHandlerAct(sink, context({ kind: 'authenticated', tokenClass: 'device', deviceId: 'phone' }), {
      event: 'fleet.configured',
      outcome: 'succeeded',
      detail: { action: 'config-confirm', via: 'agenda' },
    });

    // Assert
    should(recorded).deepEqual([
      {
        event: 'fleet.configured',
        actor: { kind: 'device', deviceId: 'phone', deviceName: 'Owner’s phone' },
        outcome: 'succeeded',
        detail: { action: 'config-confirm', via: 'agenda' },
      },
    ]);
    should(failures).be.empty();
  });

  it('should name a ferret’s session in the detail, and write no detail when there is none', async () => {
    // Arrange
    const { recorded, sink } = subsystem();

    // Act
    await recordHandlerAct(sink, context({ kind: 'authenticated', tokenClass: 'session', sessionId: 's1' }), {
      event: 'fleet.configured',
      outcome: 'refused',
    });
    await recordHandlerAct(sink, context({ kind: 'authenticated', tokenClass: 'admin' }), {
      event: 'fleet.configured',
      outcome: 'refused',
    });

    // Assert
    should(recorded).deepEqual([
      {
        event: 'fleet.configured',
        actor: { kind: 'host' },
        outcome: 'refused',
        detail: { by: 'agent', session: 's1' },
      },
      { event: 'fleet.configured', actor: { kind: 'host' }, outcome: 'refused' },
    ]);
  });

  it('should say a write it could not make out loud rather than fail the request', async () => {
    // Arrange
    const { recorded, failures, sink } = subsystem(new Error('disk full'));

    // Act
    await recordHandlerAct(sink, context({ kind: 'authenticated', tokenClass: 'admin' }), {
      event: 'fleet.configured',
      outcome: 'succeeded',
    });

    // Assert
    should(recorded).be.empty();
    should(failures).deepEqual([
      'the security log could not record a fleet.configured event, so it has a gap: disk full',
    ]);
  });
});

describe('audit folding and bounds', () => {
  const refusal: AuditEntry = {
    event: 'grants.changed',
    actor: { kind: 'device', deviceId: DEVICE_ID },
    outcome: 'refused',
    subject: 'one',
  };

  it('should fold repeats of one refusal into a counted record when the window closes', async () => {
    // Arrange
    const { journal, log, tick } = auditLog();

    // Act
    await log.record(refusal);
    await log.record({ ...refusal, subject: 'two' });
    await log.record({ ...refusal, subject: 'three' });
    await log.flush(Date.parse(AT) + AUDIT_FOLD_WINDOW_MS - 1);
    const beforeClose = journal.lines.length;
    tick(AUDIT_FOLD_WINDOW_MS);
    await log.record(refusal);

    // Assert
    should(beforeClose).equal(1);
    should(records(journal).map(record => [record.subject, record.detail])).deepEqual([
      ['one', undefined],
      // The summary names no subject: a flood of random ids is one flood.
      [undefined, { repeats: 2 }],
      ['one', undefined],
    ]);
  });

  it('should close a window that stopped, on the flush timer', async () => {
    // Arrange
    const { journal, log, tick } = auditLog();
    await log.record(refusal);
    await log.record(refusal);
    await log.record(refusal);

    // Act
    tick(AUDIT_FOLD_WINDOW_MS);
    await log.flush();
    await log.flush();

    // Assert
    should(records(journal).map(record => record.detail)).deepEqual([undefined, { repeats: 2 }]);
  });

  it('should write nothing more for a window that held a single record', async () => {
    // Arrange
    const { journal, log } = auditLog();
    await log.record(refusal);

    // Act
    await log.flush(Number.POSITIVE_INFINITY);

    // Assert
    should(journal.lines).have.length(1);
  });

  it('should count keystrokes per terminal and keep the terminal on the summary', async () => {
    // Arrange
    const { journal, log } = auditLog();
    const input = (subject: string): AuditEntry => ({
      event: 'terminal.input',
      actor: { kind: 'host' },
      subject,
      outcome: 'succeeded',
    });

    // Act
    for (let index = 0; index < 5; index += 1) await log.record(input('term-1'));
    await log.record(input('term-2'));
    await log.flush(Number.POSITIVE_INFINITY);

    // Assert
    should(records(journal).map(record => [record.subject, record.detail])).deepEqual([
      ['term-1', undefined],
      ['term-2', undefined],
      ['term-1', { repeats: 4 }],
    ]);
    // Activity: folded, and never in the kept store, however much of it there is.
    should(journal.stores).deepEqual(['general', 'general', 'general']);
  });

  it('should close every window first when the table of open windows is full', async () => {
    // Arrange
    const { journal, log } = auditLog();
    for (let index = 0; index < 1_024; index += 1) {
      const entry: AuditEntry = { ...refusal, actor: { kind: 'device', deviceId: `d-${String(index)}` } };
      await log.record(entry);
      await log.record(entry);
    }

    // Act
    await log.record({ ...refusal, actor: { kind: 'device', deviceId: 'd-new' } });

    // Assert: 1024 firsts, 1024 summaries, then the new first.
    should(journal.lines).have.length(2_049);
    should(records(journal).at(-1)?.actor.deviceId).equal('d-new');
  });

  it('should key repeats by who, what, how it ended and the carrier — never the subject', () => {
    // Arrange / Act / Assert
    should(auditFoldKey({ ...refusal, outcome: 'succeeded' })).be.undefined();
    should(auditFoldKey({ ...refusal, event: 'device.paired', outcome: 'succeeded' })).be.undefined();
    should(auditFoldKey(refusal)).equal(auditFoldKey({ ...refusal, subject: 'other' }));
    should(auditFoldKey(refusal)).not.equal(auditFoldKey({ ...refusal, outcome: 'failed' }));
    should(auditFoldKey({ ...refusal, detail: { carrier: 'relay' } })).not.equal(
      auditFoldKey({ ...refusal, detail: { carrier: 'direct' } }),
    );
    should(auditFoldKey({ ...refusal, actor: { kind: 'host' } })).not.equal(auditFoldKey(refusal));
  });

  it('should keep only SUCCESSES of high-value events out of a flood’s reach', () => {
    // Arrange / Act / Assert
    should(isKeptAuditEntry({ ...refusal, outcome: 'succeeded' })).be.true();
    should(isKeptAuditEntry(refusal)).be.false();
    should(
      isKeptAuditEntry({ event: 'pairing.refused', actor: { kind: 'anonymous' }, outcome: 'succeeded' }),
    ).be.false();
    // Activity a paired device can repeat at will is never kept: a store that took it could be flooded.
    for (const event of [
      'terminal.opened',
      'terminal.input',
      'secrets.used',
      'fleet.configured',
      'agent.prompted',
    ] as const)
      should(isKeptAuditEntry({ ...refusal, event, outcome: 'succeeded' })).be.false();
  });

  it('should fold a repeated SUCCESS of activity per who, what, subject and detail', async () => {
    // Arrange
    const { journal, log } = auditLog();
    const attach = (subject: string, mode = 'attach'): AuditEntry => ({
      event: 'terminal.opened',
      actor: { kind: 'device', deviceId: DEVICE_ID },
      subject,
      outcome: 'succeeded',
      detail: { mode },
    });

    // Act
    for (let index = 0; index < 500; index += 1) await log.record(attach('term-1'));
    await log.record(attach('term-2'));
    await log.record(attach('term-1', 'create'));
    await log.flush(Number.POSITIVE_INFINITY);

    // Assert
    should(records(journal).map(record => [record.subject, record.detail])).deepEqual([
      ['term-1', { mode: 'attach' }],
      ['term-2', { mode: 'attach' }],
      ['term-1', { mode: 'create' }],
      ['term-1', { mode: 'attach', repeats: 499 }],
    ]);
    should(journal.stores.every(store => store === 'general')).be.true();
    should(auditFoldKey(attach('a'))).not.equal(auditFoldKey({ ...attach('a'), actor: { kind: 'host' } }));
  });

  it('should ration every caller but a person at the machine to one shared daily allowance per kept event', async () => {
    // Arrange
    const { failures, journal, log, tick } = auditLog();
    const grantChange = (deviceId: string): AuditEntry => ({
      event: 'grants.changed',
      actor: { kind: 'device', deviceId },
      outcome: 'succeeded',
    });
    const paired = (index: number): AuditEntry => ({
      event: 'device.paired',
      actor: { kind: 'device', deviceId: `d-${String(index)}` },
      subject: `d-${String(index)}`,
      outcome: 'succeeded',
    });

    // Act: two devices together spend the grant allowance and keep going — which must not touch the
    // pairing allowance; then pairings past their own allowance; the owner is never rationed.
    for (let index = 0; index < AUDIT_KEPT_DAILY_ALLOWANCE + 30; index += 1)
      await log.record(grantChange(index % 2 === 0 ? DEVICE_ID : OTHER_DEVICE_ID));
    for (let index = 0; index < AUDIT_KEPT_DAILY_ALLOWANCE + 3; index += 1) await log.record(paired(index));
    await log.record({ event: 'grants.changed', actor: { kind: 'host' }, outcome: 'succeeded' });
    await log.flush();
    const sameDay = journal.stores.filter(store => store === 'kept').length;
    tick(86_400_000);
    await log.flush();
    await log.record(grantChange(DEVICE_ID));

    // Assert
    const kept = records(journal).filter((_, index) => journal.stores[index] === 'kept');
    // Each allowance, one marked overspend per event, and the owner's: a fixed number whoever floods.
    should(sameDay).equal(2 * AUDIT_KEPT_DAILY_ALLOWANCE + 3);
    // Grant churn did not spend the pairing allowance: the fiftieth pairing is still kept in full.
    should(kept.filter(record => record.event === 'device.paired' && record.detail === undefined)).have.length(
      AUDIT_KEPT_DAILY_ALLOWANCE,
    );
    should(
      kept.filter(record => record.detail?.keptAllowanceSpent === true).map(record => [record.event, record.detail]),
    ).deepEqual([
      ['grants.changed', { keptAllowanceSpent: true }],
      ['device.paired', { keptAllowanceSpent: true }],
      ['grants.changed', { keptAllowanceSpent: true, repeats: 29 }],
      // The pairings past the allowance are still NAMED in the kept store.
      ['device.paired', { keptAllowanceSpent: true, repeats: 2, subjects: 'd-51,d-52' }],
    ]);
    // A new day, a new allowance.
    should(kept.at(-1)?.detail).be.undefined();
    // Every overspent record is still in the ordinary history, in full.
    should(journal.stores.filter(store => store === 'general')).have.length(33);
    should(
      journal.rotations.filter((rotation, index) => journal.stores[index] === 'kept' && rotation === 'rotate'),
    ).have.length(1);
    should(failures).deepEqual([]);
  });

  it('should ration a record the DAEMON caused, though the machine is its actor, and never let it rotate', async () => {
    // Arrange: a paired device can decide how many idle expiries happen, so they are rationed.
    const { journal, log } = auditLog();
    const expiry = (index: number): AuditEntry => ({
      event: 'device.expired',
      actor: { kind: 'host' },
      cause: 'daemon',
      subject: `fy_device_id_${String(index).padStart(22, '0')}`,
      outcome: 'succeeded',
    });

    // Act
    for (let index = 0; index < AUDIT_KEPT_DAILY_ALLOWANCE + 40; index += 1) await log.record(expiry(index));
    await log.flush(Number.POSITIVE_INFINITY);

    // Assert
    const keptIndexes = journal.stores.flatMap((store, index) => (store === 'kept' ? [index] : []));
    should(keptIndexes).have.length(AUDIT_KEPT_DAILY_ALLOWANCE + 2);
    should(keptIndexes.every(index => journal.rotations[index] === 'never')).be.true();
    const summary = records(journal).at(-1);
    should(summary?.detail?.repeats).equal(39);
    // Named until the field is full, then counted: the record still fits the contract.
    should(String(summary?.detail?.subjects)).match(/^fy_device_id_0+51,.*,\+\d+$/u);
    should(String(summary?.detail?.subjects).length <= 160).be.true();
  });

  it('should write a device’s kept record to the ordinary history, and say so, when the kept store is full', async () => {
    // Arrange
    const { failures, journal, log } = auditLog();
    journal.keptFull = true;

    // Act
    await log.record({ event: 'device.paired', actor: { kind: 'device', deviceId: DEVICE_ID }, outcome: 'succeeded' });
    await log.record({ event: 'device.paired', actor: { kind: 'host' }, outcome: 'succeeded' });

    // Assert
    should(journal.stores).deepEqual(['general', 'kept']);
    should(failures).have.length(1);
    should(failures[0]).containEql('kept store is full');
  });

  it('should write an over-long or control-character subject as <invalid> with its length', async () => {
    // Arrange
    const { journal, failures, log } = auditLog();

    // Act
    await log.record({ ...refusal, outcome: 'succeeded', subject: 'x'.repeat(161) });
    await log.record({ ...refusal, outcome: 'succeeded', subject: 'evil\u202Eid' });
    await log.record({ ...refusal, outcome: 'succeeded', detail: { action: 'a\nb', n: 1 } });

    // Assert
    should(failures).deepEqual([]);
    should(records(journal).map(record => [record.subject, record.detail])).deepEqual([
      [AUDIT_INVALID_TEXT, { subjectLength: 161 }],
      [AUDIT_INVALID_TEXT, { subjectLength: 7 }],
      ['one', { action: AUDIT_INVALID_TEXT, n: 1 }],
    ]);
    should(journal.lines.join('\n')).not.containEql('xxxxxxxxxx').and.not.containEql('evil');
    should(withinAuditBounds(refusal)).equal(refusal);
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
});

describe('PushNewDeviceAlert', () => {
  const device: PairedDeviceNotice = { deviceId: DEVICE_ID, deviceName: 'Pixel 8', carrier: 'direct', createdAt: AT };

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
    should(push.sent[0]?.dispatch.payload.body).match(/“Pixel 8” \(…dddddd\) was paired with workstation/u);
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
      'the other devices could not be told that device …dddddd was paired: offline',
      'the other devices could not be told that device …dddddd was paired: gone',
    ]);
  });
});

const CREDENTIALS = {
  admin: 'admin-secret',
  warden: 'warden-secret',
  devices: { has: (deviceId: string) => deviceId === DEVICE_ID },
};
const ADMIN = { authorization: 'Bearer admin-secret' };
const DEVICE = { deviceId: DEVICE_ID, appSession: 'app-one' };
const WARDEN = { authorization: 'Bearer warden-secret' };

async function dispatcher(routes: readonly ApiRoute[]) {
  const grants = grantSubsystem({ grants: DEFAULT_CAPABILITY_GRANTS });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(routes), CREDENTIALS, grants);
}

function decorated(handlers: Partial<Record<string, ApiRoute['handle']>>) {
  const { journal, log, failures } = auditLog();
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
      caller: 'any' as const,
      handle: handlers[`${rule.method} ${rule.path}`] ?? ok,
    })),
    { method: 'GET', path: '/v1/unaudited', minimum: 'operator', caller: 'any', handle: ok },
  ];
  const routes = auditedRoutes(
    { log, deviceName: async id => names.get(id), failures: { auditWriteFailed: message => failures.push(message) } },
    base,
  );
  return { journal, routes, failures };
}

describe('auditedRoutes', () => {
  it('should record each audited route with its actor, subject and outcome, and leave the rest alone', async () => {
    // Arrange
    const { journal, routes } = decorated({});
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(request({ method: 'POST', path: '/v1/pair/code', headers: ADMIN, loopback: true }));
    await api.dispatch(request({ method: 'DELETE', path: `/v1/pair/devices/${OTHER_DEVICE_ID}`, device: DEVICE }));
    await api.dispatch(request({ method: 'POST', path: '/v1/sessions/s-1/terminals', headers: ADMIN, loopback: true }));
    await api.dispatch(
      request({ method: 'POST', path: '/v1/fleet/proposals/p-1/apply', headers: ADMIN, loopback: true }),
    );
    await api.dispatch(request({ method: 'GET', path: '/v1/unaudited', headers: ADMIN, loopback: true }));

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

  it('should record catalog changes by id, version and digest, and never what an item holds', async () => {
    // Arrange
    const CAT = `cat_${'A'.repeat(22)}`;
    const ITEM = `itm_${'B'.repeat(22)}`;
    const DIGEST = `sha256:${'c'.repeat(64)}`;
    const answers: Record<string, unknown> = {
      'POST /v1/catalogs': { id: CAT, revision: 1, name: 'secret name text with spaces' },
      'POST /v1/catalogs/:id/items': {
        itemId: ITEM,
        itemVersion: 1,
        digest: DIGEST,
        revision: 2,
        item: { files: 'x' },
      },
      'DELETE /v1/catalogs/:id/items/:itemId': { itemId: ITEM, revision: 3 },
      'POST /v1/catalogs/:id/export': {
        signedManifest: { manifest: { revision: 3 } },
        items: [{ itemId: ITEM }, { itemId: `itm_${'D'.repeat(22)}` }],
      },
    };
    const handlers = Object.fromEntries(
      Object.entries(answers).map(([key, body]) => [key, async () => jsonResponse(body)] as const),
    );
    const { journal, routes } = decorated(handlers);
    const api = await dispatcher(routes);

    // Act
    for (const [method, path] of [
      ['POST', '/v1/catalogs'],
      ['POST', `/v1/catalogs/${CAT}/items`],
      ['DELETE', `/v1/catalogs/${CAT}/items/${ITEM}`],
      ['POST', `/v1/catalogs/${CAT}/export`],
    ] as const)
      await api.dispatch(request({ method, path, headers: ADMIN, loopback: true, body: '{}' }));

    // Assert
    const logged = records(journal);
    should(logged.map(record => record.event)).deepEqual([
      'catalog.changed',
      'catalog.changed',
      'catalog.changed',
      'catalog.exported',
    ]);
    should(logged[0]?.detail).containEql({ action: 'create', catalogId: CAT, revision: 1 });
    should(logged[1]?.detail).containEql({
      action: 'publish',
      itemId: ITEM,
      itemVersion: 1,
      digest: DIGEST,
      revision: 2,
    });
    should(logged[2]?.detail).containEql({ action: 'withdraw', itemId: ITEM, revision: 3 });
    should(logged[3]?.subject).equal(CAT);
    should(logged[3]?.detail).containEql({ revision: 3, itemIds: `${ITEM},itm_${'D'.repeat(22)}` });
    should(JSON.stringify(logged)).not.match(/secret name|files/u);
  });

  it('should record a publish at the item by ids only', async () => {
    // Arrange
    const CAT = `cat_${'A'.repeat(22)}`;
    const OTHER = `cat_${'E'.repeat(22)}`;
    const ITEM = `itm_${'B'.repeat(22)}`;
    const DIGEST = `sha256:${'c'.repeat(64)}`;
    const { journal, routes } = decorated({
      'POST /v1/catalog-items/:itemId/versions': async () =>
        jsonResponse({
          itemId: ITEM,
          itemVersion: 2,
          current: 2,
          catalogs: [
            { catalogId: CAT, revision: 4, digest: DIGEST },
            { catalogId: OTHER, revision: 7, digest: DIGEST },
          ],
          item: { name: 'secret name text with spaces', files: 'x' },
        }),
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(
      request({
        method: 'POST',
        path: `/v1/catalog-items/${ITEM}/versions`,
        headers: ADMIN,
        loopback: true,
        body: JSON.stringify({ digest: DIGEST }),
      }),
    );

    // Assert
    const logged = records(journal);
    should(logged.map(record => record.event)).deepEqual(['catalog.changed']);
    should(logged[0]?.subject).equal(ITEM);
    should(logged[0]?.detail).containEql({
      action: 'publish',
      itemId: ITEM,
      itemVersion: 2,
      catalogIds: `${CAT},${OTHER}`,
      revisions: '4,7',
    });
    should(JSON.stringify(logged)).not.match(/secret name|files/u);
  });

  it('should record making a version current and retiring one by ids only, telling retire from unretire', async () => {
    // Arrange
    const CAT = `cat_${'A'.repeat(22)}`;
    const ITEM = `itm_${'B'.repeat(22)}`;
    const answers: ReturnType<typeof jsonResponse>[] = [
      jsonResponse({
        itemId: ITEM,
        itemVersion: 1,
        current: 1,
        catalogs: [{ catalogId: CAT, revision: 5 }],
        item: { name: 'secret name text' },
      }),
      jsonResponse({
        itemId: ITEM,
        version: 2,
        retiredAt: '2026-01-01T00:00:00.000Z',
        changed: true,
        catalogs: [{ catalogId: CAT, revision: 6 }],
      }),
      jsonResponse({ itemId: ITEM, version: 2, changed: true, catalogs: [{ catalogId: CAT, revision: 7 }] }),
      jsonResponse('not an object'),
      jsonTextResponse('{not json'),
    ];
    const { journal, routes } = decorated({
      'PUT /v1/catalog-items/:itemId/current': async () => answers[0] as ReturnType<typeof jsonResponse>,
      'PATCH /v1/catalog-items/:itemId/versions/:version': async () =>
        answers.splice(1, 1)[0] as ReturnType<typeof jsonResponse>,
    });
    const api = await dispatcher(routes);
    const ask = async (method: string, path: string, body: unknown) =>
      await api.dispatch(request({ method, path, headers: ADMIN, loopback: true, body: JSON.stringify(body) }));

    // Act
    await ask('PUT', `/v1/catalog-items/${ITEM}/current`, { version: 1, from: 2 });
    await ask('PATCH', `/v1/catalog-items/${ITEM}/versions/2`, { retired: true });
    await ask('PATCH', `/v1/catalog-items/${ITEM}/versions/2`, { retired: false });
    await ask('PATCH', `/v1/catalog-items/${ITEM}/versions/2`, { retired: true });
    await ask('PATCH', `/v1/catalog-items/${ITEM}/versions/2`, { retired: true });

    // Assert
    const logged = records(journal);
    should(logged.map(record => record.event)).deepEqual(Array(5).fill('catalog.changed'));
    should(logged[0]?.detail).containEql({
      action: 'make-current',
      itemId: ITEM,
      itemVersion: 1,
      catalogIds: CAT,
      revisions: 5,
    });
    should(logged[1]?.detail).containEql({ action: 'retire', itemId: ITEM, itemVersion: 2, revisions: 6 });
    should(logged[2]?.detail).containEql({ action: 'unretire', itemId: ITEM, itemVersion: 2, revisions: 7 });
    should(logged[3]?.detail).containEql({ action: 'retire' });
    should(logged[4]?.detail).containEql({ action: 'retire' });
    should(logged[0]?.subject).equal(ITEM);
    should(JSON.stringify(logged)).not.match(/secret name/u);
  });

  it('should record nothing for a retire or an unretire that found the version already so', async () => {
    // Arrange
    const CAT = `cat_${'A'.repeat(22)}`;
    const ITEM = `itm_${'B'.repeat(22)}`;
    const answers = [
      jsonResponse({
        itemId: ITEM,
        version: 2,
        retiredAt: '2026-01-01T00:00:00.000Z',
        changed: false,
        catalogs: [{ catalogId: CAT, revision: 6 }],
      }),
      jsonResponse({ itemId: ITEM, version: 2, changed: false, catalogs: [{ catalogId: CAT, revision: 6 }] }),
    ];
    const { journal, routes } = decorated({
      'PATCH /v1/catalog-items/:itemId/versions/:version': async () =>
        answers.shift() as ReturnType<typeof jsonResponse>,
    });
    const api = await dispatcher(routes);
    const ask = async (retired: boolean) =>
      await api.dispatch(
        request({
          method: 'PATCH',
          path: `/v1/catalog-items/${ITEM}/versions/2`,
          headers: ADMIN,
          loopback: true,
          body: JSON.stringify({ retired }),
        }),
      );

    // Act
    await ask(true);
    await ask(false);

    // Assert
    should(records(journal)).have.length(0);
  });

  it('should keep the rule’s own action when a retire is refused, because nothing was done', async () => {
    // Arrange
    const ITEM = `itm_${'B'.repeat(22)}`;
    const { journal, routes } = decorated({
      'PATCH /v1/catalog-items/:itemId/versions/:version': async () =>
        jsonResponse({ code: 'version_current', message: 'refused' }, 409),
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(
      request({
        method: 'PATCH',
        path: `/v1/catalog-items/${ITEM}/versions/3`,
        headers: ADMIN,
        loopback: true,
        body: JSON.stringify({ retired: false }),
      }),
    );

    // Assert
    const logged = records(journal);
    should(logged).have.length(1);
    should(logged[0]?.detail).containEql({ action: 'retire' });
    should(logged[0]?.outcome).not.equal('succeeded');
  });

  it('should record a one-tap Add and its Undo by id, and nothing for an answer that changed nothing', async () => {
    // Arrange
    const CAT = `cat_${'A'.repeat(22)}`;
    const ITEM = `itm_${'B'.repeat(22)}`;
    const DIGEST = `sha256:${'c'.repeat(64)}`;
    const answers: unknown[] = [
      {
        outcome: 'added',
        catalog: { catalogId: CAT, name: 'secret name text with spaces', revision: 2, created: true },
        itemId: ITEM,
        itemVersion: 1,
        digest: DIGEST,
        undo: { token: `cqu_${'u'.repeat(22)}`, expiresAt: '2026-01-01T00:01:00.000Z' },
      },
      { outcome: 'already', catalogId: CAT, itemId: ITEM, itemVersion: 1 },
      { outcome: 'review', reasons: ['warnings'] },
    ];
    const { journal, routes } = decorated({
      'POST /v1/catalog-items/quick-add': async () => jsonResponse(answers.shift()),
      'POST /v1/catalog-items/quick-add/undo': async () =>
        jsonResponse({ catalogId: CAT, itemId: ITEM, mode: 'retracted', revision: 3, itemRemoved: true }),
    });
    const api = await dispatcher(routes);

    // Act
    for (const path of [
      '/v1/catalog-items/quick-add',
      '/v1/catalog-items/quick-add',
      '/v1/catalog-items/quick-add',
      '/v1/catalog-items/quick-add/undo',
    ])
      await api.dispatch(
        request({
          method: 'POST',
          path,
          headers: ADMIN,
          loopback: true,
          body: path.endsWith('/undo') ? JSON.stringify({ token: `cqu_${'u'.repeat(22)}` }) : '{}',
        }),
      );

    // Assert
    const logged = records(journal);
    should(logged).have.length(2);
    should(logged[0]?.detail).containEql({
      action: 'publish',
      catalogId: CAT,
      itemId: ITEM,
      itemVersion: 1,
      digest: DIGEST,
      revision: 2,
      created: true,
    });
    should(logged[1]?.detail).containEql({
      action: 'undo',
      catalogId: CAT,
      itemId: ITEM,
      revision: 3,
      mode: 'retracted',
    });
    should(JSON.stringify(logged)).not.match(/secret name|cqu_/u);
  });

  it('should still record a quick add whose success names no outcome, or has no readable answer', async () => {
    for (const answer of [() => jsonResponse(undefined), () => jsonResponse({ ok: true }), () => jsonResponse(null)]) {
      // Arrange
      const { journal, routes } = decorated({ 'POST /v1/catalog-items/quick-add': async () => answer() });
      const api = await dispatcher(routes);

      // Act
      await api.dispatch(
        request({ method: 'POST', path: '/v1/catalog-items/quick-add', headers: ADMIN, loopback: true, body: '{}' }),
      );

      // Assert
      should(records(journal)).have.length(1);
    }
  });

  it('should record a quick add that is refused, whatever the answer would have been', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'POST /v1/catalog-items/quick-add': async () => {
        throw new ApiError(409, 'refused', 'source_ambiguous');
      },
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(
      request({ method: 'POST', path: '/v1/catalog-items/quick-add', headers: ADMIN, loopback: true, body: '{}' }),
    );

    // Assert
    const logged = records(journal);
    should(logged).have.length(1);
    should(logged[0]?.outcome).equal('refused');
  });

  it('should record sharing and member changes by id, and never the code, the link or a label', async () => {
    // Arrange
    const SHARE = `shr_${'S'.repeat(22)}`;
    const MEMBER = `mbr_${'M'.repeat(22)}`;
    const KEY = `mk_${'K'.repeat(22)}`;
    const CAT = `cat_${'A'.repeat(22)}`;
    const CODE = `fy_share_${'z'.repeat(22)}`;
    const LINK = `https://app.example/join#v1;url=x;share=${CODE}`;
    const answers: Record<string, unknown> = {
      'POST /v1/catalog-shares': {
        share: {
          shareId: SHARE,
          memberId: MEMBER,
          memberLabel: 'Some Person With Spaces',
          catalogIds: [CAT],
          uses: { kind: 'single' },
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
        code: CODE,
        link: LINK,
      },
      'DELETE /v1/catalog-shares/:shareId': { shareId: SHARE },
      'DELETE /v1/catalog-members/:memberId': { memberId: MEMBER, keysRemoved: 2, sharesEnded: 1 },
      'DELETE /v1/catalog-members/:memberId/keys/:keyId': { memberId: MEMBER, keyId: KEY },
      'DELETE /v1/catalog-members/:memberId/catalogs/:catalogId': { memberId: MEMBER, catalogId: CAT },
    };
    const { journal, routes } = decorated(
      Object.fromEntries(Object.entries(answers).map(([key, body]) => [key, async () => jsonResponse(body)] as const)),
    );
    const api = await dispatcher(routes);

    // Act
    for (const [method, path] of [
      ['POST', '/v1/catalog-shares'],
      ['DELETE', `/v1/catalog-shares/${SHARE}`],
      ['DELETE', `/v1/catalog-members/${MEMBER}`],
      ['DELETE', `/v1/catalog-members/${MEMBER}/keys/${KEY}`],
      ['DELETE', `/v1/catalog-members/${MEMBER}/catalogs/${CAT}`],
    ] as const)
      await api.dispatch(request({ method, path, headers: ADMIN, loopback: true, body: '{}' }));

    // Assert
    const logged = records(journal);
    should(logged.map(record => record.event)).deepEqual([
      'catalog.share.minted',
      'catalog.share.ended',
      'catalog.member.revoked',
      'catalog.member.key-removed',
      'catalog.member.catalog-removed',
    ]);
    should(logged[0]?.detail).containEql({
      shareId: SHARE,
      memberId: MEMBER,
      catalogIds: CAT,
      uses: 'single',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    should(logged[1]?.subject).equal(SHARE);
    should(logged[2]?.subject).equal(MEMBER);
    should(logged[2]?.detail).containEql({ keysRemoved: 2, sharesEnded: 1 });
    should(logged[3]?.detail).containEql({ keyId: KEY });
    should(logged[4]?.detail).containEql({ catalogId: CAT });
    should(JSON.stringify(logged) + journal.lines.join('\n')).not.match(/fy_share_|Some Person|app\.example|share=/u);
  });

  it('should record which KIND of configuration file a Settings confirmation put into effect, never its name or path', async () => {
    // Arrange
    const confirmed: Record<string, unknown> = {
      'warden.yaml': { path: 'warden.yaml', confirmed: true },
      'logins/my-private-login.yaml': { path: 'logins/my-private-login.yaml', confirmed: true },
      'components/skills/secret-skill.yaml': { path: 'components/skills/secret-skill.yaml', confirmed: true },
    };
    const paths = Object.keys(confirmed);
    let next = 0;
    const { journal, routes } = decorated({
      'POST /v1/config/confirm': async () => jsonResponse(confirmed[paths[next++] as string]),
    });
    const api = await dispatcher(routes);

    // Act
    for (const _ of paths)
      await api.dispatch(
        request({ method: 'POST', path: '/v1/config/confirm', headers: ADMIN, loopback: true, body: '{}' }),
      );

    // Assert
    const logged = records(journal);
    should(logged.map(record => record.detail)).deepEqual([
      { action: 'config-confirm', kind: 'warden', status: 200 },
      { action: 'config-confirm', kind: 'login', status: 200 },
      { action: 'config-confirm', kind: 'component', status: 200 },
    ]);
    should(JSON.stringify(logged) + journal.lines.join('\n')).not.match(/my-private-login|secret-skill|logins\//u);
  });

  it('should record a Settings confirmation with no kind when the answer is not JSON or names no known file', async () => {
    // Arrange
    const answers: readonly ApiRoute['handle'][] = [
      async () => ({ status: 200, headers: new Map<string, string>(), body: 'plainly not json' }),
      async () => jsonResponse({ path: 'not-a-known-file.yaml', confirmed: true }),
      async () => jsonResponse({ confirmed: true }),
    ];

    for (const answer of answers) {
      const { journal, routes } = decorated({ 'POST /v1/config/confirm': answer });
      const api = await dispatcher(routes);

      // Act
      await api.dispatch(
        request({ method: 'POST', path: '/v1/config/confirm', headers: ADMIN, loopback: true, body: '{}' }),
      );

      // Assert
      should(records(journal).map(record => record.detail)).deepEqual([{ action: 'config-confirm', status: 200 }]);
    }
  });

  it('should record a refused Settings confirmation with no kind, since the refusal names no file', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'POST /v1/config/confirm': async () => jsonResponse({ error: 'no', code: 'forbidden' }, 403),
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(
      request({ method: 'POST', path: '/v1/config/confirm', headers: ADMIN, loopback: true, body: '{}' }),
    );

    // Assert
    const logged = records(journal);
    should(logged.map(record => [record.outcome, record.detail])).deepEqual([
      ['refused', { action: 'config-confirm', status: 403 }],
    ]);
  });

  it('should record a catalog change with no ids when the answer is not JSON', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'POST /v1/catalogs': async () => ({ status: 200, headers: new Map<string, string>(), body: 'plainly not json' }),
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(request({ method: 'POST', path: '/v1/catalogs', headers: ADMIN, loopback: true, body: '{}' }));

    // Assert
    const logged = records(journal);
    should(logged.map(record => record.event)).deepEqual(['catalog.changed']);
    should(logged[0]?.detail).not.have.property('catalogId');
  });

  it('should audit answering a harness dialog as terminal input on the session, never with the choice', async () => {
    // Arrange
    const { journal, routes } = decorated({});
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s-1/dialog',
        headers: ADMIN,
        loopback: true,
        body: JSON.stringify({ kind: 'choice', dialogId: '0123456789abcdef', number: 2 }),
      }),
    );

    // Assert
    should(records(journal)).deepEqual([
      {
        at: AT,
        event: 'terminal.input',
        actor: { kind: 'host' },
        subject: 's-1',
        outcome: 'succeeded',
        detail: { mode: 'dialog', status: 200 },
      },
    ]);
  });

  it('should audit a proxy test by name with its outcome class, never the proxy, a credential or an address', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'POST /v1/browser/proxy/test': async () =>
        jsonResponse({
          reachable: false,
          tested: 'unsaved',
          errorClass: 'auth',
          message: 'The proxy refused the username and password.',
          egressIp: '203.0.113.7',
          roundTripMs: 12,
        }),
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(
      request({
        method: 'POST',
        path: '/v1/browser/proxy/test',
        headers: ADMIN,
        loopback: true,
        body: JSON.stringify({ proxy: { url: 'http://user:pw@proxy.example:8080', bypass: [] } }),
      }),
    );

    // Assert
    const [record] = records(journal);
    should(record).containEql({ event: 'browser.proxy-tested', subject: 'browser-proxy', outcome: 'succeeded' });
    should(JSON.stringify(record)).not.match(/proxy\.example|user:pw|203\.0\.113\.7|username and password/u);
    should((record as { detail: Record<string, unknown> }).detail).containEql({ errorClass: 'auth', roundTripMs: 12 });
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
    const refused = await api.dispatch(
      request({ method: 'PATCH', path: '/v1/grants', headers: ADMIN, loopback: true, body: '{}' }),
    );
    const failed = await api.dispatch(
      request({ method: 'POST', path: '/v1/fleet/login', headers: ADMIN, loopback: true }),
    );
    await api.dispatch(
      request({ method: 'POST', path: '/v1/fleet/machine/tools/install', headers: ADMIN, loopback: true }),
    );

    // Assert
    should(refused.status).equal(403);
    should(failed.status).equal(500);
    // The second fleet failure is a REPEAT of the first by the same actor, so it is counted, not written.
    should(records(journal).map(record => [record.event, record.outcome, record.detail])).deepEqual([
      ['grants.changed', 'refused', { status: 403 }],
      ['fleet.configured', 'failed', { action: 'sign-in' }],
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
        request({
          method: 'POST',
          path: '/v1/secrets/use',
          headers: ADMIN,
          loopback: true,
          body: '{"command":["echo","hunter2"]}',
        }),
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
    // A use that named nothing reads the same both times, so the second is folded into the first.
    should(written[1]?.detail).deepEqual({ status: 200 });
    should(written).have.length(3);
    const joined = String(written[2]?.detail?.used);
    should(joined.length <= 160).be.true();
    should(joined).match(/^SECRET_NUMBER_0,.*,\+\d+$/u);
    should(journal.lines.join('\n')).not.containEql('hunter2');
  });

  it('should never turn a request that worked into a fault when the record throws', async () => {
    // Arrange: a sink that is not an AuditLog, and a device-name lookup that throws.
    const failures: string[] = [];
    const base: ApiRoute[] = [
      {
        method: 'PATCH',
        path: '/v1/grants',
        minimum: 'operator',
        caller: 'any',
        handle: async () => jsonResponse({ ok: true }),
      },
      {
        method: 'DELETE',
        path: '/v1/pair/devices/:deviceId',
        minimum: 'operator',
        caller: 'any' as const,
        handle: async () => jsonResponse({ ok: true }),
      },
    ];
    const routes = auditedRoutes(
      {
        log: {
          record: async () => {
            throw new Error('disk full');
          },
        },
        deviceName: async () => {
          throw 'gone';
        },
        failures: { auditWriteFailed: message => failures.push(message) },
      },
      base,
    );
    const api = await dispatcher(routes);

    // Act
    const changed = await api.dispatch(
      request({ method: 'PATCH', path: '/v1/grants', headers: ADMIN, loopback: true, body: '{}' }),
    );
    const revoked = await api.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${OTHER_DEVICE_ID}`, device: DEVICE }),
    );

    // Assert
    should([changed.status, revoked.status]).deepEqual([200, 200]);
    should(failures).deepEqual([
      'the security log could not record a grants.changed event, so it has a gap: disk full',
      'the security log could not record a device.revoked event, so it has a gap: gone',
    ]);
  });

  it('should take a single name for a stored secret, and a fixed subject for a setting', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'POST /v1/secrets': async () => jsonResponse({ name: 'API_KEY' }),
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(
      request({ method: 'POST', path: '/v1/secrets', headers: ADMIN, loopback: true, body: '{"value":"hunter2"}' }),
    );
    await api.dispatch(request({ method: 'PATCH', path: '/v1/security', headers: ADMIN, loopback: true, body: '{}' }));
    await api.dispatch(request({ method: 'DELETE', path: '/v1/secrets/API_KEY', headers: ADMIN, loopback: true }));

    // Assert
    should(records(journal).map(record => [record.event, record.subject, record.detail])).deepEqual([
      ['secrets.changed', undefined, { action: 'put', name: 'API_KEY', status: 200 }],
      ['security.changed', 'security-settings', { status: 200 }],
      ['secrets.changed', 'API_KEY', { action: 'delete', status: 200 }],
    ]);
    should(journal.lines.join('\n')).not.containEql('hunter2');
  });

  it('should record a 2FA seed save by account and key id, with its proof and whether it was a mismatch, never a value', async () => {
    // Arrange
    const stage = `st_${'a'.repeat(24)}`;
    const { journal, routes } = decorated({
      'POST /v1/accounts/:id/factors/seed/:stage/commit': async () =>
        jsonResponse({
          account: 'GITHUB',
          factor: { id: 'tf_0123456789ab', kind: 'totp', label: 'Authenticator app', automatic: true },
          mismatch: true,
        }),
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(
      request({
        method: 'POST',
        path: `/v1/accounts/GITHUB/factors/seed/${stage}/commit`,
        headers: ADMIN,
        loopback: true,
      }),
    );

    // Assert
    should(records(journal).map(record => [record.event, record.subject, record.detail])).deepEqual([
      [
        'secrets.changed',
        'GITHUB',
        { action: 'factor-added', proof: 'passkey', mismatch: true, factor: 'tf_0123456789ab', status: 200 },
      ],
    ]);
  });

  it('should say what the security settings are after a change, in numbers and booleans only', async () => {
    // Arrange
    let body: unknown = {
      view: {
        settings: { idleExpiryDays: 1, unlockOnOpen: true, note: 'typed text', 'Bad-Key': 3, nested: { a: 1 } },
      },
      devicesExpiring: 4,
    };
    let raw: string | undefined;
    const { journal, routes } = decorated({
      'PATCH /v1/security': async () =>
        raw === undefined ? jsonResponse(body) : { status: 200, headers: new Map(), body: raw },
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(request({ method: 'PATCH', path: '/v1/security', device: DEVICE, body: '{}' }));
    body = { view: { settings: 'not an object' } };
    await api.dispatch(request({ method: 'PATCH', path: '/v1/security', headers: ADMIN, loopback: true, body: '{}' }));
    raw = 'not json';
    await api.dispatch(request({ method: 'PATCH', path: '/v1/security', device: DEVICE, body: '{}' }));

    // Assert
    should(records(journal).map(record => record.detail)).deepEqual([
      { idleExpiryDays: 1, unlockOnOpen: true, status: 200 },
      { status: 200 },
      { status: 200 },
    ]);
  });

  it('should record a refused step-up or unlock as a failed step-up, and a passed one as passed', async () => {
    // Arrange
    let status = 200;
    const answer: ApiRoute['handle'] = async () => ({ ...jsonResponse({}), status });
    const { journal, routes } = decorated({ 'POST /v1/step-up': answer, 'POST /v1/unlock': answer });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(request({ method: 'POST', path: '/v1/unlock', device: DEVICE }));
    status = 403;
    await api.dispatch(request({ method: 'POST', path: '/v1/step-up', device: DEVICE }));

    // Assert
    should(records(journal).map(record => [record.event, record.outcome, record.detail?.action])).deepEqual([
      ['step-up.succeeded', 'succeeded', 'unlock'],
      ['step-up.failed', 'refused', 'step-up'],
    ]);
  });

  it('should keep a non-JSON body out of the names', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'POST /v1/secrets/use': async () => ({ status: 200, headers: new Map(), body: 'not json' }),
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(request({ method: 'POST', path: '/v1/secrets/use', headers: ADMIN, loopback: true }));

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
    const api = await dispatcher(
      auditRoutes({
        recent: async (limit, offset) => await journal.recent(limit, offset),
        flush: async () => undefined,
      }),
    );

    // Act
    const page = await api.dispatch(
      request({ path: '/v1/audit', query: [['limit', '2']], headers: ADMIN, loopback: true }),
    );
    const fallback = await api.dispatch(request({ path: '/v1/audit', headers: ADMIN, loopback: true }));
    const tooMany = await api.dispatch(
      request({ path: '/v1/audit', query: [['limit', '201']], headers: ADMIN, loopback: true }),
    );
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

  it('should always serve the kept records apart, however much activity is newer, and page back through them', async () => {
    // Arrange: a device pairs, then floods two hundred cheap general successes with distinct subjects.
    const { journal, log } = auditLog();
    const device = { kind: 'device', deviceId: DEVICE_ID } as const;
    await log.record({ event: 'device.paired', actor: device, subject: DEVICE_ID, outcome: 'succeeded' });
    for (let index = 0; index < 3; index += 1)
      await log.record({
        event: 'grants.changed',
        actor: { kind: 'host' },
        subject: `g${String(index)}`,
        outcome: 'succeeded',
      });
    for (let index = 0; index < 300; index += 1)
      await log.record({
        event: 'pairing.code-minted',
        actor: device,
        subject: `p${String(index)}`,
        outcome: 'succeeded',
      });
    const api = await dispatcher(
      auditRoutes({ recent: async (limit, offset) => await log.recent(limit, offset), flush: async () => undefined }),
    );

    // Act
    const first = jsonBody(
      await api.dispatch(request({ path: '/v1/audit', query: [['limit', '200']], headers: ADMIN, loopback: true })),
    ) as { records: AuditRecord[]; kept: AuditRecord[]; keptTotal: number };
    const paged = jsonBody(
      await api.dispatch(
        request({
          path: '/v1/audit',
          query: [
            ['limit', '2'],
            ['keptOffset', '2'],
          ],
          headers: ADMIN,
          loopback: true,
        }),
      ),
    ) as { kept: AuditRecord[]; keptTotal: number };

    // Assert
    should(journal.lines.length).equal(304);
    should(first.records).have.length(200);
    should(first.records.some(record => record.event === 'device.paired')).be.false();
    should(first.kept.map(record => record.subject)).deepEqual(['g2', 'g1', 'g0', DEVICE_ID]);
    should(first.keptTotal).equal(4);
    should(paged.kept.map(record => record.subject)).deepEqual(['g0', DEVICE_ID]);
  });

  it('should be refused when the operator switched pairing off for remote devices', async () => {
    // Arrange
    const grants = grantSubsystem({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: false, configure: false } },
    });
    await grants.refresh();
    const api = new ApiDispatcher(
      new ApiRouter(
        auditRoutes({
          recent: async () => ({ records: [], kept: [], keptTotal: 0, unreadable: 0 }),
          flush: async () => undefined,
        }),
      ),
      CREDENTIALS,
      grants,
    );

    // Act
    const response = await api.dispatch(request({ path: '/v1/audit', device: DEVICE }));

    // Assert
    should(response.status).equal(403);
  });

  it('should refuse a device trusted only to USE pairing, and still serve the host', async () => {
    // Arrange
    const grants = grantSubsystem({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: true, configure: false } },
    });
    await grants.refresh();
    const api = new ApiDispatcher(
      new ApiRouter(
        auditRoutes({
          recent: async () => ({ records: [], kept: [], keptTotal: 0, unreadable: 0 }),
          flush: async () => undefined,
        }),
      ),
      CREDENTIALS,
      grants,
    );

    // Act
    const device = await api.dispatch(request({ path: '/v1/audit', device: DEVICE }));
    const host = await api.dispatch(request({ path: '/v1/audit', headers: ADMIN, loopback: true }));

    // Assert
    should(device.status).equal(403);
    should(host.status).equal(200);
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
  async remove(id: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter(record => record.id !== id);
    return this.records.length < before;
  }
  async touch(): Promise<void> {}
  async rotateKey(id: string): Promise<boolean> {
    return this.records.some(record => record.id === id);
  }
  async setGrants(): Promise<boolean> {
    return false;
  }
}

class Cryptography implements PairingCryptography {
  pairingCode = (): string => CODE;
  pairingId = (): string => `fy_pair_${'p'.repeat(22)}`;
  deviceId = (): string => DEVICE_ID;
}

function pairing(
  options: {
    readonly addFails?: boolean;
    readonly alert?: (device: PairedDeviceNotice) => Promise<void>;
    readonly log?: AuditLog;
  } = {},
) {
  const made = auditLog();
  const log = options.log ?? made.log;
  const alerts: PairedDeviceNotice[] = [];
  const failures: string[] = [];
  let nowMs = Date.parse(AT);
  const devices = new Devices();
  if (options.addFails === true)
    devices.add = async () => {
      throw new Error('disk');
    };
  const cryptography = new Cryptography();
  let minted = 0;
  cryptography.deviceId = () => `fy_device_id_${String(minted++).padStart(22, 'd')}`;
  const service = new AuditedPairingService(
    {
      daemonId: DAEMON_ID,
      daemonName: 'workstation',
      advertisement: { kind: 'address', url: 'https://workstation.example.test', origin: 'operator' },
      carriers: { current: () => [] },
      clock: { now: () => nowMs },
      cryptography,
      devices,
      credentials: new PairingDeviceRegistry(DAEMON_ID),
    },
    {
      log,
      alert: { newDevicePaired: options.alert ?? (async device => void alerts.push(device)) },
      failures: { auditWriteFailed: message => failures.push(message) },
    },
  );
  return { journal: made.journal, alerts, failures, service, devices, tick: (ms: number) => (nowMs += ms) };
}

const FIRST_DEVICE = `fy_device_id_${'0'.padStart(22, 'd')}`;

interface Attempt {
  readonly code: string;
  readonly deviceName?: string;
}

/** A redemption on this daemon's own listener, with a proven key, as the session layer presents one. */
function direct(service: AuditedPairingService, attempt: Attempt, peer: string) {
  return service.redeemInSession(
    { code: attempt.code, deviceName: attempt.deviceName ?? '', deviceKey: DEVICE_KEY, prove: async () => true },
    { kind: 'direct', rateLimitKey: peer },
  );
}

/** The same redemption arriving over a rendezvous. */
function relayed(service: AuditedPairingService, attempt: Attempt) {
  return service.redeemInSession(
    { code: attempt.code, deviceName: attempt.deviceName ?? '', deviceKey: DEVICE_KEY, prove: async () => true },
    { kind: 'relay' },
  );
}

describe('AuditedPairingService', () => {
  it('should record a replaced key and an idle expiry, the two changes no route makes', async () => {
    // Arrange
    const { journal, service, tick } = pairing();
    service.mint();
    await direct(service, { code: CODE, deviceName: 'Pixel 8' }, 'peer');

    // Act
    const rotated = await service.rotateDeviceKey(FIRST_DEVICE, DEVICE_KEY);
    const unknown = await service.rotateDeviceKey('fy_device_id_nobody', DEVICE_KEY);
    const none = await service.expireIdleDevices();
    tick(400 * 86_400_000);
    const expired = await service.expireIdleDevices();

    // Assert
    should([rotated, unknown, none, expired]).deepEqual([true, false, 0, 1]);
    should(records(journal).map(record => [record.event, record.actor.kind, record.subject])).deepEqual([
      ['device.paired', 'device', FIRST_DEVICE],
      ['device.key-rotated', 'device', FIRST_DEVICE],
      ['device.expired', 'host', FIRST_DEVICE],
    ]);
    should(journal.stores).deepEqual(['kept', 'kept', 'kept']);
  });

  it('should record a direct pairing by id and name, and alert the others', async () => {
    // Arrange
    const { journal, alerts, service } = pairing();
    service.mint();

    // Act
    const result = await direct(service, { code: CODE, deviceName: 'Pixel 8' }, 'peer');

    // Assert
    should(result.kind).equal('paired');
    should(records(journal)).deepEqual([
      {
        at: AT,
        event: 'device.paired',
        actor: { kind: 'device', deviceId: FIRST_DEVICE, deviceName: 'Pixel 8' },
        subject: FIRST_DEVICE,
        outcome: 'succeeded',
        detail: { carrier: 'direct' },
      },
    ]);
    should(journal.stores).deepEqual(['kept']);
    should(alerts).deepEqual([{ deviceId: FIRST_DEVICE, deviceName: 'Pixel 8', carrier: 'direct', createdAt: AT }]);
    // NAMES AND IDS ONLY: neither the code nor the issued credential reached the log.
    should(journal.lines.join('\n')).not.containEql(CODE).and.not.containEql(DEVICE_KEY);
  });

  it('should record a relayed pairing as relayed', async () => {
    // Arrange
    const { journal, alerts, service } = pairing();
    service.mint();

    // Act
    await relayed(service, { code: CODE, deviceName: 'Phone' });

    // Assert
    should(records(journal)[0]?.detail).deepEqual({ carrier: 'relay' });
    should(alerts[0]?.carrier).equal('relay');
  });

  it('should name each device of two concurrent redemptions by its own grant', async () => {
    // Arrange: the code is single-use, so two grants need two codes; what matters is that each record
    // names the device ITS redemption created, which a before/after list diff cannot promise.
    const { journal, service } = pairing();
    service.mint();
    const first = direct(service, { code: CODE, deviceName: 'Pixel 8' }, 'peer');
    const losing = relayed(service, { code: CODE, deviceName: 'Tablet' });

    // Act
    const results = await Promise.all([first, losing]);
    service.mint();
    await relayed(service, { code: CODE, deviceName: 'Tablet' });

    // Assert
    should(results.map(result => result.kind)).deepEqual(['paired', 'refused']);
    should(
      records(journal)
        .filter(record => record.event === 'device.paired')
        .map(record => [record.subject, record.actor.deviceName, record.detail?.carrier]),
    ).deepEqual([
      [FIRST_DEVICE, 'Pixel 8', 'direct'],
      [`fy_device_id_${'1'.padStart(22, 'd')}`, 'Tablet', 'relay'],
    ]);
  });

  it('should fold a burst of refusals per carrier, through the log', async () => {
    // Arrange
    const { journal, alerts, service } = pairing();

    // Act
    await direct(service, { code: 'WRONG' }, 'peer');
    await direct(service, { code: 'WRONG' }, 'peer');
    await direct(service, { code: 'WRONG' }, 'peer');
    await relayed(service, { code: 'WRONG', deviceName: 'x' });

    // Assert
    should(records(journal).map(record => [record.event, record.actor.kind, record.detail])).deepEqual([
      ['pairing.refused', 'anonymous', { carrier: 'direct' }],
      ['pairing.refused', 'anonymous', { carrier: 'relay' }],
    ]);
    should(journal.stores).deepEqual(['general', 'general']);
    should(alerts).deepEqual([]);
    should(journal.lines.join('\n')).not.containEql('WRONG');
  });

  it('should refuse a device name that would read as a fixed actor, without spending the code', async () => {
    // Arrange
    const { journal, alerts, service, devices } = pairing();
    service.mint();

    // Act
    const directResult = await direct(service, { code: CODE, deviceName: 'This  Computer' }, 'peer');
    const relayedResult = await relayed(service, { code: CODE, deviceName: 'a supervising agent' });
    const honest = await direct(service, { code: CODE, deviceName: 'Pixel 8' }, 'peer');

    // Assert
    should([directResult.kind, relayedResult.kind, honest.kind]).deepEqual(['refused', 'refused', 'paired']);
    should(devices.records.map(record => record.name)).deepEqual(['Pixel 8']);
    should(alerts.map(alert => alert.deviceName)).deepEqual(['Pixel 8']);
    should(records(journal).map(record => record.event)).deepEqual([
      'pairing.refused',
      'pairing.refused',
      'device.paired',
    ]);
  });

  it('should still spend a guess when a wrong code carries a reserved name', async () => {
    // Arrange
    const { service } = pairing();
    service.mint();

    // Act: five wrong guesses expire the code, whatever name they carry.
    for (let index = 0; index < 5; index += 1)
      await direct(service, { code: 'AAAA-AAAA', deviceName: 'this computer' }, 'peer');
    const late = await direct(service, { code: CODE, deviceName: 'Pixel 8' }, 'peer');

    // Assert
    should(late.kind).equal('refused');
  });

  it('should pair the device even when the log and the alert both fail', async () => {
    // Arrange: a sink that is not an AuditLog and throws, and an alert that rejects.
    const throwing = {
      record: async () => {
        throw new Error('disk full');
      },
      recent: async () => ({ records: [], kept: [], keptTotal: 0, unreadable: 0 }),
      flush: async () => undefined,
    } as unknown as AuditLog;
    const { service, failures, devices } = pairing({
      log: throwing,
      alert: async () => {
        throw new Error('push down');
      },
    });
    service.mint();

    // Act
    const result = await direct(service, { code: CODE, deviceName: 'Pixel 8' }, 'peer');

    // Assert
    should(result.kind).equal('paired');
    should(devices.records).have.length(1);
    should(failures).deepEqual([]);
  });

  it('should answer the device before the alert has been delivered', async () => {
    // Arrange: an alert that never settles stands in for a push service that hangs.
    let started = false;
    const { service } = pairing({
      alert: async () => {
        started = true;
        await new Promise<void>(() => undefined);
      },
    });
    service.mint();

    // Act
    const result = await direct(service, { code: CODE, deviceName: 'Pixel 8' }, 'peer');

    // Assert
    should(result.kind).equal('paired');
    should(started).be.true();
  });

  it('should report a rejected alert to the operator, not to the device', async () => {
    // Arrange
    const { service, failures } = pairing({
      alert: async () => {
        throw 'push down';
      },
    });
    service.mint();

    // Act
    const result = await direct(service, { code: CODE, deviceName: 'Pixel 8' }, 'peer');
    await Bun.sleep(0);

    // Assert
    should(result.kind).equal('paired');
    should(failures).deepEqual([`the other devices could not be told that a device was paired: push down`]);
  });

  it('should record a redemption the store refused as a refusal', async () => {
    // Arrange
    const { journal, alerts, service } = pairing({ addFails: true });
    service.mint();

    // Act
    await direct(service, { code: CODE, deviceName: 'Pixel 8' }, 'peer');

    // Assert
    should(records(journal).map(record => record.event)).deepEqual(['pairing.refused']);
    should(alerts).deepEqual([]);
  });
});

class FakeDownstream implements SocketDownstream {
  send(): number {
    return 1;
  }
  close(): void {}
  bufferedBytes(): number {
    return 0;
  }
}

function socketTable(accept: SocketRoute['accept']) {
  const { journal, log, failures } = auditLog();
  const received: SocketFrame[] = [];
  const routes = AUDITED_SOCKET_ROUTES.map(
    (rule): SocketRoute => ({
      method: 'GET',
      path: rule.path,
      minimum: 'operator',
      caller: 'any',
      accept,
    }),
  );
  const fleetFeed: SocketRoute = {
    method: 'GET',
    path: '/v1/fleet/events',
    minimum: 'operator',
    caller: 'any',
    accept,
  };
  const wrapped = auditedSocketRoutes(
    {
      log,
      deviceName: async id => (id === DEVICE_ID ? 'Pixel 8' : undefined),
      failures: { auditWriteFailed: message => failures.push(message) },
    },
    [...routes, fleetFeed],
  );
  return { journal, failures, received, wrapped, fleetFeed };
}

function socketContext(params: Record<string, string>, device = true) {
  return {
    request: request({ path: '/x' }),
    params: new Map(Object.entries(params)),
    ...(device
      ? { credential: { kind: 'authenticated' as const, tokenClass: 'device' as const, deviceId: DEVICE_ID } }
      : {}),
  };
}

describe('auditedSocketRoutes', () => {
  it('should record an attach and count binary input per terminal, never its bytes', async () => {
    // Arrange
    const received: SocketFrame[] = [];
    let closed = 0;
    let opened = 0;
    const table = socketTable(async () => async () => ({
      open: async () => {
        opened += 1;
      },
      fromClient: frame => void received.push(frame),
      close: () => {
        closed += 1;
      },
    }));
    const terminal = table.wrapped[0];

    // Act
    const attach = await terminal?.accept(socketContext({ sessionId: 's-1', terminalId: 'term-1' }));
    const handler = await attach?.(new FakeDownstream());
    await handler?.open();
    handler?.fromClient(new TextEncoder().encode('rm -rf secret-keystrokes'));
    handler?.fromClient(new TextEncoder().encode('ls'));
    handler?.fromClient('{"type":"resize"}');
    handler?.close();
    await Bun.sleep(0);

    // Assert
    should([opened, closed, received.length]).deepEqual([1, 1, 3]);
    should(
      records(table.journal).map(record => [record.event, record.subject, record.actor.deviceName, record.detail]),
    ).deepEqual([
      ['terminal.opened', 'term-1', 'Pixel 8', { mode: 'attach' }],
      ['terminal.input', 'term-1', 'Pixel 8', undefined],
    ]);
    should(table.journal.lines.join('\n')).not.containEql('secret-keystrokes');
  });

  it('should record a refused attach as refused and still refuse it', async () => {
    // Arrange
    const table = socketTable(async () => {
      throw new ApiError(403, 'no', 'grant_forbidden');
    });

    // Act
    const refused = table.wrapped[1]?.accept(socketContext({ sessionId: 's-1' }, false));

    // Assert
    await should(refused).be.rejectedWith({ status: 403 });
    should(
      records(table.journal).map(record => [record.event, record.subject, record.outcome, record.actor]),
    ).deepEqual([['browser.opened', 's-1', 'refused', { kind: 'anonymous' }]]);
  });

  it('should pass a browser attach through without wrapping its frames, and leave the fleet feed alone', async () => {
    // Arrange
    const attach = async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined });
    const table = socketTable(async () => attach);

    // Act
    const browser = await table.wrapped[1]?.accept(socketContext({ sessionId: 's-1' }));

    // Assert
    should(browser).equal(attach);
    should(table.wrapped[2]).equal(table.fleetFeed);
    should(records(table.journal).map(record => record.event)).deepEqual(['browser.opened']);
  });

  it('should report a record that throws rather than fail the attach', async () => {
    // Arrange
    const failures: string[] = [];
    const attach = async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined });
    const [route] = auditedSocketRoutes(
      {
        log: {
          record: async () => {
            throw new Error('disk full');
          },
        },
        deviceName: async () => undefined,
        failures: { auditWriteFailed: message => failures.push(message) },
      },
      [
        {
          method: 'GET',
          path: AUDITED_SOCKET_ROUTES[0]?.path ?? '',
          minimum: 'operator',
          caller: 'any',
          accept: async () => attach,
        },
      ],
    );

    // Act
    const handler = await (
      await route?.accept(socketContext({ sessionId: 's', terminalId: 't' }))
    )?.(new FakeDownstream());
    handler?.fromClient(new Uint8Array([1]));
    await Bun.sleep(0);

    // Assert
    should(handler).not.be.undefined();
    should(failures).deepEqual([
      'the security log could not record a terminal.opened event, so it has a gap: disk full',
      'the security log could not record a terminal.input event, so it has a gap: disk full',
    ]);
  });
});

describe('auditing an install from a catalog', () => {
  const INSTALL_ID = `cin_${'i'.repeat(22)}`;
  const send = async (api: ApiDispatcher, method: string, path: string) =>
    await api.dispatch(request({ method, path, headers: ADMIN, loopback: true }));

  for (const scope of ['project', 'runtime'] as const) {
    it(`should record an install on the ${scope} route by the item's NAME, never a file, command or secret`, async () => {
      // Arrange
      const { journal, routes } = decorated({
        [`POST /v1/catalog-installs/${scope}`]: async () =>
          jsonResponse({
            install: { provenance: { name: 'pdf-tools' }, secretBindings: { ACME_TOKEN: 'MY_KEY' } },
            notes: ['set ACME_TOKEN'],
          }),
      });
      const api = await dispatcher(routes);

      // Act
      await send(api, 'POST', `/v1/catalog-installs/${scope}`);

      // Assert
      should(records(journal)).deepEqual([
        {
          at: AT,
          event: 'fleet.configured',
          actor: { kind: 'host' },
          outcome: 'succeeded',
          detail: { action: 'catalog-install', scope, name: 'pdf-tools', status: 200 },
        },
      ]);
      should(journal.lines.join('\n')).not.match(/MY_KEY|ACME_TOKEN/u);
    });

    it(`should record a removal on the ${scope} route against the install id, with the item's name`, async () => {
      // Arrange
      const { journal, routes } = decorated({
        [`DELETE /v1/catalog-installs/${scope}/:installId`]: async () =>
          jsonResponse({ installId: INSTALL_ID, provenance: { name: 'pdf-tools' }, destination: '/srv/app' }),
      });
      const api = await dispatcher(routes);

      // Act
      await send(api, 'DELETE', `/v1/catalog-installs/${scope}/${INSTALL_ID}`);

      // Assert
      should(records(journal)).deepEqual([
        {
          at: AT,
          event: 'fleet.configured',
          actor: { kind: 'host' },
          subject: INSTALL_ID,
          outcome: 'succeeded',
          detail: { action: 'catalog-remove', scope, name: 'pdf-tools', status: 200 },
        },
      ]);
    });
  }

  it('should say WHY a refusal was one, because a changed publisher and an edited file mean different things', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'POST /v1/catalog-installs/project': async () => {
        throw new ApiError(409, 'a different machine', 'catalog_publisher_changed');
      },
    });
    const api = await dispatcher(routes);

    // Act
    const answer = await send(api, 'POST', '/v1/catalog-installs/project');

    // Assert
    should(answer.status).equal(409);
    should(records(journal).map(record => [record.outcome, record.detail])).deepEqual([
      ['refused', { action: 'catalog-install', scope: 'project', code: 'catalog_publisher_changed', status: 409 }],
    ]);
  });

  it('should carry the code of a refused removal too, and no name for it', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'DELETE /v1/catalog-installs/runtime/:installId': async () => {
        throw new ApiError(404, 'no such install', 'catalog_install_unknown');
      },
    });
    const api = await dispatcher(routes);

    // Act
    await send(api, 'DELETE', `/v1/catalog-installs/runtime/${INSTALL_ID}`);

    // Assert
    should(records(journal).map(record => record.detail)).deepEqual([
      { action: 'catalog-remove', scope: 'runtime', code: 'catalog_install_unknown', status: 404 },
    ]);
  });

  it('should leave the code out when the failure was not an ApiError, or an ApiError that had none', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'POST /v1/catalog-installs/project': async () => {
        throw new Error('disk on fire');
      },
      'POST /v1/catalog-installs/runtime': async () => {
        throw new ApiError(409, 'no code');
      },
    });
    const api = await dispatcher(routes);

    // Act
    await send(api, 'POST', '/v1/catalog-installs/project');
    await send(api, 'POST', '/v1/catalog-installs/runtime');

    // Assert
    should(records(journal).map(record => [record.outcome, record.detail])).deepEqual([
      ['failed', { action: 'catalog-install', scope: 'project' }],
      ['refused', { action: 'catalog-install', scope: 'runtime', status: 409 }],
    ]);
  });

  it('should not copy a code onto a rule that did not ask for it', async () => {
    // Arrange
    const { journal, routes } = decorated({
      'PATCH /v1/grants': async () => {
        throw new ApiError(403, 'no', 'grant_forbidden');
      },
    });
    const api = await dispatcher(routes);

    // Act
    await api.dispatch(request({ method: 'PATCH', path: '/v1/grants', headers: ADMIN, loopback: true, body: '{}' }));

    // Assert
    should(records(journal).map(record => record.detail)).deepEqual([{ status: 403 }]);
  });

  for (const [label, answer] of [
    ['a null link on the way', { install: null }],
    ['a name that is not text', { install: { provenance: { name: 7 } } }],
    ['a body that is not an object', 'just text'],
  ] as const) {
    it(`should name nothing when the answer is not shaped as the dotted path says: ${label}`, async () => {
      // Arrange
      const { journal, routes } = decorated({
        'POST /v1/catalog-installs/project': async () => jsonResponse(answer),
      });
      const api = await dispatcher(routes);

      // Act
      await send(api, 'POST', '/v1/catalog-installs/project');

      // Assert
      should(records(journal).map(record => record.detail)).deepEqual([
        { action: 'catalog-install', scope: 'project', status: 200 },
      ]);
    });
  }
});
