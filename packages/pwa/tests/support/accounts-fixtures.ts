/** Fake accounts, sign-ins and the daemon's answers for the Accounts screen's tests and screenshots. No real account or daemon. */

import { type AccountList, AccountListSchema, type TwoFactorStageId } from '@ferretry/protocol';
import type { Call } from './input-fixtures.ts';

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
  fields: { password: true, totp: false },
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
        fields: { password: true, totp: true },
        factors: [sms, app],
        signIns: [SI_GITHUB],
      }),
      account('GITHUB_WORK', 'GitHub (work)', { username: 'kirin@work.test', signIns: [SI_WORK] }),
      account('VERCEL', 'Vercel', { fields: { password: false, totp: false }, signIns: [SI_VERCEL] }),
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

export const fileOf = (text: string, exists = true, state: 'ok' | 'pending' = 'ok') => ({
  path: 'account-defaults.yaml',
  absolutePath: '/home/kirin/.ferretry/config/account-defaults.yaml',
  kind: 'accountDefaults',
  schema: 'accountDefaults',
  exists,
  text,
  etag: 'e1',
  state,
  issues: [],
});

export interface World {
  readonly accounts?: AccountList;
  readonly groups?: string[][] | 'missing';
  readonly defaults?: string | 'error';
  readonly defaultsState?: 'ok' | 'pending';
  readonly refuse?: (call: Call) => string | undefined;
}

export const answer =
  (world: World) =>
  (call: Call): unknown => {
    const refusal = world.refuse?.(call);
    if (refusal !== undefined) throw new Error(refusal);
    if (call.method === 'GET' && call.path === '/v1/accounts') return world.accounts ?? list();
    if (call.path === '/v1/accounts/look-alike') {
      if (world.groups === 'missing') throw new Error('not found');
      return { v: 1, groups: world.groups ?? [] };
    }
    if (call.path.startsWith('/v1/config/file')) {
      if (world.defaults === 'error') throw new Error('no such route');
      return fileOf(world.defaults ?? '', world.defaults !== undefined, world.defaultsState);
    }
    if (call.path.endsWith('/commit')) return { account: 'GITHUB', factor: app, mismatch: false };
    if (call.path.endsWith('/factors/seed'))
      return {
        stage: STAGE,
        account: 'GITHUB',
        label: 'Authenticator app',
        expiresAt: AT,
        parsed: { params: PARAMS, issuer: 'GitHub', accountName: 'kirinnee' },
      };
    if (call.method === 'DELETE' && call.path.includes('/factors/seed')) return { stage: STAGE, dropped: true };
    if (call.method === 'DELETE' && call.path.includes('/factors/'))
      return { account: 'GITHUB', factor: SMS, removed: true };
    if (call.method === 'DELETE' && call.path.includes('/sign-ins/')) return { id: SI_GITHUB, removed: true };
    if (call.method === 'DELETE') return { id: 'GITHUB', removed: true };
    if (call.path.endsWith('/factors')) return sms;
    if (call.path.endsWith('/sign-ins')) return list().signIns[0];
    if (call.path.endsWith('/merge') || call.path.endsWith('/apart')) return {};
    if (call.path === '/v1/accounts/defaults') return { scope: 'sites', key: 'x', account: null };
    const found = (world.accounts ?? list()).signIns[0];
    if (call.path.includes('/sign-ins/')) return found;
    return (world.accounts ?? list()).accounts[0];
  };
