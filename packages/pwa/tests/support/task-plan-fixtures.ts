/** Fake task plans for the card's tests and screenshots: every plan is parsed by the protocol's own schema. */

import { type TaskPlan, TaskPlanSchema } from '@ferretry/protocol';

export const PLAN_ID = 'c'.repeat(32);
export const SESSION = 'sess-1';
export const RAISED = '2026-08-05T09:58:00.000Z';
export const EXPIRES = '2026-08-05T11:58:00.000Z';
export const STAGE = `tps_${'d'.repeat(24)}`;

export const GITHUB_WORK = 'si_0000000000000001';
export const GITHUB_HOME = 'si_0000000000000002';
const SUDO_BOX = 'si_0000000000000003';
const VERCEL = 'si_0000000000000004';

const site = (domain: string) => ({ kind: 'site' as const, domains: [domain], match: [] });

const candidate = (
  signIn: string,
  label: string,
  username: string,
  domain: string,
  extra: { readonly totp?: boolean; readonly history?: boolean } = {},
) => ({
  signIn,
  account: { id: label, label: label.replace(/_/gu, ' ').toLowerCase() },
  username,
  place: site(domain),
  can: { username: true, password: true, totp: extra.totp ?? false },
  history: extra.history ?? true,
});

/** A page line with two accounts and no preselect: the owner picks. */
export const pickerLine = (line: number) => ({
  kind: 'sign-in' as const,
  line,
  uses: 2,
  why: 'Open the pull request as you',
  state: 'waiting' as const,
  fields: ['username', 'password', 'totp'] as const,
  candidates: [
    candidate(GITHUB_WORK, 'GITHUB_WORK', 'kirin@atomi.cloud', 'github.com', { totp: true }),
    candidate(GITHUB_HOME, 'GITHUB_HOME', 'kirinnee', 'github.com'),
  ],
  flags: [],
});

/** A page line with one account that makes codes, preselected. */
export const codesLine = (line: number) => ({
  kind: 'sign-in' as const,
  line,
  uses: 1,
  why: 'Deploy from the Vercel dashboard',
  state: 'waiting' as const,
  fields: ['username', 'password', 'totp'] as const,
  candidates: [candidate(VERCEL, 'VERCEL', 'deploy@atomi.cloud', 'vercel.com', { totp: true, history: false })],
  preselect: { signIn: VERCEL, why: 'only' as const },
  flags: ['no-history' as const],
});

/** A page line with one account that cannot make codes, though the ferret asked for one. */
export const cannotLine = (line: number) => ({
  kind: 'sign-in' as const,
  line,
  uses: 1,
  why: 'Check the build log',
  state: 'waiting' as const,
  fields: ['username', 'password', 'totp'] as const,
  candidates: [candidate(VERCEL, 'VERCEL', 'deploy@atomi.cloud', 'vercel.com')],
  preselect: { signIn: VERCEL, why: 'only' as const },
  flags: [],
});

/** A page line that asked for no code at all. */
export const passwordOnlyLine = (line: number) => ({
  kind: 'sign-in' as const,
  line,
  uses: 1,
  why: 'Read the dashboard',
  state: 'waiting' as const,
  fields: ['username', 'password'] as const,
  candidates: [candidate(VERCEL, 'VERCEL', 'deploy@atomi.cloud', 'vercel.com', { totp: true })],
  preselect: { signIn: VERCEL, why: 'ferret' as const },
  flags: [],
});

/** A `sudo` line: the red root line. */
export const sudoLine = (line: number) => ({
  kind: 'terminal-sign-in' as const,
  line,
  uses: 1,
  why: 'Restart the build agent',
  state: 'waiting' as const,
  fields: ['password'] as const,
  candidates: [
    {
      signIn: SUDO_BOX,
      account: { id: 'SUDO_KIRIN_BOX', label: 'sudo kirin-box' },
      username: 'kirin',
      place: { kind: 'terminal' as const, tool: 'sudo', host: 'kirin-box' },
      can: { username: false, password: true, totp: false },
      history: true,
    },
  ],
  preselect: { signIn: SUDO_BOX, why: 'only' as const },
  flags: ['root' as const],
});

const pasteLine = (line: number) => ({
  kind: 'paste' as const,
  line,
  uses: 1,
  why: 'The production deploy token',
  state: 'waiting' as const,
  from: { kind: 'command' as const, program: 'vercel' },
  to: { kind: 'terminal' as const, program: 'vercel' },
});

export const planOf = (parts: Partial<Omit<TaskPlan, 'lines'>> & { readonly lines: readonly object[] }): TaskPlan =>
  TaskPlanSchema.parse({
    v: 1,
    id: PLAN_ID,
    sessionId: SESSION,
    agendaItemId: 'A8',
    state: 'pending',
    raisedAt: RAISED,
    expiresAt: EXPIRES,
    ...parts,
  });

/** The mixed plan: a picker, a code account, a sudo line and a paste. */
export const mixedPlan = (): TaskPlan => planOf({ lines: [pickerLine(0), codesLine(1), sudoLine(2), pasteLine(3)] });

export const approvedPlan = (): TaskPlan => {
  const approvedLine = (line: ReturnType<typeof pickerLine>) => ({
    ...line,
    state: 'approved' as const,
    approved: { signIn: GITHUB_WORK, totp: true, remaining: 1, lastUsedAt: '2026-08-05T10:20:00.000Z' },
  });
  return planOf({
    state: 'approved',
    answered: { at: '2026-08-05T10:02:00.000Z', by: { kind: 'device', deviceId: 'phone-1' }, proof: 'passkey' },
    lines: [
      approvedLine(pickerLine(0)),
      { ...codesLine(1), state: 'declined' },
      { ...sudoLine(2), state: 'declined' },
      { ...pasteLine(3), state: 'approved', remaining: 1 },
    ],
  });
};
