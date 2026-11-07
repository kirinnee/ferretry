/** Fake accounts, sign-ins and the daemon's answers for the Accounts screen's tests and screenshots. No real account or daemon. */

import { type AccountList, AccountListSchema, type TwoFactorStageId } from '../../../contract/routes/index.ts';

const AT = '2026-10-31T10:00:00.000Z';
export const SI_GITHUB = 'si_0000000000000001';
export const SI_WORK = 'si_0000000000000002';
export const SI_VERCEL = 'si_0000000000000003';
export const SMS = 'tf_000000000001';
export const APP = 'tf_000000000002';
export const PROPOSAL = 'rp_0123456789abcdef';
export const STAGE = `st_${'a'.repeat(24)}` as TwoFactorStageId;
export const KEY = 'otpauth://totp/GitHub:kirinnee?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
const PARAMS = { algorithm: 'SHA1', digits: 6, period: 30 };
export const SECRET_PASSWORD = 'correct-horse-battery';

const sms = {
  id: SMS,
  kind: 'sms',
  label: 'Phone',
  endsWith: '42',
  addedAt: AT,
  addedBy: 'owner',
  automatic: false,
};
const app = {
  id: APP,
  kind: 'totp',
  label: 'Authenticator app',
  params: PARAMS,
  addedAt: AT,
  addedBy: 'owner',
  automatic: true,
  verified: { worked: true, at: AT },
};

const account = (id: string, label: string, over: object = {}) => ({
  id,
  label,
  fields: { password: true },
  factors: [],
  signIns: [],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

export const list = (over: { health?: 'ready' | 'damaged'; diagnosis?: string } = {}): AccountList =>
  AccountListSchema.parse({
    v: 1,
    health: over.health ?? 'ready',
    ...(over.diagnosis === undefined ? {} : { diagnosis: over.diagnosis }),
    accounts: [
      account('GITHUB', 'GitHub', {
        username: 'kirinnee',
        fields: { password: true },
        factors: [sms, app],
        signIns: [SI_GITHUB],
      }),
      account('GITHUB_WORK', 'GitHub (work)', { username: 'kirin@work.test', signIns: [SI_WORK] }),
      account('VERCEL', 'Vercel', { fields: { password: false }, signIns: [SI_VERCEL] }),
      account('GOOGLE', 'Google'),
    ],
    signIns: [
      {
        id: SI_GITHUB,
        account: 'GITHUB',
        place: { kind: 'site', domains: ['github.com'], match: [] },
        method: { kind: 'password' },
        recipe: '# Sign in\n<script>alert(1)</script>\nClick **Sign in**.',
        recipeVersion: 2,
        recipeBy: 'ferret',
        autoApplyRecipe: false,
        observed: [
          {
            at: 'github.com',
            surface: 'page',
            identity: '0123456789abcdef',
            since: AT,
            masked: { value: true, observedAt: AT, count: 3 },
            secondFactor: { value: 'code', observedAt: AT, count: 2 },
          },
        ],
        proposals: [
          {
            id: PROPOSAL,
            recipe: 'Open the page, press Sign in, type the code.',
            base: '# Sign in',
            why: 'The button moved',
            sessionId: 'sess-1',
            proposedAt: AT,
          },
        ],
        createdAt: AT,
        updatedAt: AT,
      },
      {
        id: SI_WORK,
        account: 'GITHUB_WORK',
        place: { kind: 'site', domains: ['github.com'], match: [] },
        method: { kind: 'password' },
        createdAt: AT,
        updatedAt: AT,
      },
      {
        id: SI_VERCEL,
        account: 'VERCEL',
        place: { kind: 'site', domains: ['vercel.com'], match: ['app.vercel.com'] },
        method: { kind: 'sso', name: 'Google', via: 'GOOGLE' },
        via: { account: { id: 'GOOGLE', label: 'Google' } },
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  });
