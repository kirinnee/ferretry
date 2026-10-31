import { describe, it } from 'bun:test';
import should from 'should';
import { actsOn } from '../../../src/lib/agent-tools/service.ts';
import type { AgentToolError } from '../../../src/lib/index.ts';
import { LoginEntryError, RecipeValueError } from '../../../src/lib/secrets/index.ts';
import { agent, agentToolWorld } from './support.ts';

/** `login_propose`: a ferret's suggested recipe for a saved login, which the owner approves. */

describe('login.propose', () => {
  it("should file the ferret's recipe for the owner and say the card it waits on", async () => {
    const calls: unknown[] = [];
    const world = agentToolWorld({
      recipes: {
        scrubbed: async entries => entries,
        propose: async (...parameters) => {
          calls.push(parameters);
          return { id: 'rp_0000000000000001', login: 'VERCEL', state: 'pending', agendaItemId: 'A4' };
        },
      },
    });

    const result = await world.service.call(agent, {
      tool: 'login.propose',
      login: 'VERCEL',
      recipe: 'Open vercel.com → Continue with Google → [[GOOGLE_KIRIN]]',
      why: 'the first sign-in needed the Google step',
    });

    should(calls).deepEqual([
      [
        's1',
        'VERCEL',
        'Open vercel.com → Continue with Google → [[GOOGLE_KIRIN]]',
        'the first sign-in needed the Google step',
      ],
    ]);
    should(result.recipe).deepEqual({
      id: 'rp_0000000000000001',
      login: 'VERCEL',
      state: 'pending',
      agendaItemId: 'A4',
    });
    should(result.summary).containEql('!A4');
    // The audit names the login, never the ferret's text.
    should(JSON.stringify(world.audit)).not.containEql('Continue with Google');
  });

  it('should say when the owner let it apply at once', async () => {
    const world = agentToolWorld({
      recipes: {
        scrubbed: async entries => entries,
        propose: async () => ({ id: 'rp_0000000000000001', login: 'VERCEL', state: 'applied' }),
      },
    });
    const result = await world.service.call(agent, { tool: 'login.propose', login: 'VERCEL', recipe: 'x', why: 'y' });
    should(result.summary).containEql('was updated');
  });

  it('should refuse an unknown login, a recipe holding a value, and a daemon without recipes', async () => {
    const refusing = (error: Error) =>
      agentToolWorld({
        recipes: { scrubbed: async entries => entries, propose: async () => await Promise.reject(error) },
      });
    const call = { tool: 'login.propose', login: 'VERCEL', recipe: 'x', why: 'y' } as const;
    const unknown = (await refusing(new LoginEntryError('unknown_login', 'there is no saved login VERCEL'))
      .service.call(agent, call)
      .catch((caught: unknown) => caught)) as AgentToolError;
    should(unknown.code).equal('not_found');
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
    await world.service.call(agent, { tool: 'login.hint', site: 'vercel.com' }).catch(() => undefined);
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

describe('login.hint masks recipes as it serves them', () => {
  const ENTRY = {
    id: 'VERCEL',
    label: 'Vercel',
    match: ['vercel.com'],
    fields: { password: false, totp: false },
    recipe: 'PIN 8841-2297-ab',
    createdAt: '2026-10-31T09:00:00.000Z',
    updatedAt: '2026-10-31T09:00:00.000Z',
  };

  it('should hand the ferret the recipe as the redactor masks it now', async () => {
    const world = agentToolWorld({
      logins: { list: async () => [ENTRY] },
      recipes: {
        scrubbed: async entries => entries.map(entry => ({ ...entry, recipe: 'PIN [redacted]' })),
        propose: async () => await Promise.reject(new Error('unused')),
      },
    });
    const result = await world.service.call(agent, { tool: 'login.hint', site: 'vercel.com' });
    should(JSON.stringify(result)).not.containEql('8841-2297-ab');
    should(result.summary).containEql('PIN [redacted]');
  });

  it('should hand no recipe at all where nothing can mask it', async () => {
    const world = agentToolWorld({ logins: { list: async () => [ENTRY] } });
    const result = await world.service.call(agent, { tool: 'login.hint', site: 'vercel.com' });
    should(JSON.stringify(result)).not.containEql('PIN');
  });
});
