import { describe, it } from 'bun:test';
import { ACCOUNT_HINT_NEXT, type AccountSummary, AgentToolCallSchema, type SignInSummary } from '@ferretry/protocol';
import should from 'should';
import { actsOn } from '../../../src/lib/agent-tools/service.ts';
import type { AgentToolError } from '../../../src/lib/index.ts';
import { LoginEntryError, RecipeValueError } from '../../../src/lib/secrets/index.ts';
import { agent, agentToolWorld } from './support.ts';

/** `account_propose`: a ferret's suggested recipe for ONE sign-in, which the owner approves. */

const SI_VERCEL = 'si_00000000000000a1';
const PENDING = {
  id: 'rp_0000000000000001',
  login: 'VERCEL',
  signIn: SI_VERCEL,
  state: 'pending',
  agendaItemId: 'A4',
} as const;

describe('account.propose', () => {
  it("should file the ferret's recipe on the sign-in it names and say the card it waits on", async () => {
    const calls: unknown[] = [];
    const world = agentToolWorld({
      recipes: {
        scrubbedAccounts: async listing => listing,
        propose: async (...parameters) => {
          calls.push(parameters);
          return PENDING;
        },
      },
    });

    const result = await world.service.call(agent, {
      tool: 'account.propose',
      signIn: SI_VERCEL,
      recipe: 'Open vercel.com → Continue with Google → [[GOOGLE_KIRIN]]',
      why: 'the first sign-in needed the Google step',
    });

    should(calls).deepEqual([
      [
        's1',
        { signIn: SI_VERCEL },
        'Open vercel.com → Continue with Google → [[GOOGLE_KIRIN]]',
        'the first sign-in needed the Google step',
      ],
    ]);
    // The result keeps the shape an `fy` from before sign-ins reads strictly: the sign-in is in the summary.
    should(result.recipe).deepEqual({
      id: 'rp_0000000000000001',
      login: 'VERCEL',
      state: 'pending',
      agendaItemId: 'A4',
    });
    should(result.summary).containEql('!A4').and.containEql(SI_VERCEL);
    // The audit names the sign-in, never the ferret's text.
    should(JSON.stringify(world.audit)).containEql(SI_VERCEL).and.not.containEql('Continue with Google');
  });

  it('should resolve the older { login } through the SAME path, and audit the sign-in it resolved to', async () => {
    const calls: unknown[] = [];
    const world = agentToolWorld({
      recipes: {
        scrubbedAccounts: async listing => listing,
        propose: async (...parameters) => {
          calls.push(parameters);
          return PENDING;
        },
      },
    });

    await world.service.call(agent, { tool: 'account.propose', login: 'VERCEL', recipe: 'x', why: 'y' });
    // The route parses every call with the one schema: the older name and spelling arrive as account.propose { login }.
    await world.service.call(
      agent,
      AgentToolCallSchema.parse({ tool: 'login.propose', login: 'VERCEL', recipe: 'x', why: 'y' }),
    );

    should(calls).deepEqual([
      ['s1', { login: 'VERCEL' }, 'x', 'y'],
      ['s1', { login: 'VERCEL' }, 'x', 'y'],
    ]);
    const audit = JSON.stringify(world.audit);
    should(audit).containEql(`"signIn":"${SI_VERCEL}"`).and.containEql('"tool":"account.propose"');
    should(audit).not.containEql('login.propose');
  });

  it('should say when the owner let it apply at once', async () => {
    const world = agentToolWorld({
      recipes: {
        scrubbedAccounts: async listing => listing,
        propose: async () => ({ id: 'rp_0000000000000001', login: 'VERCEL', signIn: SI_VERCEL, state: 'applied' }),
      },
    });
    const result = await world.service.call(agent, {
      tool: 'account.propose',
      signIn: SI_VERCEL,
      recipe: 'x',
      why: 'y',
    });
    should(result.summary).containEql('was updated').and.containEql('this sign-in');
  });

  it('should refuse an unknown sign-in or login, a recipe holding a value, and a daemon without recipes', async () => {
    const refusing = (error: Error) =>
      agentToolWorld({
        recipes: { scrubbedAccounts: async listing => listing, propose: async () => await Promise.reject(error) },
      });
    const call = { tool: 'account.propose', login: 'VERCEL', recipe: 'x', why: 'y' } as const;
    const unknown = (await refusing(new LoginEntryError('unknown_login', 'there is no saved login VERCEL'))
      .service.call(agent, call)
      .catch((caught: unknown) => caught)) as AgentToolError;
    should(unknown.code).equal('not_found');
    const noSignIn = (await refusing(new LoginEntryError('unknown_sign_in', `there is no sign-in ${SI_VERCEL}`))
      .service.call(agent, { ...call, login: undefined, signIn: SI_VERCEL })
      .catch((caught: unknown) => caught)) as AgentToolError;
    should(noSignIn.code).equal('not_found');
    const several = (await refusing(
      new LoginEntryError('account_has_sign_ins', 'name the sign-in: Vercel signs in at 2 places'),
    )
      .service.call(agent, call)
      .catch((caught: unknown) => caught)) as AgentToolError;
    should(several.code).equal('bad_request');
    should(several.message).containEql('name the sign-in');
    const holding = (await refusing(new RecipeValueError('a recipe never holds a value'))
      .service.call(agent, call)
      .catch((caught: unknown) => caught)) as AgentToolError;
    should(holding.code).equal('bad_request');
    const none = (await agentToolWorld()
      .service.call(agent, call)
      .catch((caught: unknown) => caught)) as AgentToolError;
    should(none.code).equal('unavailable');
    const broken = (await refusing(new Error('disk full'))
      .service.call(agent, call)
      .catch((caught: unknown) => caught)) as AgentToolError;
    should(broken.code).equal('unavailable');
    should(broken.message).not.containEql('disk full');
  });

  it('should refuse a standing-rule suggestion whole until the daemon takes them, filing no recipe either', async () => {
    // Arrange — a recipe store that records every proposal it is handed
    const filed: string[] = [];
    const world = agentToolWorld({
      recipes: {
        scrubbedAccounts: async listing => listing,
        propose: async (_session, _target, recipe) => {
          filed.push(recipe);
          return await Promise.reject(new Error('never reached'));
        },
      },
    });
    const refused = async (call: unknown): Promise<AgentToolError> =>
      (await world.service.call(agent, call as never).catch((caught: unknown) => caught)) as AgentToolError;

    // Act
    const alone = await refused({ tool: 'account.propose', signIn: SI_VERCEL, preapprove: true, why: 'y' });
    const beside = await refused({
      tool: 'account.propose',
      signIn: SI_VERCEL,
      preapprove: true,
      recipe: 'x',
      why: 'y',
    });

    // Assert — fails closed: no card, no recipe filed, and the ferret is told to send a recipe only
    should([alone.code, beside.code]).deepEqual(['unavailable', 'unavailable']);
    should(alone.message).containEql('standing-rule');
    should(filed).deepEqual([]);
  });
});

describe('a ferret driving a surface', () => {
  it('should be told to the login observer before every call that may change a surface, and never for a read', async () => {
    const acted: unknown[] = [];
    const world = agentToolWorld({
      loginActs: { acted: (sessionId, kind, script) => void acted.push([sessionId, kind, script]) },
    });
    await world.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.google.com/' });
    await world.service.call(agent, { tool: 'browser.navigate', name: 'app', url: 'https://vercel.com/' });
    await world.service.call(agent, { tool: 'browser.read', name: 'app' });
    await world.service.call(agent, { tool: 'browser.close', name: 'app' }).catch(() => undefined);
    await world.service.call(agent, { tool: 'account.hint', site: 'vercel.com' }).catch(() => undefined);
    await world.service.call(agent, { tool: 'terminal.list' });
    should(acted).deepEqual([
      ['s1', 'browser', false],
      ['s1', 'browser', false],
      ['s1', 'browser', false],
    ]);
  });

  it('should name the surface a paste changes, and mark a page script', () => {
    should(
      actsOn({ tool: 'secure.paste', handle: 'c1', to: { kind: 'terminal', name: 'dev' }, prompt: 'p' } as never),
    ).equal('terminal');
    should(
      actsOn({ tool: 'secure.paste', handle: 'c1', to: { kind: 'secret', name: 'X' }, prompt: 'p' } as never),
    ).be.undefined();
    should(actsOn({ tool: 'terminal.send', name: 'dev', text: 'clear' } as never)).equal('terminal');
    should(actsOn({ tool: 'browser.dialog', name: 'app', accept: true } as never)).equal('browser');
    should(actsOn({ tool: 'input.wait', id: 'A1' } as never)).be.undefined();
    should(actsOn({ tool: 'browser.tabs', action: 'list' } as never)).be.undefined();
    should(actsOn({ tool: 'browser.tabs', action: 'adopt', id: 'p2', as: 'pop' } as never)).equal('browser');
  });

  it('should say a page script ran', async () => {
    const acted: unknown[] = [];
    const world = agentToolWorld({
      loginActs: { acted: (sessionId, kind, script) => void acted.push([sessionId, kind, script]) },
    });
    await world.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' }).catch(() => undefined);
    should(acted).deepEqual([['s1', 'browser', true]]);
  });
});

describe('account.hint, one line per sign-in', () => {
  const AT = '2026-10-31T09:00:00.000Z';
  const account = (id: string, label: string, extra: Partial<AccountSummary> = {}): AccountSummary => ({
    id,
    label,
    fields: { password: true, totp: false },
    factors: [],
    signIns: [],
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  });
  const site = (id: string, owner: string, domains: string[], extra: Partial<SignInSummary> = {}): SignInSummary => ({
    id,
    account: owner,
    place: { kind: 'site', domains, match: domains },
    method: { kind: 'password' },
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  });
  const LISTING = {
    accounts: [
      account('VERCEL', 'Vercel'),
      account('VERCEL_WORK', 'Vercel (work)', { fields: { password: false, totp: false } }),
    ],
    signIns: [
      site(SI_VERCEL, 'VERCEL', ['vercel.com'], { recipe: 'PIN 8841-2297-ab', recipeVersion: 2 }),
      site('si_00000000000000a2', 'VERCEL_WORK', ['vercel.com']),
    ],
  };

  it('should list each sign-in with its id, and say how to propose with it now the tool takes one', async () => {
    const world = agentToolWorld({ accounts: { list: async () => LISTING } });
    const result = await world.service.call(agent, { tool: 'account.hint', site: 'vercel.com' });
    should(result.summary).containEql(`[${SI_VERCEL}]`).and.containEql('[si_00000000000000a2]');
    should(result.summary).containEql(ACCOUNT_HINT_NEXT);
    // Two sign in here and nothing chose one: neither is "Only account here", whatever fields each holds.
    should(result.summary).not.containEql('Only account here');
    // No field an `fy` from before sign-ins would refuse to read: the summary is the answer.
    should(Object.keys(result).sort()).deepEqual(['summary']);
  });

  it('should hand the ferret the recipe as the redactor masks it now', async () => {
    const world = agentToolWorld({
      accounts: { list: async () => LISTING },
      recipes: {
        scrubbedAccounts: async listing => ({
          ...listing,
          signIns: listing.signIns.map(signIn =>
            signIn.recipe === undefined ? signIn : { ...signIn, recipe: 'PIN [redacted]' },
          ),
        }),
        propose: async () => await Promise.reject(new Error('unused')),
      },
    });
    const result = await world.service.call(agent, { tool: 'account.hint', site: 'vercel.com' });
    should(JSON.stringify(result)).not.containEql('8841-2297-ab');
    should(result.summary).containEql('PIN [redacted]');
  });

  it('should hand no recipe at all where nothing can mask it', async () => {
    const world = agentToolWorld({ accounts: { list: async () => LISTING } });
    const result = await world.service.call(agent, { tool: 'account.hint', site: 'vercel.com' });
    should(JSON.stringify(result)).not.containEql('PIN');
  });

  it('should never say which secret fields an account holds', async () => {
    const world = agentToolWorld({ accounts: { list: async () => LISTING } });
    const result = await world.service.call(agent, { tool: 'account.hint', site: 'vercel.com' });
    should(result.summary).not.match(/password: (true|false)|fields|totp/u);
  });
});
