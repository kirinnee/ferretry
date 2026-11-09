/**
 * A task-plan world for the mounts' tests: a real TaskPlanService over a real PasteRuleService. Only the ports are
 * fakes: the agenda card, the accounts listing, the passkey registry and the clock.
 */
import type {
  AccountId,
  AccountKey,
  AccountSummary,
  SignInId,
  SignInSummary,
  TaskPlanStageId,
} from '../../../../contract/routes/index.ts';
import { PasteRuleService } from '../../../../daemon/lib/secure-copy/rules.ts';
import { TaskPlanService } from '../../../../daemon/lib/task-plans/service.ts';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
export const SESSION = 's1';
const GITHUB: SignInId = 'si_00000000000000a1';
const KEY: AccountKey = `L${'A'.repeat(24)}`;
const T = '2026-10-01T00:00:00.000Z';

export const SIGN_IN_LINE = { kind: 'sign-in', signIn: GITHUB, fields: ['username', 'password'], why: 'check Actions' };
const GH = { kind: 'command', program: 'gh' } as const;
export const TERMINAL_PASTE = {
  kind: 'paste',
  from: GH,
  to: { kind: 'terminal', program: 'vercel' },
  why: 'the deploy',
};
export const PAGE_PASTE = {
  kind: 'paste',
  from: GH,
  to: { kind: 'browser', origin: 'https://vercel.com' },
  why: 'the token field',
};
export const STORE_PASTE = {
  kind: 'paste',
  from: GH,
  to: { kind: 'secret', name: 'DEPLOY_TOKEN' },
  why: 'keep it',
};

export const HOST = { kind: 'owner', actor: { kind: 'host' } } as const;
export const PHONE = { kind: 'owner', actor: { kind: 'device', deviceId: 'phone-1' } } as const;

export function planWorld() {
  const state = { stage: 0, plan: 0, closed: [] as string[] };
  const rules = new PasteRuleService({
    store: { read: async () => undefined, write: async () => undefined },
    clock: { now: () => NOW },
    ids: { ruleId: () => '1'.padStart(32, '0') },
    warn: () => undefined,
  });
  const plans = new TaskPlanService({
    agenda: {
      raise: async () => ({ ok: true as const, id: 'A1' }),
      close: async (_sessionId, id, note) => void state.closed.push(`${id}: ${note}`),
    },
    rules,
    accounts: {
      listing: async () => ({
        accounts: [
          {
            id: 'GITHUB_WORK' as AccountId,
            label: 'GitHub work',
            username: 'kirin-work',
            fields: { password: true },
            factors: [],
            signIns: [],
            createdAt: T,
            updatedAt: T,
          } as unknown as AccountSummary,
        ],
        signIns: [
          {
            id: GITHUB,
            account: 'GITHUB_WORK' as AccountId,
            place: { kind: 'site', domains: ['github.com'], match: [] },
            method: { kind: 'password' },
            createdAt: T,
            updatedAt: T,
          } as unknown as SignInSummary,
        ],
      }),
      keyOf: async () => KEY,
    },
    choice: { of: async () => ({}) },
    passkeys: { any: async () => true },
    redact: async text => text,
    tell: async () => undefined,
    audit: { record: async () => undefined },
    clock: { now: () => NOW },
    ids: {
      planId: () => (++state.plan).toString(16).padStart(32, 'b'),
      stageId: (): TaskPlanStageId => `tps_${(++state.stage).toString(16).padStart(24, '0')}`,
    },
  });
  return { plans, rules, state };
}
