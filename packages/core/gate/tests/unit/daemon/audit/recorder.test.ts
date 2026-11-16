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
import { AUDITED_ROUTES, type AuditedRouteRule } from '../../../../daemon/lib/audit/routes.ts';
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

describe('what a rule may read out of the answer', () => {
  const rule = (fields: Partial<AuditedRouteRule>): AuditedRouteRule => ({
    method: 'POST',
    path: '/v1/probe',
    event: 'fleet.configured',
    ...fields,
  });
  /** The call as the kernel tells it, with the answer's bytes exactly as built (not necessarily JSON). */
  const answered = (text: string, status = 200): RecordedCall => {
    const call = told('POST', '/v1/probe', { status });
    return { ...call, response: { status, headers: new Map(), body: text } };
  };
  const draftFor = (
    fields: Partial<AuditedRouteRule>,
    call: RecordedCall,
    configKind?: (path: string) => string | undefined,
  ) => recordedCallDraft(call, { rules: [rule(fields)], ...(configKind === undefined ? {} : { configKind }) });

  test('an answer that is not JSON is recorded without anything read from it', () => {
    const fields = {
      responseNames: 'names',
      responseSettings: ['view'],
      responseFields: { id: ['id'] },
      responseConfigKind: 'path',
      recordOnlyWhen: { field: 'changed', equals: true },
    };
    expect(draftFor(fields, answered('<html>not json</html>'))?.detail).toEqual({ status: 200 });
  });

  test('a refusal whose answer is not JSON keeps no code', () => {
    expect(draftFor({ refusalCode: true }, answered('upstream said no', 409))?.detail).toEqual({ status: 409 });
  });

  test('a refusal code is kept only when it is identifier-shaped, never free text', () => {
    const body = (code: unknown) => JSON.stringify({ code });
    expect(draftFor({ refusalCode: true }, answered(body('signature_invalid'), 409))?.detail).toEqual({
      code: 'signature_invalid',
      status: 409,
    });
    expect(draftFor({ refusalCode: true }, answered(body('has spaces and a secret'), 409))?.detail).toEqual({
      status: 409,
    });
    expect(draftFor({ refusalCode: true }, answered(body(7), 409))?.detail).toEqual({ status: 409 });
  });

  test('a rule reads a name from a nested path, and nothing that is not all strings', () => {
    const names = (body: unknown) => draftFor({ responseNames: 'view.used' }, answered(JSON.stringify(body)))?.detail;
    expect(names({ view: { used: ['A', 'B'] } })).toEqual({ used: 'A,B', status: 200 });
    expect(names({ view: { used: 'ONE' } })).toEqual({ used: 'ONE', status: 200 });
    expect(names({ view: { used: [] } })).toEqual({ status: 200 });
    expect(names({ view: { used: ['A', 3] } })).toEqual({ status: 200 });
    expect(names({ view: null })).toEqual({ status: 200 });
  });

  test('responseFields copies a boolean, a number, an identifier and a list of them, and never free text', () => {
    const fields = {
      responseFields: {
        flag: ['on'],
        count: ['view', 'count'],
        ids: ['items', '*', 'id'],
        sizes: ['items', '*', 'size'],
        mixed: ['items', '*', 'mixed'],
        words: ['title'],
        absent: ['nothing', 'here'],
      },
    };
    const body = {
      on: true,
      view: { count: 4 },
      items: [
        { id: 'a-1', size: 10, mixed: 'x' },
        { id: 'b-2', size: 20, mixed: 5 },
      ],
      title: 'a sentence with spaces',
    };
    expect(draftFor(fields, answered(JSON.stringify(body)))?.detail).toEqual({
      flag: true,
      count: 4,
      ids: 'a-1,b-2',
      sizes: '10,20',
      status: 200,
    });
  });

  test('a path that walks into a non-object finds nothing, and a field answer with nothing in it adds no detail', () => {
    const fields = { responseFields: { deep: ['view', 'count'] } };
    expect(draftFor(fields, answered(JSON.stringify({ view: 'text' })))?.detail).toEqual({ status: 200 });
    expect(draftFor(fields, answered(JSON.stringify({ view: [1, 2] })))?.detail).toEqual({ status: 200 });
    expect(draftFor(fields, answered(JSON.stringify(null)))?.detail).toEqual({ status: 200 });
  });

  test('a long list of names is cut to fit one audit field and ends with how many were left out', () => {
    const used = Array.from({ length: 60 }, (_, index) => `secret-${String(index).padStart(2, '0')}`);
    const joined = draftFor({ responseNames: 'used' }, answered(JSON.stringify({ used })))?.detail?.used;
    if (typeof joined !== 'string') throw new Error('a joined list is text');
    expect(joined.length).toBeLessThanOrEqual(160);
    const shown = joined.split(',').slice(0, -1);
    expect(shown).toEqual(used.slice(0, shown.length));
    expect(joined.endsWith(`,+${String(used.length - shown.length)}`)).toBe(true);
  });

  test('a config path is recorded as its KIND, and only when the kind is known and identifier-shaped', () => {
    const kindOf = (path: string) =>
      path === 'warden.yaml' ? 'warden' : path === 'odd.yaml' ? 'not an identifier!' : undefined;
    const kind = (body: unknown) =>
      draftFor({ responseConfigKind: 'path' }, answered(JSON.stringify(body)), kindOf)?.detail;
    expect(kind({ path: 'warden.yaml' })).toEqual({ kind: 'warden', status: 200 });
    expect(kind({ path: 'odd.yaml' })).toEqual({ status: 200 });
    expect(kind({ path: 'unknown.yaml' })).toEqual({ status: 200 });
    expect(kind({ path: 7 })).toEqual({ status: 200 });
    expect(kind(null)).toEqual({ status: 200 });
  });

  test('a rule with the answer withheld still records the act, from what admission knew', () => {
    const call = told('POST', '/v1/probe', { table: 'socket', status: 200 });
    expect(draftFor({ responseNames: 'used', recordOnlyWhen: { field: 'ok', equals: true } }, call)?.detail).toEqual({
      status: 200,
    });
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
