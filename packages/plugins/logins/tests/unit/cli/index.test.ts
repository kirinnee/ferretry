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

  it('should add a provider login end to end: the key typed hidden goes to the Vault and only its reference to the login', async () => {
    const SENTINEL = 'SENTINEL-sk-end-to-end';
    const preset = {
      id: 'zai-glm',
      label: 'Z.ai GLM',
      harness: 'claude-code',
      summary: 'x',
      docs: 'https://docs.example.test',
      origin: 'built-in',
      variables: [
        {
          name: 'ANTHROPIC_AUTH_TOKEN',
          kind: 'secret',
          secret: 'ZAI_API_KEY',
          required: true,
          allowEmpty: false,
          harnesses: ['claude-code'],
        },
      ],
      models: [],
      test: { available: true, spends: 'nothing', note: 'Free.' },
      quota: { source: 'none', note: 'n/a' },
      unverified: [],
      verified: '2026-10-16',
      offered: { available: true },
      halves: [{ harness: 'claude-code', offered: { available: true }, models: [] }],
    };
    const staged = {
      id: 'chg1',
      change: { kind: 'login.enable', id: 'work' },
      summary: 'Add',
      consequences: [],
      expiresAt: LATER,
      state: 'pending',
    };
    const asked: string[] = [];
    const { ctx, out, err, calls } = context(
      {
        [GRANTS_ROUTE]: OPEN,
        [ROUTES.presets]: { presets: [preset] },
        [ROUTES.logins]: loginList(),
        'GET /v1/secrets': { v: 1, health: 'ready', secrets: [], references: [] },
        'POST /v1/secrets': { name: 'ZAI_API_KEY', createdAt: AT, updatedAt: AT },
        [ROUTES.stage]: staged,
        [ROUTES.apply]: { outcome: 'applied' },
      },
      {
        promptHidden: async question => {
          asked.push(question);
          return SENTINEL;
        },
      },
    );

    const code = await cli.build?.(ctx).verbs['login add']({ args: ['zai-glm'], options: { yes: true } });

    should(code).equal(0);
    should(asked).eql(['ZAI_API_KEY (hidden; press Enter when done): ']);
    const vault = calls.find(call => call.route === 'POST /v1/secrets');
    should(vault?.init).eql({ body: { name: 'ZAI_API_KEY', value: SENTINEL } });
    should(calls.find(call => call.route === ROUTES.stage)?.init).match({
      body: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' } },
    });
    // The value reached the Vault call and nothing else a person, a pipe or a file could see.
    const elsewhere = JSON.stringify([out, err, asked, calls.filter(call => call !== vault)]);
    should(elsewhere).not.containEql(SENTINEL);
  });

  describe('when the Vault refuses the secret', () => {
    const SENTINEL = 'SENTINEL-sk-vault-refuses';
    const SECOND = 'SENTINEL-sk-second-key';
    const secret = (variable: string, name: string) => ({
      name: variable,
      kind: 'secret',
      secret: name,
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    });
    const preset = {
      id: 'zai-glm',
      label: 'Z.ai GLM',
      harness: 'claude-code',
      summary: 'x',
      docs: 'https://docs.example.test',
      origin: 'built-in',
      variables: [secret('ANTHROPIC_AUTH_TOKEN', 'ZAI_API_KEY'), secret('ZAI_SECOND', 'ZAI_SECOND_KEY')],
      models: [],
      test: { available: true, spends: 'nothing', note: 'Free.' },
      quota: { source: 'none', note: 'n/a' },
      unverified: [],
      verified: '2026-10-16',
      offered: { available: true },
      halves: [{ harness: 'claude-code', offered: { available: true }, models: [] }],
    };
    const staged = {
      id: 'chg1',
      change: { kind: 'login.enable', id: 'work' },
      summary: 'Add',
      consequences: [],
      expiresAt: LATER,
      state: 'pending',
    };

    /** Adds `zai-glm` with a Vault that takes the first `accepting` secrets and refuses the rest like `ownerOnly` does. */
    const addWhileRefused = async (accepting: number, echo = false) => {
      const answers = {
        [GRANTS_ROUTE]: OPEN,
        [ROUTES.presets]: { presets: [preset] },
        [ROUTES.logins]: loginList(),
        'GET /v1/secrets': { v: 1, health: 'ready', secrets: [], references: [] },
        'POST /v1/secrets': { name: 'ZAI_API_KEY', createdAt: AT, updatedAt: AT },
        [ROUTES.stage]: staged,
        [ROUTES.apply]: { outcome: 'applied' },
      };
      const typed = [SENTINEL, SECOND];
      const asked: string[] = [];
      const base = context(answers, {
        promptHidden: async question => {
          asked.push(question);
          return typed.shift();
        },
      });
      let puts = 0;
      const inner = base.ctx.client.call;
      const client: PluginClient = {
        ...base.ctx.client,
        call: async <Answer>(route: string, init?: Parameters<PluginClient['call']>[1]): Promise<Answer> => {
          if (route !== 'POST /v1/secrets') return inner<Answer>(route, init);
          puts += 1;
          if (puts <= accepting) return inner<Answer>(route, init);
          base.calls.push({ route, init });
          const body = init as { body: { value: string } };
          throw Object.assign(
            new Error(
              echo
                ? `only the owner may set a secret (${body.body.value})`
                : 'a governed device may not set or replace a secret.',
            ),
            { status: 403, code: 'ownerOnly' },
          );
        },
      };
      const code = await cli
        .build?.({ ...base.ctx, client })
        .verbs['login add']({ args: ['zai-glm'], options: { yes: true } });
      return { code, asked, ...base };
    };
    const NON_VAULT = (calls: { route: string }[]) => calls.filter(call => call.route !== 'POST /v1/secrets');

    it('should exit 1, stage nothing and show the key nowhere when the first secret is refused', async () => {
      const { code, out, err, asked, calls } = await addWhileRefused(0);

      should(code).equal(1);
      should(err.join('')).containEql('ZAI_API_KEY was not stored: a governed device may not set or replace a secret.');
      should(err.join('')).containEql('The login was not added.');
      should(calls.map(call => call.route)).not.containEql(ROUTES.stage);
      should(calls.map(call => call.route)).not.containEql(ROUTES.apply);
      // Only the one refused write was tried: the second secret was never asked for.
      should(calls.filter(call => call.route === 'POST /v1/secrets')).have.length(1);
      should(asked).eql(['ZAI_API_KEY (hidden; press Enter when done): ']);
      should(JSON.stringify([out, err, asked, NON_VAULT(calls)])).not.containEql('SENTINEL');
    });

    it('should do the same when the SECOND secret is refused after the first was stored, naming what stays', async () => {
      const { code, out, err, asked, calls } = await addWhileRefused(1);

      should(code).equal(1);
      should(err.join('')).containEql(
        'ZAI_SECOND_KEY was not stored: a governed device may not set or replace a secret.',
      );
      should(err.join('')).containEql('ZAI_API_KEY was stored before it and stays in the Vault.');
      should(calls.map(call => call.route)).not.containEql(ROUTES.stage);
      should(calls.filter(call => call.route === 'POST /v1/secrets')).have.length(2);
      should(JSON.stringify([out, err, asked, NON_VAULT(calls)])).not.containEql('SENTINEL');
    });

    it('should take a value out of a refusal that echoes it', async () => {
      const { err } = await addWhileRefused(0, true);

      should(err.join('')).containEql('ZAI_API_KEY was not stored: only the owner may set a secret (…)');
      should(err.join('')).not.containEql('SENTINEL');
    });
  });

  it('should read the shell only through what the manifest declares, and say so when the shell offers no way', async () => {
    const asked: (readonly string[])[] = [];
    const { ctx, err } = context(
      { [GRANTS_ROUTE]: OPEN },
      {
        readEnvironment: names => {
          asked.push(names);
          return { ZAI_API_KEY: 'SENTINEL-shell' };
        },
      },
    );
    const bare = context({ [GRANTS_ROUTE]: OPEN });

    // No preset in the answers: detection runs, finds nothing it can use, and refuses — after reading only declared names.
    const code = await cli
      .build?.({
        ...ctx,
        client: {
          ...ctx.client,
          call: async <A>(route: string) => (route === ROUTES.presets ? ({ presets: [] } as A) : (OPEN as A)),
        },
      })
      .verbs['login add']({ args: [], options: { 'from-env': true } });
    const refused = await cli.build?.(bare.ctx).verbs['login add']({ args: [], options: { 'from-env': true } });

    should(code).equal(1);
    should(asked).eql([manifest.permissions.cliEnvReads]);
    should(err.join('')).not.containEql('SENTINEL');
    should(refused).equal(1);
    should(bare.err.join('')).match(/cannot read your shell's variables/u);
  });

  it('should print what a change saves and which runtimes it lands on, as v4 did', async () => {
    const staged = {
      id: 'chg1',
      change: { kind: 'login.disable', id: 'work' },
      summary: 'Disable login work',
      consequences: ['Nothing running is stopped.'],
      saves: ['logins/work.yaml'],
      runtimes: [
        { name: 'alpha', harness: 'claude-code', launch: { available: true } },
        {
          name: 'beta',
          harness: 'codex',
          launch: { available: false, reason: 'its login "work" is disabled. Use "gamma" instead' },
        },
        { name: 'gamma' },
        { name: 'delta', launch: { available: true } },
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
    should(out.join('')).match(/ {2}alpha \(Claude Code\) — ready to launch\n/);
    should(out.join('')).match(/ {2}beta \(Codex\) — its login "work" is disabled\. Use "gamma" instead\n/);
    should(out.join('')).match(/ {2}gamma\n/);
    should(out.join('')).match(/ {2}delta — ready to launch\n/);
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
