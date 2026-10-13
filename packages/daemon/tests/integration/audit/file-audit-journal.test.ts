import { afterEach, describe, it } from 'bun:test';
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditRecord } from '@ferretry/protocol';
import should from 'should';
import { AUDIT_FILE_MAX_BYTES, auditJournalPaths, FileAuditJournal } from '../../../src/adapters/audit/index.ts';
import { ApiDispatcher, ApiRouter, type ApiRoute, jsonResponse } from '../../../src/lib/api/index.ts';
import { AUDITED_ROUTES, AuditLog, auditedRoutes } from '../../../src/lib/audit/index.ts';
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
    const empty = await journal.recent(10);
    await Promise.all(['a', 'b', 'c'].map(async subject => await journal.append(line(subject), 'general')));
    const reading = await journal.recent(2);
    const live = auditJournalPaths(state).live;

    // Assert
    should(empty).deepEqual({ records: [], unreadable: 0 });
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
    const reading = await journal.recent(200);

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
    const reading = await new FileAuditJournal(state).recent(1);

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
    const read = await journal.recent(1).then(
      () => undefined,
      (error: unknown) => error,
    );
    await rm(auditJournalPaths(state).live);
    await journal.append(line('after'), 'general');

    // Assert
    should(write).be.instanceOf(Error);
    should(read).be.instanceOf(Error);
    should(await readFile(elsewhere, 'utf8')).equal('');
    should((await journal.recent(5)).records.map(record => record.subject)).deepEqual(['after']);
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

  it('should keep a kept-store line however many general lines rotate past it', async () => {
    // Arrange
    const state = await stateDirectory();
    const journal = new FileAuditJournal(state, 4 * (line('x').length + 1));
    await journal.append(line('paired'), 'kept');

    // Act
    for (let index = 0; index < 40; index += 1) await journal.append(line(`flood-${index}`), 'general');
    const reading = await journal.recent(200);

    // Assert
    should(reading.records.map(record => record.subject)).containEql('paired');
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
    const read = await journal.recent(1).then(
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
    const reading = await log.recent(200);

    // Assert
    should(reading.records.map(record => record.event)).containEql('device.paired');
    const repeats = reading.records
      .filter(record => record.event === 'grants.changed')
      .reduce((total, record) => total + (typeof record.detail?.repeats === 'number' ? record.detail.repeats : 1), 0);
    should(repeats).equal(200);
  });
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
      journal: new FileAuditJournal(state, 2_400),
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
      new ApiRouter(auditedRoutes({ log, failures: { auditWriteFailed: () => undefined }, deviceName: async () => 'Pixel 8' }, routes)),
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
    const reading = await log.recent(200);

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
