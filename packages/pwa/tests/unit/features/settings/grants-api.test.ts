import { describe, expect, it } from 'bun:test';
import { type GrantsView, OPERATOR_UNLOCK_HEADER } from '@ferretry/protocol';
import { changeGrants, GRANTS_PATH, readGrants, unlockGrants } from '../../../../src/features/settings/grants-api.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

const view: GrantsView = {
  capabilities: [
    {
      capability: 'fleet',
      use: true,
      configure: false,
      granted: { use: true, configure: true },
      useRefusal: 'granted',
      configureRefusal: 'locked',
      origin: 'config file',
    },
  ],
  passwordSet: true,
  unlocked: false,
  attemptsRemaining: 5,
};

/**
 * A client that records what it was asked and answers with whatever the case supplies.
 *
 * IT APPLIES THE SCHEMA, because the real client does — `FyApiClient.request` parses every answer
 * before resolving. A fake that skipped it would make the "a wrong shape fails here" cases pass
 * against the fake rather than against the contract, which is the same as not testing them.
 */
const recorder = (answer: unknown) => {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      request: (async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        calls.push({ path, init });
        return schema.parse(answer);
      }) as never,
    },
  };
};

const headerOf = (call: Call | undefined, name: string): string | null => new Headers(call?.init?.headers).get(name);

describe('readGrants', () => {
  it('reads the whole picture in one GET, so a limit can be explained before anybody clicks', async () => {
    const { calls, client } = recorder(view);
    expect(await readGrants(client)).toEqual(view);
    expect(calls[0]?.path).toBe(GRANTS_PATH);
    expect(calls[0]?.init).toBeUndefined();
  });

  it('parses the answer rather than casting it, so a wrong shape fails here', async () => {
    const { client } = recorder({ capabilities: 'not an array' });
    await expect(readGrants(client)).rejects.toThrow();
  });
});

describe('changeGrants', () => {
  it('PATCHes only the axis the reader touched', async () => {
    const { calls, client } = recorder(view);
    await changeGrants(client, { warden: { configure: false } });
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ warden: { configure: false } });
  });

  it('sends the unlock in a HEADER, never in the path or a query', async () => {
    const { calls, client } = recorder(view);
    await changeGrants(client, { fleet: { configure: true } }, 'fy_unlock_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(headerOf(calls[0], OPERATOR_UNLOCK_HEADER)).toBe('fy_unlock_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(calls[0]?.path).toBe(GRANTS_PATH);
    expect(calls[0]?.path).not.toContain('unlock=');
  });

  it('omits the header entirely when there is no unlock to present', async () => {
    const { calls, client } = recorder(view);
    await changeGrants(client, { fleet: { use: false } });
    expect(headerOf(calls[0], OPERATOR_UNLOCK_HEADER)).toBeNull();
  });

  it('refuses a patch that changes nothing, the way the contract does', async () => {
    const { client } = recorder(view);
    await expect(changeGrants(client, {})).rejects.toThrow();
  });
});

describe('unlockGrants', () => {
  it('sends the password in a BODY, because a URL reaches every proxy access log', async () => {
    const minted = {
      token: 'fy_unlock_aaaaaaaaaaaaaaaaaaaaaaaa',
      expiresAt: '2026-01-01T00:05:00.000Z',
      ttlSeconds: 300,
    };
    const { calls, client } = recorder(minted);
    expect(await unlockGrants(client, 'operator-secret')).toEqual(minted);
    expect(calls[0]?.path).toBe(`${GRANTS_PATH}/unlock`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ password: 'operator-secret' });
    expect(calls[0]?.path).not.toContain('operator-secret');
  });

  it('rejects a token the daemon did not mint in the declared shape', async () => {
    const { client } = recorder({ token: 'not-an-unlock', expiresAt: '2026-01-01T00:05:00.000Z', ttlSeconds: 300 });
    await expect(unlockGrants(client, 'operator-secret')).rejects.toThrow();
  });
});
