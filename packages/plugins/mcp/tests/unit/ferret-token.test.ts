import { describe, expect, test } from 'bun:test';
import type { ApiRequest, CallContext } from '@ferretry/kernel/contract';
import type { SecretName } from '@ferretry/core-vault/contract';
import { mcpOAuthSecretNames, mcpTokenCommand } from '../../contract/index.ts';
import { tokenRoutes } from '../../daemon/features/token/routes.ts';
import { FerretMcpTokens, type FerretMcpTokensDeps } from '../../daemon/features/token/service.ts';
import { McpTokenController } from '../../cli/lib/token.ts';

/**
 * A running ferret asking for the renewed token behind one of ITS OWN sign-in variables. Fake names and a fake token
 * only; the token appears in exactly one place (the Vault fake's value) and in the one answer that is meant to carry it.
 */
const SERVER = 'https://mcp.example.test/mcp';
const NAMES = mcpOAuthSecretNames('linear', SERVER);
const OTHER = mcpOAuthSecretNames('other', 'https://other.example.test/mcp');
const FAKE_TOKEN = 'FAKE-RENEWED-TOKEN-0123456789';

const tokens = (over: Partial<FerretMcpTokensDeps> = {}) => {
  const asked: string[] = [];
  const service = new FerretMcpTokens({
    ferret: async id => (id === 'f1' ? { id, harness: 'claude-code', folder: '/work/app', runtime: 'rt' } : undefined),
    bindings: async () => new Map<string, SecretName>([[NAMES.variable, NAMES.access]]),
    signInRequired: async () => undefined,
    value: async name => {
      asked.push(name);
      return name === NAMES.access ? FAKE_TOKEN : undefined;
    },
    ...over,
  });
  return { service, asked };
};

describe('FerretMcpTokens: what THIS ferret’s launch holds, renewed', () => {
  test('answers the Authorization header for a variable its launch holds', async () => {
    const { service } = tokens();

    expect(await service.headers('f1', NAMES.variable)).toEqual({
      variable: NAMES.variable,
      headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
    });
  });

  test('a variable its launch does not hold is 404 not_this_ferrets_server, and the Vault is never asked', async () => {
    const { service, asked } = tokens();

    await expect(service.headers('f1', OTHER.variable)).rejects.toMatchObject({
      status: 404,
      code: 'not_this_ferrets_server',
    });
    expect(asked).toEqual([]);
  });

  test('a ferret this machine does not know is refused the same way', async () => {
    await expect(tokens().service.headers('ghost', NAMES.variable)).rejects.toMatchObject({ status: 404 });
  });

  test('a rejected refresh is 409 mcp_needs_sign_in naming the server, never the token', async () => {
    const { service } = tokens({ signInRequired: async () => 'linear' });

    const refusal = await service.headers('f1', NAMES.variable).catch((error: unknown) => error as Error);

    expect(refusal).toMatchObject({ status: 409, code: 'mcp_needs_sign_in' });
    expect((refusal as Error).message).toContain('“linear”');
    expect((refusal as Error).message).not.toContain(FAKE_TOKEN);
  });

  test('a sign-in whose value the Vault cannot give (signed out meanwhile) is 409, not an empty header', async () => {
    const { service } = tokens({ value: async () => undefined });

    await expect(service.headers('f1', NAMES.variable)).rejects.toMatchObject({ status: 409 });
  });
});

describe('POST /v1/ferrets/:ferretId/mcp/token: ONLY the ferret itself', () => {
  const route = tokenRoutes(tokens().service)['POST /v1/ferrets/:ferretId/mcp/token'];
  const call = (credential: unknown, id = 'f1', variable = NAMES.variable): CallContext =>
    ({
      params: new Map([['ferretId', id]]),
      credential,
      request: { text: async () => JSON.stringify({ variable }) } as ApiRequest,
    }) as unknown as CallContext;
  const own = { kind: 'authenticated', tokenClass: 'ferret', ferret: 'f1' };

  test('the ferret named in the path, holding its own session credential, gets its header', async () => {
    const answer = await route(call(own));

    expect(answer.status).toBe(200);
  });

  for (const [who, credential, id] of [
    ['the admin token', { kind: 'authenticated', tokenClass: 'admin' }, 'f1'],
    ['the warden', { kind: 'authenticated', tokenClass: 'warden' }, 'f1'],
    ['a paired device', { kind: 'authenticated', tokenClass: 'device', principal: {} }, 'f1'],
    ['another ferret', { kind: 'authenticated', tokenClass: 'ferret', ferret: 'f2' }, 'f1'],
    ['the ferret, asking for another ferret’s token', own, 'f2'],
    ['no credential at all', undefined, 'f1'],
  ] as const)
    test(`${who} is refused 403 not_this_ferret`, async () => {
      await expect(route(call(credential, id))).rejects.toMatchObject({ status: 403, code: 'not_this_ferret' });
    });

  test('a variable that is not a sign-in variable is refused before anything is read', async () => {
    await expect(route(call(own, 'f1', 'HOME'))).rejects.toThrow('not an MCP sign-in token variable');
    await expect(route(call(own, 'f1', 'FY_MCP_X_TOKEN\nHOME'))).rejects.toThrow('not an MCP sign-in token variable');
  });
});

describe('fy mcp token', () => {
  const run = async (own: string | undefined, variable: string | undefined, answer: () => Promise<unknown>) => {
    const out: string[] = [];
    const err: string[] = [];
    const calls: unknown[] = [];
    const code = await new McpTokenController(
      {
        call: (async (_route: string, init: unknown) => {
          calls.push(init);
          return await answer();
        }) as never,
      },
      { out: text => out.push(text), err: text => err.push(text) },
      own,
    ).token(variable);
    return { code, out: out.join(''), err: err.join(''), calls };
  };

  test('prints exactly the headers object and nothing else', async () => {
    const answer = { variable: NAMES.variable, headers: { Authorization: `Bearer ${FAKE_TOKEN}` } };

    const ran = await run('f1', NAMES.variable, async () => answer);

    expect(ran.code).toBe(0);
    expect(ran.out).toBe(JSON.stringify({ Authorization: `Bearer ${FAKE_TOKEN}` }));
    expect(ran.err).toBe('');
    expect(ran.calls).toEqual([{ params: { ferretId: 'f1' }, body: { variable: NAMES.variable } }]);
  });

  test('outside a ferret it says so and exits 2, asking nobody', async () => {
    const ran = await run(undefined, NAMES.variable, async () => ({}));

    expect(ran.code).toBe(2);
    expect(ran.out).toBe('');
    expect(ran.calls).toEqual([]);
  });

  test('a name that is not a sign-in variable exits 2 without a request', async () => {
    const ran = await run('f1', 'HOME', async () => ({}));

    expect(ran.code).toBe(2);
    expect(ran.calls).toEqual([]);
  });

  test('the daemon’s refusal goes to stderr as its own sentence, exit 1, stdout empty', async () => {
    const ran = await run('f1', NAMES.variable, async () => {
      throw new Error('The sign-in to “linear” can no longer be renewed.');
    });

    expect(ran.code).toBe(1);
    expect(ran.out).toBe('');
    expect(ran.err).toBe('The sign-in to “linear” can no longer be renewed.\n');
  });
});

describe('the command both writers of an entry share', () => {
  test('is `fy mcp token <VARIABLE>`', () => {
    expect(mcpTokenCommand(NAMES.variable)).toBe(`fy mcp token ${NAMES.variable}`);
  });
});
