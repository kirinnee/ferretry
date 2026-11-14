import { describe, it } from 'bun:test';
import type { CliContext, PluginClient, TerminalIo } from '@ferretry/kernel/manifest';
import should from 'should';
import cli from '../../../cli/index.ts';
import { GRANTS_ROUTE } from '../../../cli/lib/authority.ts';
import { ROUTES } from '../../../cli/lib/gateway.ts';
import manifest from '../../../manifest.ts';
import { AT, flow, LATER, login, loginList } from './fakes.ts';

const declaredVerbs = manifest.actions.cli.map(declared => declared.verb);

const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };

const clock = { now: () => AT as never, nowMs: () => Date.parse(AT) };

function context(answers: Record<string, unknown> = {}, extra: Partial<CliContext<typeof manifest>> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { route: string; init: unknown }[] = [];
  const io: TerminalIo = { out: text => out.push(text), err: text => err.push(text), isTty: false };
  const client: PluginClient = {
    call: async <Answer>(route: string, init?: unknown): Promise<Answer> => {
      calls.push({ route, init });
      if (!(route in answers)) throw new Error(`no answer for ${route}`);
      return answers[route] as Answer;
    },
    subscribe: () => () => undefined,
  };
  const ctx: CliContext<typeof manifest> = { manifest, client, io, clock, ...extra };
  return { ctx, out, err, calls };
}

describe('the logins cli half', () => {
  it('should have a handler for every verb the manifest declares, under its exact verb string', () => {
    const half = cli.build?.(context().ctx);
    should(Object.keys(half?.verbs ?? {}).sort()).eql([...declaredVerbs].sort());
  });

  it('should not be the skeleton', () => {
    should((cli as { skeleton?: true }).skeleton).be.undefined();
  });

  it('should offer no verb that takes a token or a key on its command line', () => {
    // --with-access-token and --with-api-key stay host-and-CLI-only: they are the host `claude`/`codex` commands.
    should(JSON.stringify(manifest.actions.cli)).not.match(/with-access-token|with-api-key/);
  });

  it('should print the login list through the terminal, parsing the daemon answer, and exit 0', async () => {
    const { ctx, out, calls } = context({ [ROUTES.logins]: loginList(login()) });
    const code = await cli.build?.(ctx).verbs['login ls']({ args: [], options: {} });
    should(code).equal(0);
    should(calls.map(call => call.route)).eql(['GET /v1/logins', 'GET /v1/usage/budgets']);
    should(out.join('')).match(/Logins on box:/);
  });

  it('should refuse an answer that carries a field the contract does not name', async () => {
    const { ctx } = context({ [ROUTES.logins]: { ...loginList(login()), accessToken: 'x' } });
    await should(cli.build?.(ctx).verbs['login ls']({ args: [], options: {} }) as Promise<number>).be.rejected();
  });

  it('should start a sign-in by login id and route key, then finish when the daemon says so', async () => {
    const { ctx, out, calls } = context({ [GRANTS_ROUTE]: OPEN, [ROUTES.signInStart]: flow({ state: 'complete' }) });
    const code = await cli.build?.(ctx).verbs['login signin']({ args: ['claude-you'], options: { force: true } });
    should(code).equal(0);
    should(calls[1]).match({
      route: 'POST /v1/logins/sign-in',
      init: { body: { loginId: 'claude-you', restart: true } },
    });
    should(out.join('')).match(/Signed in\. claude-you is ready to use\./);
  });

  it('should refuse a Claude sign-in off a terminal in words, with exit 1 and the flow stopped', async () => {
    const { ctx, err, calls } = context({
      [GRANTS_ROUTE]: OPEN,
      [ROUTES.signInStart]: flow({ state: 'awaiting-code', verificationUrl: 'https://claude.ai/oauth/authorize?x=1' }),
      [ROUTES.signInCancel]: flow({ state: 'failed', reason: 'stopped', remedy: 'again' }),
    });
    const code = await cli.build?.(ctx).verbs['login signin']({ args: ['claude-you'], options: {} });
    should(code).equal(1);
    should(err.join('')).match(/needs a person to paste a code/);
    should(calls.map(call => call.route)).eql([
      'GET /v1/grants',
      'POST /v1/logins/sign-in',
      'DELETE /v1/logins/sign-in/:flowId',
    ]);
  });

  it('should stage and apply a login change at Logins’ own routes, after the grants say this caller may', async () => {
    const staged = {
      id: 'chg1',
      change: { kind: 'login.enable', id: 'work' },
      summary: 'Enable login work',
      consequences: [],
      expiresAt: LATER,
      state: 'pending',
    };
    const { ctx, out, calls } = context({
      [GRANTS_ROUTE]: OPEN,
      [ROUTES.stage]: staged,
      [ROUTES.apply]: { outcome: 'applied' },
    });

    const code = await cli.build?.(ctx).verbs['login enable']({ args: ['work'], options: {} });

    should(code).equal(0);
    should(calls.map(call => call.route)).eql([
      'GET /v1/grants',
      'POST /v1/logins/changes',
      'POST /v1/logins/changes/:changeId/apply',
    ]);
    should(calls[1]?.init).match({ body: { kind: 'login.enable', id: 'work' } });
    should(calls[2]?.init).match({ params: { changeId: 'chg1' } });
    should(out.join('')).match(/Done\./);
  });

  it('should print what a change saves and which runtimes it lands on, as v4 did', async () => {
    const staged = {
      id: 'chg1',
      change: { kind: 'login.disable', id: 'work' },
      summary: 'Disable login work',
      consequences: ['Nothing running is stopped.'],
      saves: ['logins/work.yaml'],
      runtimes: [
        { name: 'alpha', harness: 'claude-code', agent: true, launch: { available: true } },
        {
          name: 'beta',
          harness: 'codex',
          agent: false,
          launch: { available: false, reason: 'its login "work" is disabled. Use "gamma" instead' },
        },
        { name: 'gamma' },
      ],
      expiresAt: LATER,
      state: 'pending',
    };
    const { ctx, out } = context({
      [GRANTS_ROUTE]: OPEN,
      [ROUTES.stage]: staged,
      [ROUTES.apply]: { outcome: 'applied' },
    });

    await cli.build?.(ctx).verbs['login disable']({ args: ['work'], options: {} });

    should(out.join('')).match(/Saves:\n {2}logins\/work\.yaml\nRuntimes after this change:\n/);
    should(out.join('')).match(/ {2}alpha \(Claude Code, agent\) — ready to launch\n/);
    should(out.join('')).match(/ {2}beta \(Codex\) — its login "work" is disabled\. Use "gamma" instead\n/);
    should(out.join('')).match(/ {2}gamma\n/);
  });

  it('should change nothing for a caller the grants refuse, and exit 1 with the sentence', async () => {
    const { ctx, err, calls } = context({
      [GRANTS_ROUTE]: {
        capabilities: [{ capability: 'fleet', use: true, configure: false, configureRefusal: 'not-granted' }],
      },
    });

    for (const verb of [
      'login add',
      'login signout',
      'login disable',
      'login enable',
      'login label',
      'login rm',
    ] as const) {
      should(await cli.build?.(ctx).verbs[verb]({ args: ['claude', 'x'], options: {} })).equal(1);
    }

    should(err.join('')).match(/the operator has not granted it/);
    should(calls.every(call => call.route === 'GET /v1/grants')).be.true();
  });
});

describe('the logins cli half without a timer', () => {
  it('should refuse to wait on a sign-in in words rather than poll in a loop, and exit 1', async () => {
    const { ctx, err } = context({
      [GRANTS_ROUTE]: OPEN,
      [ROUTES.signInStart]: flow({
        harness: 'codex',
        state: 'awaiting-approval',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
      }),
    });
    const code = await cli.build?.(ctx).verbs['login signin']({ args: ['codex-you'], options: {} });
    should(code).equal(1);
    should(err.join('')).match(/no timer/);
  });
});
