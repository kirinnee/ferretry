/**
 * Fake spend budgets on three harness logins (docs/budgets.md), for the budget screenshots only:
 * one login within every budget, one over its trigger, one over its hard limit — plus the
 * configuration-file answers an edited budget reads and writes, so the editor can be walked for
 * real: machine.yaml with no zone yet, the personal login's file with its budget, and a write that
 * LOOSENS held for the owner. Nothing here is a real login, amount or zone.
 */

const DIRECTORY = '/home/ernest/.ferretry/config';

const period = (fields: Record<string, unknown>): Record<string, unknown> => ({
  spentUsd: 0,
  level: 'ok',
  startsAt: '2026-10-13T04:00:00.000Z',
  resetsAt: '2026-10-14T04:00:00.000Z',
  ...fields,
});

const BUDGETS: Readonly<Record<string, unknown>> = {
  'claude-personal': {
    timeZone: 'America/New_York',
    timeZoneSet: true,
    daily: period({ trigger: 40, hard: 60, spentUsd: 12.4 }),
    weekly: period({ trigger: 200, hard: 300, spentUsd: 150.01, resetsAt: '2026-10-19T04:00:00.000Z' }),
    level: 'ok',
    unpriced: 0,
    measured: true,
  },
  'claude-work': {
    timeZone: 'America/New_York',
    timeZoneSet: true,
    daily: period({ trigger: 25, hard: 40, spentUsd: 27.5, level: 'over_trigger' }),
    weekly: period({ trigger: 150, hard: 220, spentUsd: 96.2, resetsAt: '2026-10-19T04:00:00.000Z' }),
    level: 'over_trigger',
    unpriced: 1,
    measured: true,
  },
  codex: {
    timeZone: 'UTC',
    timeZoneSet: false,
    weekly: period({
      trigger: 90,
      hard: 120,
      spentUsd: 141.75,
      level: 'over_hard',
      resetsAt: '2026-10-19T00:00:00.000Z',
    }),
    level: 'over_hard',
    unpriced: 0,
    measured: false,
  },
};

const LOGIN_TEXT = [
  '# the personal account',
  'label: personal',
  'budget:',
  '  daily:',
  '    trigger: 40',
  '    hard: 60',
  '  weekly:',
  '    trigger: 200',
  '    hard: 300',
  '',
].join('\n');

type Row = Record<string, unknown> & { id?: string };

/** Adds the fake budgets to the harness catalogue's login list. */
export const overlay = (path: string, answer: unknown): unknown => {
  if (path !== '/v1/fleet/credentials') return answer;
  const list = answer as { credentials: Row[] };
  return {
    ...list,
    credentials: list.credentials.map(row =>
      row.id !== undefined && row.id in BUDGETS ? { ...row, budget: BUDGETS[row.id] } : row,
    ),
  };
};

const fileView = (fields: Record<string, unknown>): Record<string, unknown> => ({
  exists: true,
  state: 'ok',
  issues: [],
  ...fields,
});

/**
 * The configuration-file answers the editor makes: reads of machine.yaml and the login's file, writes
 * that apply when they tighten and are HELD when they loosen (the demo raises the daily hard limit to
 * 90), and a confirmation that lands.
 */
export const configAnswer = (path: string, init?: RequestInit): unknown => {
  const method = init?.method ?? 'GET';
  if (method === 'GET' && path.startsWith('/v1/config/file?')) {
    const file = new URLSearchParams(path.split('?')[1] ?? '').get('path') ?? '';
    if (file === 'machine.yaml')
      return fileView({
        path: file,
        absolutePath: `${DIRECTORY}/machine.yaml`,
        kind: 'machine',
        schema: 'machine',
        text: 'name: studio-mac\n',
        etag: 'etag-machine-1',
      });
    if (file === 'logins/claude-personal.yaml')
      return fileView({
        path: file,
        absolutePath: `${DIRECTORY}/logins/claude-personal.yaml`,
        kind: 'login',
        schema: 'login',
        text: LOGIN_TEXT,
        etag: 'etag-login-1',
      });
    return fileView({
      path: file,
      absolutePath: `${DIRECTORY}/${file}`,
      kind: 'login',
      schema: 'login',
      exists: false,
      text: '',
      etag: 'absent',
    });
  }
  if (method === 'PUT' && path === '/v1/config/file') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string; text?: string };
    if (body.path === 'machine.yaml') return { path: body.path, etag: 'etag-machine-2', outcome: 'applied' };
    // The demo's loosening — the daily hard limit raised to 90 — is written but held.
    if (body.path === 'logins/claude-personal.yaml' && (body.text ?? '').includes('hard: 90'))
      return {
        path: body.path,
        etag: 'etag-login-2',
        outcome: 'pending',
        pending: { path: body.path, etag: 'etag-login-2', changes: ['this login may spend more each day'] },
      };
    return { path: body.path ?? '', etag: 'etag-login-2', outcome: 'applied' };
  }
  if (method === 'POST' && path === '/v1/config/confirm')
    return { path: 'logins/claude-personal.yaml', confirmed: true };
  return undefined;
};
