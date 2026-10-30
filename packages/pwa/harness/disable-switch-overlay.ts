/** Switches a few rows of the harness catalogue off, for the disable-switch screenshots only (docs/disabling.md). */
const OFF_UNTIL = `${new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
const LOGIN_OFF = 'Org monthly spend limit reached';
const HELD = { available: false, reason: `login claude-work is disabled (${LOGIN_OFF}).` };

type Row = Record<string, unknown> & { id?: string; name?: string };
export const overlay = (path: string, answer: unknown): unknown => {
  if (path === '/v1/fleet/credentials') {
    const list = answer as { credentials: Row[] };
    return {
      ...list,
      credentials: list.credentials.map(row =>
        row.id === 'claude-work' ? { ...row, disabled: { reason: LOGIN_OFF, until: OFF_UNTIL, source: 'login' } } : row,
      ),
    };
  }
  if (path === '/v1/fleet/runtimes') {
    const list = answer as { runtimes: Row[] };
    return {
      ...list,
      runtimes: list.runtimes.map(row => {
        if (row.name === 'claude-default') {
          return {
            ...row,
            disabled: { reason: 'Keeping the personal quota for Friday', until: OFF_UNTIL, source: 'runtime' },
            launch: { available: false, reason: 'claude-default is disabled (Keeping the personal quota for Friday).' },
          };
        }
        if (row.name === 'claude-review' || row.name === 'claude-work') {
          return { ...row, disabled: { reason: LOGIN_OFF, until: OFF_UNTIL, source: 'login' }, launch: HELD };
        }
        return row;
      }),
    };
  }
  return answer;
};
