import { describe, expect, test } from 'bun:test';
import type {
  ApiRequest,
  CallStanding,
  PolicyRef,
  RecordedCall,
  ScopedRoute,
  SessionId,
} from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { AUDIT_KINDS, type AuditDraft, AuditLogFile, auditKind } from '../../../../contract/index.ts';
import { StateAuditJournal } from '../../../../daemon/adapters/audit/state-audit-journal.ts';
import { isOwnersOwnRecord } from '../../../../daemon/lib/audit/policy.ts';
import { recordedCallDraft } from '../../../../daemon/lib/audit/recorder.ts';
import { AUDITED_ROUTES } from '../../../../daemon/lib/audit/routes.ts';
import { AuditKeptFile, AuditKeptRotatedFile, AuditRotatedFile } from '../../../../manifest.ts';

const ANY_KIND = auditKind('fleet.configured') as PolicyRef<'audit'>;

const device = (holder: string): CallStanding => ({
  credential: {
    kind: 'authenticated',
    tokenClass: 'device',
    principal: {
      kind: 'device',
      holder: holder as never,
      session: `s-${holder}` as SessionId,
      leaseUntil: '2026-11-07T12:15:00.000Z' as never,
    },
  },
});
const owner: CallStanding = { credential: { kind: 'authenticated', tokenClass: 'admin' } };

function told(
  method: string,
  path: string,
  options: {
    readonly status?: number;
    readonly body?: unknown;
    readonly params?: Readonly<Record<string, string>>;
    readonly standing?: CallStanding;
    readonly table?: RecordedCall['table'];
  } = {},
): RecordedCall {
  const status = options.status ?? 200;
  const request = {
    method,
    path,
    query: new Map(),
    headers: new Map(),
    arrival: { kind: 'local', privileged: false },
    text: async () => {
      throw new Error('the record never reads the request body');
    },
  } as unknown as ApiRequest;
  return {
    table: options.table ?? 'route',
    descriptor: {
      method,
      path,
      minimum: 'operator',
      caller: 'any',
      audit: { record: ANY_KIND },
      guard: { none: 't' },
    } as ScopedRoute,
    request,
    params: new Map(Object.entries(options.params ?? {})),
    standing: options.standing ?? owner,
    actor: 'owner-tools',
    status,
    ...(options.table === 'socket'
      ? {}
      : {
          response: {
            status,
            headers: new Map(),
            body: options.body === undefined ? '{}' : JSON.stringify(options.body),
          },
        }),
  };
}

describe('Admission.recorded: today’s audited-route rules, after the handler', () => {
  test('a refused step-up is recorded as step-up.failed, a good one as step-up.succeeded (refusedEvent)', () => {
    expect(recordedCallDraft(told('POST', '/v1/step-up'))?.event).toBe(AUDIT_KINDS['step-up.succeeded']);
    const refused = recordedCallDraft(told('POST', '/v1/step-up', { status: 403, standing: device('phone') }));
    expect(refused).toMatchObject({
      event: AUDIT_KINDS['step-up.failed'],
      actor: { kind: 'device', deviceId: 'phone' },
      outcome: 'refused',
      detail: { action: 'step-up', status: 403 },
    });
  });

  test('G115 PATCH /v1/security is recorded as security.changed for a refused remote widen, naming the device', () => {
    for (const code of ['security_widen_at_machine', 'grant_step_up_required']) {
      const draft = recordedCallDraft(
        told('PATCH', '/v1/security', { status: 403, standing: device('phone'), body: { error: 'x', code } }),
      );
      expect(draft).toEqual({
        event: AUDIT_KINDS['security.changed'],
        actor: { kind: 'device', deviceId: 'phone' },
        subject: 'security-settings',
        outcome: 'refused',
        detail: { status: 403 },
      });
    }
  });

  test('G115 a PATCH /v1/security that changed the settings is recorded once, with the device and the settings left in place', () => {
    const body = { view: { settings: { unlockValidityHours: 4, unlockOnOpen: true, note: 'x' } }, devicesExpiring: 0 };
    const draft = recordedCallDraft(told('PATCH', '/v1/security', { standing: device('phone'), body }));
    expect(draft).toEqual({
      event: AUDIT_KINDS['security.changed'],
      actor: { kind: 'device', deviceId: 'phone' },
      subject: 'security-settings',
      outcome: 'succeeded',
      detail: { unlockValidityHours: 4, unlockOnOpen: true, status: 200 },
    });
    expect(AUDITED_ROUTES.filter(rule => rule.method === 'PATCH' && rule.path === '/v1/security')).toHaveLength(1);
  });

  test('G115 a PATCH /v1/security the daemon could not answer is recorded as failed (503 security_unavailable)', () => {
    const draft = recordedCallDraft(
      told('PATCH', '/v1/security', { status: 503, standing: owner, body: { code: 'security_unavailable' } }),
    );
    expect(draft).toMatchObject({
      event: AUDIT_KINDS['security.changed'],
      actor: { kind: 'host' },
      outcome: 'failed',
      detail: { status: 503 },
    });
  });

  test('G115 a ferret’s PATCH /v1/security is the host, with the ferret named in the detail', () => {
    const standing: CallStanding = {
      credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'F7' as never },
    };
    const draft = recordedCallDraft(told('PATCH', '/v1/security', { status: 403, standing }));
    expect(draft).toMatchObject({ actor: { kind: 'host' }, outcome: 'refused', detail: { by: 'agent', ferret: 'F7' } });
  });

  test('a rule reads NAMES out of the answer, never its other fields (responseNames)', () => {
    const draft = recordedCallDraft(
      told('POST', '/v1/secrets/use', { body: { used: ['GITHUB', 'NPM'], output: 'hunter2' } }),
    );
    expect(draft?.detail).toEqual({ used: 'GITHUB,NPM', status: 200 });
    expect(JSON.stringify(draft)).not.toContain('hunter2');
  });

  test('a refusal’s code is kept only where the rule asks for it (refusalCode)', () => {
    const install = recordedCallDraft(
      told('POST', '/v1/catalog-installs/project', { status: 409, body: { error: 'x', code: 'signature_invalid' } }),
    );
    expect(install?.detail).toMatchObject({ code: 'signature_invalid', action: 'catalog-install' });
    const revoke = recordedCallDraft(
      told('DELETE', '/v1/pair/devices/:deviceId', {
        status: 404,
        params: { deviceId: 'd1' },
        body: { code: 'not_found' },
      }),
    );
    expect(revoke?.detail).toEqual({ status: 404 });
    expect(revoke?.subject).toBe('d1');
  });

  test('a success whose answer says nothing changed is not an act (recordOnlyWhen); an unreadable one is', () => {
    const rule = AUDITED_ROUTES.find(candidate => candidate.recordOnlyWhen !== undefined);
    if (rule?.recordOnlyWhen === undefined) throw new Error('today has a recordOnlyWhen rule');
    const other = typeof rule.recordOnlyWhen.equals === 'boolean' ? !rule.recordOnlyWhen.equals : 'something-else';
    expect(
      recordedCallDraft(told(rule.method, rule.path, { body: { [rule.recordOnlyWhen.field]: other } })),
    ).toBeUndefined();
    expect(recordedCallDraft(told(rule.method, rule.path, { body: 'not json' }))).toBeDefined();
  });

  test('a setting change keeps the numbers and switches of the answer, never text (responseSettings)', () => {
    const rule = AUDITED_ROUTES.find(
      candidate => candidate.method === 'PUT' && candidate.path === '/v1/copy-rules/settings',
    );
    if (rule?.responseSettings === undefined) throw new Error('today records the settings a change left');
    expect(rule.responseSettings).toEqual([]);
    const draft = recordedCallDraft(
      told(rule.method, rule.path, { body: { idleExpiryDays: 1, unlockOnOpen: true, note: 'x' } }),
    );
    expect(draft?.detail).toMatchObject({ idleExpiryDays: 1, unlockOnOpen: true });
    expect(draft?.detail).not.toHaveProperty('note');
    expect(draft?.subject).toBe(rule.fixedSubject);
  });

  test('a config confirmation names the KIND of file (who declares it), never its path', () => {
    const draft = recordedCallDraft(told('POST', '/v1/config/confirm', { body: { path: 'warden.yaml' } }), {
      configKind: path => (path === 'warden.yaml' ? 'warden' : undefined),
    });
    expect(draft?.detail).toMatchObject({ action: 'config-confirm', kind: 'warden' });
    expect(JSON.stringify(draft)).not.toContain('warden.yaml');
  });

  test('a recorded route today’s table does not name is recorded by its descriptor kind; a socket as its attach', () => {
    expect(recordedCallDraft(told('POST', '/v1/new-thing/:id', { params: { id: 'x1' } }))).toEqual({
      event: ANY_KIND,
      actor: { kind: 'host' },
      subject: 'x1',
      outcome: 'succeeded',
    });
    const socket = recordedCallDraft(
      told('GET', '/v1/stream/:id', { table: 'socket', status: 101, params: { id: 't1' } }),
    );
    expect(socket).toMatchObject({ outcome: 'succeeded', subject: 't1', detail: { mode: 'attach' } });
  });

  test('a skipped descriptor is never recorded', () => {
    const call = told('PATCH', '/v1/security');
    expect(
      recordedCallDraft({ ...call, descriptor: { ...call.descriptor, audit: { skip: 'journals itself' } } }),
    ).toBeUndefined();
  });
});

describe('who a kept record is rationed for', () => {
  test('a record the daemon caused on its own is rationed like a remote one, though the actor is the host', () => {
    const draft: AuditDraft = { event: AUDIT_KINDS['device.expired'], actor: { kind: 'host' }, outcome: 'succeeded' };
    expect(isOwnersOwnRecord(draft)).toBe(true);
    expect(isOwnersOwnRecord({ ...draft, cause: 'daemon' })).toBe(false);
  });
});

describe('the audit on disk, read through the kernel’s per-line reader', () => {
  test('F-0075 one damaged line is counted, and the valid records around it are still read', async () => {
    const folder = new MemoryStateFolder();
    const files = [AuditLogFile, AuditRotatedFile, AuditKeptFile, AuditKeptRotatedFile];
    const record = (n: number) =>
      JSON.stringify({
        format: 1,
        at: `2026-11-07T12:00:0${String(n)}.000Z`,
        event: 'session.opened',
        actor: { kind: 'host' },
        outcome: 'succeeded',
      });
    folder.plant(AuditLogFile, `${record(1)}\n{"format":1,"event":7}\nnot json\n${record(2)}\n`);
    const journal = new StateAuditJournal(folder.port(files), {
      general: { live: AuditLogFile, rotated: AuditRotatedFile },
      kept: { live: AuditKeptFile, rotated: AuditKeptRotatedFile },
    });
    const reading = await journal.recent(50, 0);
    expect(reading.records.map(entry => String(entry.at))).toEqual([
      '2026-11-07T12:00:02.000Z',
      '2026-11-07T12:00:01.000Z',
    ]);
    expect(reading.unreadable).toBe(2);
  });
});
