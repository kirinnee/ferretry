import { expect, it } from 'bun:test';
import cli from '../../../cli/index.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { AccountSummarySchema, SignInSummarySchema } from '../../../contract/routes/index.ts';

const SI = 'si_0000000000000001';
const RP = 'rp_0000000000000001';
const AT = '2026-11-01T12:00:00.000Z';
const signIn = SignInSummarySchema.parse({
  id: SI,
  account: 'REVIEW',
  place: { kind: 'site', domains: ['example.com'], match: [] },
  method: { kind: 'password' },
  recipe: 'Original steps',
  createdAt: AT,
  updatedAt: AT,
});
const account = AccountSummarySchema.parse({
  id: 'REVIEW',
  label: 'Review',
  fields: { password: true },
  factors: [],
  signIns: [SI],
  createdAt: AT,
  updatedAt: AT,
});

for (const operation of ['show', 'set', 'clear', 'approve', 'decline'] as const) {
  it(`account site recipe ${operation} succeeds through the real CLI controller and gateway`, async () => {
    const file = '/recipe-test-only/steps.md';
    const calls: { route: string; init?: unknown }[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const client = {
      call: async (route: string, init?: { body?: unknown }) => {
        calls.push({ route, init });
        if (route === 'GET /v1/accounts') return { v: 1, health: 'ready', accounts: [account], signIns: [signIn] };
        if (route === 'PUT /v1/accounts/sign-ins/:signIn')
          return { ...signIn, recipe: operation === 'clear' ? undefined : 'New steps' };
        if (route === 'POST /v1/accounts/sign-ins/:signIn/recipe/proposals/:proposalId')
          return { ...signIn, recipe: 'New steps' };
        throw new Error('unexpected route');
      },
    } as unknown as PluginClient;
    const ctx = {
      manifest: cli.manifest,
      client,
      readText: async (path: string) => {
        expect(path).toBe(file);
        return 'New steps';
      },
      io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text), isTty: false },
    };
    const half = cli.build!(ctx);
    const result = await half.verbs[`account site recipe ${operation}`]({
      args: operation === 'approve' || operation === 'decline' ? [SI, RP] : [SI],
      options: operation === 'set' ? { file } : {},
    });
    expect(err).toEqual([]);
    expect(result).toBe(0);
    expect(out.join('')).not.toContain('not built');
    const write = calls.find(call => call.route !== 'GET /v1/accounts');
    if (operation === 'show') {
      expect(write).toBeUndefined();
      expect(out.join('')).toContain('Original steps');
    }
    if (operation === 'set')
      expect(write).toEqual({
        route: 'PUT /v1/accounts/sign-ins/:signIn',
        init: { params: { signIn: SI }, body: { recipe: 'New steps' } },
      });
    if (operation === 'clear')
      expect(write).toEqual({
        route: 'PUT /v1/accounts/sign-ins/:signIn',
        init: { params: { signIn: SI }, body: { recipe: null } },
      });
    if (operation === 'approve' || operation === 'decline')
      expect(write).toEqual({
        route: 'POST /v1/accounts/sign-ins/:signIn/recipe/proposals/:proposalId',
        init: { params: { signIn: SI, proposalId: RP }, body: { decision: operation } },
      });
  });
}

it('I176 recipe writes keep the daemon owner-only refusal and never retry another credential', async () => {
  let calls = 0;
  const errors: string[] = [];
  const error = Object.assign(new Error('owner only'), { name: 'DaemonRefusal', status: 403, code: 'owner_only' });
  const client = {
    call: async () => {
      calls++;
      throw error;
    },
  } as unknown as PluginClient;
  const half = cli.build!({
    manifest: cli.manifest,
    client,
    io: { out: () => undefined, err: text => errors.push(text), isTty: false },
  });
  expect(await half.verbs['account site recipe approve']({ args: [SI, RP], options: {} })).toBe(1);
  expect(calls).toBe(1);
  expect(errors.join('')).toContain('no other credential was tried');
});
