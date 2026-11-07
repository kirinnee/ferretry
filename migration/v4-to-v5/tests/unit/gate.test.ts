import { afterEach, beforeEach, expect, test } from 'bun:test';
import { AUDIT_KIND_NAMES, AuditRecordSchema } from '@ferretry/core-gate/contract';
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gateStep, V5_ADMIN_TOKEN, V5_AUDIT, V5_WARDEN_TOKEN } from '../../src/steps/gate.ts';
import { V4_AUDIT_EVENTS, v5AuditKind } from '../../src/v4/gate.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

// FAKE bearer-shaped values (not real tokens): the test proves they are copied unchanged and reach no report or log.
const FAKE_ADMIN = 'FAKE-ADMIN-TOKEN-bm90LWEtcmVhbC10b2tlbi0xMjM0NTY3\n';
const FAKE_WARDEN = 'FAKE-WARDEN-TOKEN-bm90LWEtcmVhbC10b2tlbi03NjU0MzIx\n';

const raw = async (path: string, text: string, mode = 0o600) => {
  await mkdir(join(f.from, path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.from, path), text, { mode });
  await chmod(join(f.from, path), mode);
};
const jsonl = (...lines: unknown[]) => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;
const at = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

async function everything(root: string): Promise<string> {
  const names = await readdir(root, { recursive: true }).catch(() => []);
  const texts = await Promise.all(
    names.map(async name => ((await stat(join(root, name))).isFile() ? readFile(join(root, name), 'utf8') : '')),
  );
  return texts.join('\n');
}

const auditLines = async () =>
  (await readFile(join(f.to, V5_AUDIT), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);

test('every v4 audit event has a v5 kind', () => {
  const kinds = new Set<string>(AUDIT_KIND_NAMES);
  expect(V4_AUDIT_EVENTS.filter(event => !kinds.has(v5AuditKind(event) ?? ''))).toEqual([]);
  expect(v5AuditKind('input.quarantine_ended')).toBe('input.hold-ended');
  expect(v5AuditKind('session.credential-revoked')).toBe('ferret.credential-revoked');
  expect(v5AuditKind('FAKE.event')).toBeUndefined();
});

test('the admin and warden tokens move byte for byte, 0600, and never reach a report or another file', async () => {
  await raw('api-token', FAKE_ADMIN);
  await raw('api-warden-token', FAKE_WARDEN, 0o400);
  const report = await gateStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.sealed).toEqual([
    { file: V5_ADMIN_TOKEN, bytes: FAKE_ADMIN.length },
    { file: V5_WARDEN_TOKEN, bytes: FAKE_WARDEN.length },
  ]);
  for (const [from, to] of [
    ['api-token', V5_ADMIN_TOKEN],
    ['api-warden-token', V5_WARDEN_TOKEN],
  ] as const) {
    expect((await readFile(join(f.to, to))).equals(await readFile(join(f.from, from)))).toBe(true);
    expect((await stat(join(f.to, to))).mode & 0o777).toBe(0o600);
  }
  const text = JSON.stringify(report);
  expect(text).not.toContain('FAKE-ADMIN-TOKEN');
  expect(text).not.toContain('FAKE-WARDEN-TOKEN');
  expect(await stat(join(f.to, V5_AUDIT)).catch(() => undefined)).toBeUndefined();
});

test('a token behind a link is refused, never followed, and the step names only the file', async () => {
  await raw('elsewhere/real-token', FAKE_ADMIN);
  await symlink(join(f.from, 'elsewhere/real-token'), join(f.from, 'api-token'));
  const report = await gateStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('api-token: is not a regular file (a token is never followed through a link)');
  expect(JSON.stringify(report)).not.toContain('FAKE-ADMIN-TOKEN');
  expect(await everything(f.to)).not.toContain('FAKE-ADMIN-TOKEN');
});

test('all four v4 audit files become one v5 audit.jsonl, oldest first, every line a v5 record; the journals are Access’s', async () => {
  const device = { kind: 'device', deviceId: 'dev-000001', deviceName: 'FAKE phone' };
  await raw(
    'state/audit.1.jsonl',
    jsonl({ at: at(1), event: 'terminal.opened', actor: device, subject: 'fake-terminal', outcome: 'succeeded' }),
  );
  await raw(
    'state/audit.jsonl',
    `${jsonl(
      { at: at(5), event: 'input.quarantine_ended', actor: { kind: 'host' }, outcome: 'succeeded' },
      { at: at(6), event: 'session.credential-refused', actor: { kind: 'anonymous' }, outcome: 'refused' },
      { at: at(7), event: 'FAKE.unknown', actor: { kind: 'host' }, outcome: 'succeeded' },
    )}{"at":"FAKE-TORN`,
  );
  await raw(
    'state/audit-kept.jsonl',
    jsonl({
      at: at(2),
      event: 'device.paired',
      actor: device,
      subject: 'dev-000001',
      outcome: 'succeeded',
      detail: { carrier: 'relay' },
    }),
  );
  await raw(
    'state/grant-audit.jsonl',
    jsonl({ kind: 'grant.changed', at: at(3), actor: 'device:dev-000001', changes: ['fleet.use=on'] }),
  );

  const report = await gateStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'audit records', count: 4 });
  expect(report.note).toContain('2 unreadable audit line(s) skipped');
  expect(JSON.stringify(report)).not.toContain('FAKE');

  const lines = await auditLines();
  for (const line of lines) {
    expect(Object.keys(line)[0]).toBe('format');
    AuditRecordSchema.parse(line);
  }
  expect(lines.map(line => [line.at, line.event])).toEqual([
    [at(1), 'terminal.opened'],
    [at(2), 'device.paired'],
    [at(5), 'input.hold-ended'],
    [at(6), 'ferret.credential-refused'],
  ]);
  expect(lines[1]).toEqual({
    format: 1,
    at: at(2),
    event: 'device.paired',
    actor: device,
    subject: 'dev-000001',
    outcome: 'succeeded',
    detail: { carrier: 'relay' },
  });
  expect((await stat(join(f.to, V5_AUDIT))).mode & 0o777).toBe(0o600);
});

test('a link in place of an audit file is refused, naming the file', async () => {
  await raw('elsewhere/a.jsonl', jsonl({}));
  await mkdir(join(f.from, 'state'), { recursive: true });
  await symlink(join(f.from, 'elsewhere/a.jsonl'), join(f.from, 'state/audit.jsonl'));
  const report = await gateStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('state/audit.jsonl: is not a regular file');
});

test('a home with no gate files converts to nothing; a dry run counts and writes nothing', async () => {
  const empty = await gateStep.run(f.ctx());
  expect(empty.status).toBe('converted');
  expect(empty.note).toContain('no api-token in the v4 home');
  await raw('api-token', FAKE_ADMIN);
  await raw(
    'state/audit.jsonl',
    jsonl({ at: at(1), event: 'device.revoked', actor: { kind: 'host' }, outcome: 'succeeded' }),
  );
  const report = await gateStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.note).toStartWith('dry run: nothing written');
  expect(report.sealed).toEqual([{ file: V5_ADMIN_TOKEN, bytes: FAKE_ADMIN.length }]);
  expect(report.kept).toContainEqual({ what: 'audit records', count: 1 });
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});
