import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { ApiRequest, CallStanding, PolicyRef, RecordedCall, ScopedRoute } from '@ferretry/kernel/contract';
import { auditKind } from '../../../../contract/index.ts';
import { recordedCallDraft } from '../../../../daemon/lib/audit/recorder.ts';
import { AUDITED_ROUTES } from '../../../../daemon/lib/audit/routes.ts';
import { loadManifests, loadWorkspace } from '../../../../../../../scripts/gen/lib/workspace.ts';

const ROOT = resolve(import.meta.dir, '../../../../../../..');

/**
 * Rules whose route another piece has yet to declare. Each names its owner; the entry goes the day the route is
 * declared (the test below fails if a listed rule already matches), so this list can only shrink.
 */
const PENDING: Readonly<Record<string, string>> = {
  'POST /v1/agent/config': 'kernel (config routes, D2 #3)',
};

/** Every declared route, socket and member route by `METHOD path`, with whether its descriptor records. */
async function declaredRoutes(): Promise<ReadonlyMap<string, { readonly records: boolean }>> {
  const { loaded, failures } = await loadManifests(loadWorkspace(ROOT));
  expect(failures).toEqual([]);
  const keys = new Map<string, { readonly records: boolean }>();
  for (const { manifest } of loaded)
    for (const r of [
      ...(manifest.actions?.routes ?? []),
      ...(manifest.actions?.sockets ?? []),
      ...(manifest.actions?.memberRoutes ?? []),
    ])
      keys.set(`${r.method} ${r.path}`, { records: 'record' in r.audit });
  return keys;
}

const ANY_KIND = auditKind('fleet.configured') as PolicyRef<'audit'>;
const owner: CallStanding = { credential: { kind: 'authenticated', tokenClass: 'admin' } };

function told(method: string, path: string, params: Readonly<Record<string, string>>): RecordedCall {
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
    table: 'route',
    descriptor: {
      method,
      path,
      minimum: 'operator',
      caller: 'any',
      audit: { record: ANY_KIND },
      guard: { none: 't' },
    } as ScopedRoute,
    request,
    params: new Map(Object.entries(params)),
    standing: owner,
    actor: 'owner-tools',
    status: 200,
    response: { status: 200, headers: new Map(), body: '{}' },
  };
}

describe('the audited-route table names routes that exist', () => {
  test('every AUDITED_ROUTES rule matches a descriptor some manifest declares, bar the pending ones named above', async () => {
    const declared = await declaredRoutes();
    const dead = AUDITED_ROUTES.map(rule => `${rule.method} ${rule.path}`).filter(
      key => !declared.has(key) && !(key in PENDING),
    );
    expect(dead).toEqual([]);
  });

  test('every rule’s descriptor declares audit.record, so the rule can fire, bar the pending ones named above', async () => {
    const declared = await declaredRoutes();
    const silent = AUDITED_ROUTES.map(rule => `${rule.method} ${rule.path}`).filter(
      key => declared.get(key)?.records === false && !(key in PENDING),
    );
    expect(silent).toEqual([]);
  });

  test('a pending rule is dropped from the list once its route is declared and records', async () => {
    const declared = await declaredRoutes();
    const stillPending = Object.keys(PENDING).filter(key => {
      const route = declared.get(key);
      return route === undefined || !route.records;
    });
    expect(Object.keys(PENDING).filter(key => !stillPending.includes(key))).toEqual([]);
    const rules = new Set(AUDITED_ROUTES.map(rule => `${rule.method} ${rule.path}`));
    expect(Object.keys(PENDING).filter(key => !rules.has(key))).toEqual([]);
  });

  test('no rule is written twice', () => {
    const keys = AUDITED_ROUTES.map(rule => `${rule.method} ${rule.path}`);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });
});

describe('a send or a queue edit is recorded against the ferret it acted on, as today', () => {
  const ferret = 'F12';
  const cases: readonly [string, string, string, string, string][] = [
    ['send retry', 'POST', '/v1/ferrets/:ferretId/sends/:sendId/retry', 'sendId', 'send-retry'],
    ['send cancel', 'POST', '/v1/ferrets/:ferretId/sends/:sendId/cancel', 'sendId', 'send-cancel'],
    ['send enter', 'POST', '/v1/ferrets/:ferretId/sends/:sendId/enter', 'sendId', 'send-enter'],
    ['queue edit', 'PATCH', '/v1/ferrets/:ferretId/queue/:messageId', 'messageId', 'queue-edit'],
    ['queue cancel', 'DELETE', '/v1/ferrets/:ferretId/queue/:messageId', 'messageId', 'queue-cancel'],
  ];
  for (const [name, method, path, other, action] of cases)
    test(`${name} names the ferret as the subject, not ${other}, with its action`, () => {
      const draft = recordedCallDraft(told(method, path, { ferretId: ferret, [other]: 'x9' }));
      expect(draft?.subject).toBe(ferret);
      expect(draft?.detail).toMatchObject({ action });
    });
});
