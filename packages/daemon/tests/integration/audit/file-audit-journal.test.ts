import { afterEach, describe, it } from 'bun:test';
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditRecord } from '@ferretry/protocol';
import should from 'should';
import { AUDIT_FILE_MAX_BYTES, auditJournalPaths, FileAuditJournal } from '../../../src/adapters/audit/index.ts';
import { ApiDispatcher, ApiRouter, type ApiRoute, jsonResponse } from '../../../src/lib/api/index.ts';
import {
  AUDIT_FOLD_WINDOW_MS,
  AUDITED_ROUTES,
  AUDITED_SOCKET_ROUTES,
  AuditLog,
  auditedRoutes,
  auditedSocketRoutes,
} from '../../../src/lib/audit/index.ts';
import type { SocketDownstream, SocketRoute } from '../../../src/lib/api/socket.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../src/lib/grants/index.ts';
import { request } from '../../unit/api/support.ts';
import { grantSubsystem } from '../../unit/runtime/mounts/support.ts';

const AT = '2026-10-13T12:00:00.000Z';
const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function stateDirectory(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'fy-audit-'));
  homes.push(home);
  return home;
}

function line(subject: string): string {
  return JSON.stringify({ at: AT, event: 'terminal.opened', actor: { kind: 'host' }, subject, outcome: 'succeeded' });
}

describe('FileAuditJournal', () => {
  it('should append owner-only lines and read them newest first', async () => {
    // Arrange
    const state = await stateDirectory();
    const journal = new FileAuditJournal(state);

    // Act
    const empty = await journal.recent(10, 0);
    await Promise.all(['a', 'b', 'c'].map(async subject => await journal.append(line(subject), 'general')));
    const reading = await journal.recent(2, 0);
    const live = auditJournalPaths(state).live;

    // Assert
    should(empty).deepEqual({ records: [], kept: [], keptTotal: 0, unreadable: 0 });
    should(reading.records.map(record => record.subject)).deepEqual(['c', 'b']);
    should((await stat(live)).mode & 0o777).equal(0o600);
    should((await readFile(live, 'utf8')).split('\n')).deepEqual([line('a'), line('b'), line('c'), '']);
  });

  it('should rotate to audit.1.jsonl at the bound, keep two files, and read across both', async () => {
    // Arrange
    const state = await stateDirectory();
    const journal = new FileAuditJournal(state, 3 * (line('x').length + 1));
    const { live, rotated } = auditJournalPaths(state);

    // Act
    for (const subject of ['1', '2', '3', '4', '5', '6', '7']) await journal.append(line(subject), 'general');
    const reading = await journal.recent(200, 0);

    // Assert
    should((await readFile(rotated, 'utf8')).trim().split('\n')).deepEqual([line('4'), line('5'), line('6')]);
    should((await readFile(live, 'utf8')).trim().split('\n')).deepEqual([line('7')]);
    should(reading.records.map(record => record.subject)).deepEqual(['7', '6', '5', '4']);
    should(AUDIT_FILE_MAX_BYTES).equal(1024 * 1024);
  });

  it('should count every line it cannot read across both files, and drop none of the rest', async () => {
    // Arrange
    const state = await stateDirectory();
    const { live, rotated } = auditJournalPaths(state);
    await writeFile(rotated, `${line('old')}\n{"half":\n`, { mode: 0o600 });
    await writeFile(live, `not json\n\n${JSON.stringify({ event: 'device.stolen' })}\n${line('new')}\n`, {
      mode: 0o600,
    });

    // Act
    const reading = await new FileAuditJournal(state).recent(1, 0);

    // Assert
    should(reading.unreadable).equal(3);
    should(reading.records.map(record => record.subject)).deepEqual(['new']);
  });

  it('should refuse to write or read through a planted link, and keep appending after a failure', async () => {
    // Arrange
    const state = await stateDirectory();
    const elsewhere = join(state, 'elsewhere.txt');
    await writeFile(elsewhere, '');
    await symlink(elsewhere, auditJournalPaths(state).live);
    const journal = new FileAuditJournal(state);

    // Act
    const write = await journal.append(line('x'), 'general').then(
      () => undefined,
      (error: unknown) => error,
    );
    const read = await journal.recent(1, 0).then(
      () => undefined,
      (error: unknown) => error,
    );
    await rm(auditJournalPaths(state).live);
    await journal.append(line('after'), 'general');

    // Assert
    should(write).be.instanceOf(Error);
    should(read).be.instanceOf(Error);
    should(await readFile(elsewhere, 'utf8')).equal('');
    should((await journal.recent(5, 0)).records.map(record => record.subject)).deepEqual(['after']);
  });

  it('should fail a size check it cannot make rather than overrun the bound', async () => {
    // Arrange: a state directory that is a FILE makes the live path's parent unusable.
    const state = await stateDirectory();
    const notADirectory = join(state, 'file');
    await writeFile(notADirectory, '');
    const journal = new FileAuditJournal(notADirectory);

    // Act
    const error = await journal.append(line('x'), 'general').then(
      () => undefined,
      (failure: unknown) => failure,
    );

    // Assert
    should(error).be.instanceOf(Error);
  });

  it('should refuse a never-rotating line to a full store, and leave the store untouched', async () => {
    // Arrange
    const state = await stateDirectory();
    const journal = new FileAuditJournal(state, 2 * (line('x').length + 1));
    const { kept } = auditJournalPaths(state);
    await journal.append(line('1'), 'kept', 'never');
    await journal.append(line('2'), 'kept', 'never');

    // Act
    const refused = await journal.append(line('3'), 'kept', 'never');
    const rotated = await journal.append(line('4'), 'kept');

    // Assert
    should([refused, rotated]).deepEqual([false, true]);
    should(await readFile(kept.rotated, 'utf8')).equal(`${line('1')}\n${line('2')}\n`);
  });

  it('should keep a kept-store line however many general lines rotate past it', async () => {
    // Arrange
    const state = await stateDirectory();
    const journal = new FileAuditJournal(state, 4 * (line('x').length + 1));
    await journal.append(line('paired'), 'kept');

    // Act
    for (let index = 0; index < 40; index += 1) await journal.append(line(`flood-${index}`), 'general');
    const reading = await journal.recent(200, 0);

    // Assert
    should(reading.kept.map(record => record.subject)).containEql('paired');
    should((await readFile(auditJournalPaths(state).kept.live, 'utf8')).trim()).equal(line('paired'));
  });

  it('should refuse a FIFO or a second hard link at the path, and never block on either', async () => {
    // Arrange
    const state = await stateDirectory();
    const { live, kept } = auditJournalPaths(state);
    const fifo = Bun.spawnSync(['mkfifo', live]);
    await writeFile(join(state, 'mirror.jsonl'), '', { mode: 0o600 });
    await link(join(state, 'mirror.jsonl'), kept.live);
    const journal = new FileAuditJournal(state);

    // Act
    const general = await journal.append(line('x'), 'general').then(
      () => undefined,
      (error: unknown) => error,
    );
    const mirrored = await journal.append(line('x'), 'kept').then(
      () => undefined,
      (error: unknown) => error,
    );
    const read = await journal.recent(1, 0).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(fifo.exitCode).equal(0);
    should(general).be.instanceOf(Error);
    should(mirrored).be.instanceOf(Error);
    should(read).be.instanceOf(Error);
    should(await readFile(join(state, 'mirror.jsonl'), 'utf8')).equal('');
  });
});

/**
 * H1: a flood of refusals must not rotate a high-value record out of view.
 */
describe('a flood of refusals', () => {
  it('should leave the earlier device.paired readable, and say how many times it was refused', async () => {
    // Arrange
    const state = await stateDirectory();
    let now = Date.parse(AT);
    const log = new AuditLog({
      journal: new FileAuditJournal(state, 1_500),
      clock: { now: () => new Date(now).toISOString() },
      failures: { auditWriteFailed: () => undefined },
    });
    const thief = { kind: 'device' as const, deviceId: `fy_device_id_${'t'.repeat(22)}` };
    await log.record({ event: 'device.paired', actor: { kind: 'anonymous' }, subject: 'phone', outcome: 'succeeded' });

    // Act
    for (let index = 0; index < 200; index += 1) {
      now += 1_000;
      await log.record({ event: 'grants.changed', actor: thief, subject: `guess-${index}`, outcome: 'refused' });
    }
    await log.flush(Number.POSITIVE_INFINITY);
    const reading = await log.recent(200, 0);

    // Assert
    should(reading.kept.map(record => record.event)).containEql('device.paired');
    const repeats = reading.records
      .filter(record => record.event === 'grants.changed')
      .reduce((total, record) => total + (typeof record.detail?.repeats === 'number' ? record.detail.repeats : 1), 0);
    should(repeats).equal(200);
  });
});

/**
 * H1 round 2: NOTHING A PAIRED DEVICE CAN REPEAT AT WILL may rotate its own pairing off the disk, or off
 * the page a reader is shown.
 *
 * The device drives EVERY audited route and socket — successes and refusals alike, with fresh subjects
 * so no fold can hide the volume — through the real decorators, the real `AuditLog` and the real
 * `FileAuditJournal` at its real bound. Then the probe from the review: 15,000 terminal attaches.
 */
describe('a flood by a paired device', () => {
  const thief = `fy_device_id_${'t'.repeat(22)}`;

  class Downstream implements SocketDownstream {
    send(): number {
      return 1;
    }
    close(): void {}
    bufferedBytes(): number {
      return 0;
    }
  }

  async function flooded(maxBytes?: number) {
    const state = await stateDirectory();
    let now = Date.parse(AT);
    const failures: string[] = [];
    const log = new AuditLog({
      journal: new FileAuditJournal(state, maxBytes),
      clock: { now: () => new Date(now).toISOString() },
      failures: { auditWriteFailed: message => failures.push(message) },
    });
    const subsystem = { log, failures: { auditWriteFailed: () => undefined }, deviceName: async () => 'Thief' };
    const credential = { kind: 'authenticated', tokenClass: 'device', deviceId: thief } as const;
    let fails = false;
    const routes = auditedRoutes(
      subsystem,
      AUDITED_ROUTES.map(
        (rule): ApiRoute => ({
          method: rule.method,
          path: rule.path,
          minimum: 'operator',
          handle: async () => (fails ? { ...jsonResponse({}), status: 403 } : jsonResponse({ used: ['K'], name: 'K' })),
        }),
      ),
    );
    const sockets = auditedSocketRoutes(
      subsystem,
      AUDITED_SOCKET_ROUTES.map(
        (rule): SocketRoute => ({
          method: 'GET',
          path: rule.path,
          minimum: 'operator',
          accept: async () => async () => ({
            open: async () => undefined,
            fromClient: () => undefined,
            close: () => undefined,
          }),
        }),
      ),
    );
    const call = async (index: number): Promise<void> => {
      const subject = `x${String(index)}`;
      for (const route of routes)
        await route.handle({
          request: request({ method: route.method, path: route.path }),
          params: new Map([...route.path.matchAll(/:([A-Za-z]+)/gu)].map(match => [match[1] ?? '', subject])),
          credential,
        });
      for (const socket of sockets) {
        const attach = await socket.accept({
          request: request({ path: socket.path }),
          params: new Map([
            ['sessionId', subject],
            ['terminalId', subject],
          ]),
          credential,
        });
        const handler = await attach(new Downstream());
        handler.fromClient(new Uint8Array([1]));
      }
    };
    return {
      state,
      log,
      failures,
      call,
      tick: (ms: number) => (now += ms),
      refuse: (value: boolean) => (fails = value),
      sockets,
      credential,
    };
  }

  it('should leave device.paired on disk and on the reader’s page after a flood of everything a device can do', async () => {
    // Arrange: a 32 KiB bound, so a test-sized flood rotates each store many times over.
    const world = await flooded(32 * 1024);
    await world.log.record({
      event: 'device.paired',
      actor: { kind: 'device', deviceId: thief, deviceName: 'Thief' },
      subject: thief,
      outcome: 'succeeded',
    });

    // Act: a week of every route and socket, succeeding and refused, a fresh subject every time.
    const calls = 120;
    for (let index = 0; index < calls; index += 1) {
      world.refuse(index % 2 === 1);
      await world.call(index);
      world.tick((7 * 86_400_000) / calls);
    }
    await world.log.flush(Number.POSITIVE_INFINITY);
    const paths = auditJournalPaths(world.state);
    const kept =
      (await readFile(paths.kept.live, 'utf8')) + (await readFile(paths.kept.rotated, 'utf8').catch(() => ''));
    const general = await readFile(paths.rotated, 'utf8');
    // Page back through the kept list the way a reader does, until it has seen every record.
    const first = await world.log.recent(200, 0);
    const pages = [first.kept];
    while (pages.flat().length < first.keptTotal) pages.push((await world.log.recent(200, pages.flat().length)).kept);

    // Assert
    should(general.length).be.above(0); // the general store DID rotate: the flood was real
    should(kept.startsWith('{')).be.true();
    should(kept).containEql('"event":"device.paired"');
    should(pages.flat().map(record => record.event)).containEql('device.paired');
    // Once a device fills the kept store it is refused, never rotated — and the operator is told.
    should(world.failures.length).be.above(0);
    for (const failure of world.failures) should(failure).containEql('kept store is full');
  }, 60_000);

  it('should leave device.paired on disk after 3,000 terminal attaches', async () => {
    // Arrange
    const world = await flooded();
    await world.log.record({
      event: 'device.paired',
      actor: { kind: 'device', deviceId: thief },
      subject: thief,
      outcome: 'succeeded',
    });
    const terminal = world.sockets[0];

    // Act: the review's probe — re-attach in a loop, as fast as a socket allows.
    for (let index = 0; index < 3_000; index += 1) {
      await terminal?.accept({
        request: request({ path: '/attach' }),
        params: new Map([
          ['sessionId', 's-1'],
          ['terminalId', 'term-1'],
        ]),
        credential: world.credential,
      });
      if (index % 200 === 199) world.tick(AUDIT_FOLD_WINDOW_MS);
    }
    await world.log.flush(Number.POSITIVE_INFINITY);
    const paths = auditJournalPaths(world.state);
    const reading = await world.log.recent(200, 0);

    // Assert
    should(await readFile(paths.kept.live, 'utf8')).containEql('"event":"device.paired"');
    should(reading.kept.map(record => record.event)).deepEqual(['device.paired']);
    const attaches = reading.records
      .filter(record => record.event === 'terminal.opened')
      .reduce((total, record) => total + (typeof record.detail?.repeats === 'number' ? record.detail.repeats : 1), 0);
    should(attaches).equal(3_000);
    should(reading.records.length).be.below(40);
  }, 60_000);

  it('should leave device.paired and the security change on a kept page after a flood of idle expiries', async () => {
    // Arrange: the round-3 probe — a device pairs, shortens the idle period, and pairs devices to expire.
    // About 14,000 expiries rotated a 1 MiB kept store; at a 64 KiB bound, 2,000 fill it several times over.
    const world = await flooded(64 * 1024);
    await world.log.record({
      event: 'device.paired',
      actor: { kind: 'device', deviceId: thief },
      subject: thief,
      outcome: 'succeeded',
    });
    await world.log.record({
      event: 'security.changed',
      actor: { kind: 'device', deviceId: thief },
      subject: 'security-settings',
      outcome: 'succeeded',
      detail: { idleExpiryDays: 1 },
    });

    // Act: the daemon's own sweeps — a host actor, a daemon cause — over a week.
    for (let index = 0; index < 2_000; index += 1) {
      await world.log.record({
        event: 'device.expired',
        actor: { kind: 'host' },
        cause: 'daemon',
        subject: `fy_device_id_${String(index).padStart(22, '0')}`,
        outcome: 'succeeded',
      });
      if (index % 250 === 249) world.tick(86_400_000);
    }
    await world.log.flush(Number.POSITIVE_INFINITY);
    const paths = auditJournalPaths(world.state);
    const first = await world.log.recent(200, 0);
    const pages = [first.kept];
    while (pages.flat().length < first.keptTotal) pages.push((await world.log.recent(200, pages.flat().length)).kept);

    // Assert
    const kept = await readFile(paths.kept.live, 'utf8');
    should(kept).containEql('"event":"device.paired"');
    should(kept).containEql('"idleExpiryDays":1');
    should(await readFile(paths.kept.rotated, 'utf8').catch(() => '')).equal('');
    const events = pages.flat().map(record => record.event);
    should(events).containEql('device.paired');
    should(events).containEql('security.changed');
    // The flood filled the kept store, and from then on it was REFUSED there — never rotated — and the
    // operator was told. Until then every expiry was counted on a kept page, in full or in a count.
    should(world.failures.length).be.above(0);
    for (const failure of world.failures) should(failure).containEql('kept store is full');
    const counted = pages
      .flat()
      .filter(record => record.event === 'device.expired')
      .reduce((total, record) => total + (typeof record.detail?.repeats === 'number' ? record.detail.repeats : 1), 0);
    should(counted).be.above(1_000);
  }, 60_000);
});

/**
 * NAMES AND IDS ONLY, proved against the bytes on disk.
 *
 * Every audited route is driven with a request body and a response that carry a fixture secret of
 * each forbidden kind, and then every file the journal wrote is searched for each one.
 */
describe('the security log on disk', () => {
  it('should never contain a code, token, key, proof, secret value or command line', async () => {
    // Arrange
    const state = await stateDirectory();
    const secrets = {
      code: '7F3K-Q2ND',
      token: `fy_device_${'s'.repeat(43)}`,
      key: '-----BEGIN PRIVATE KEY-----MIIfixture',
      proof: 'proof-fixture-c2lnbmF0dXJl',
      secretValue: 'hunter2-fixture-value',
      commandLine: 'curl -H secret-header https://example.test',
      password: 'operator-password-fixture',
    };
    const leaky = JSON.stringify({
      ...secrets,
      used: ['API_KEY'],
      stdout: secrets.secretValue,
      argv: secrets.commandLine,
    });
    const log = new AuditLog({
      // Live plus rotated must hold one record per audited route — rotation drops the oldest file. So the
      // size grows WITH the table: a fixed byte count (2,400, then 3,600, then 4,000) failed CI for the
      // next pull request that audited a route, as "23 records, not 36". A record is ~180 bytes and live
      // plus rotated keep at least 2 × 128 per route, while the ~140 per route actually written still
      // rotates once, so the rotated file is read too.
      journal: new FileAuditJournal(state, AUDITED_ROUTES.length * 128),
      clock: { now: () => AT },
      failures: { auditWriteFailed: () => undefined },
    });
    const routes: ApiRoute[] = AUDITED_ROUTES.map(rule => ({
      method: rule.method,
      path: rule.path,
      minimum: 'operator' as const,
      handle: async () => ({ ...jsonResponse(JSON.parse(leaky)), status: 200 }),
    }));
    const grants = grantSubsystem({ grants: DEFAULT_CAPABILITY_GRANTS });
    await grants.refresh();
    const api = new ApiDispatcher(
      new ApiRouter(
        auditedRoutes(
          { log, failures: { auditWriteFailed: () => undefined }, deviceName: async () => 'Pixel 8' },
          routes,
        ),
      ),
      { admin: 'admin-secret', warden: 'warden-secret' },
      grants,
    );

    // Act
    for (const rule of AUDITED_ROUTES) {
      const path = rule.path.replaceAll(/:[A-Za-z]+/gu, `fy_device_id_${'d'.repeat(22)}`);
      await api.dispatch(
        request({
          method: rule.method,
          path,
          headers: { authorization: 'Bearer admin-secret', 'x-proof': secrets.proof },
          query: [['code', secrets.code]],
          body: leaky,
        }),
      );
    }
    const paths = auditJournalPaths(state);
    const files = [paths.live, paths.rotated, paths.kept.live, paths.kept.rotated];
    const written = (await Promise.all(files.map(async file => await readFile(file, 'utf8').catch(() => '')))).join('');
    const read = await log.recent(200, 0);
    const reading = { ...read, records: [...read.kept, ...read.records] };

    // Assert
    should(reading.records).have.length(AUDITED_ROUTES.length);
    should(reading.unreadable).equal(0);
    for (const [kind, value] of Object.entries(secrets))
      should({ kind, leaked: written.includes(value) }).deepEqual({ kind, leaked: false });
    should(written.includes('admin-secret')).be.false();
    const events = reading.records.map((record: AuditRecord) => record.event);
    should(new Set(events)).deepEqual(new Set(AUDITED_ROUTES.map(rule => rule.event)));
  });
});
