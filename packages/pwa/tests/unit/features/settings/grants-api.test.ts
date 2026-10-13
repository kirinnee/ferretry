import { describe, expect, it } from 'bun:test';
import type { GrantsView } from '@ferretry/protocol';
import { changeGrants, GRANTS_PATH, readGrants } from '../../../../src/features/settings/grants-api.ts';

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
      configureRefusal: 'step-up-required',
      origin: 'config file',
      // A remote caller, which is what a `step-up-required` configure axis implies: widening is a local act.
      mayGrant: false,
    },
  ],
  governed: true,
  hostLocal: false,
  steppedUp: false,
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

  it('refuses a view still carrying the deleted password fields', async () => {
    const { client } = recorder({ ...view, passwordSet: true, unlocked: false });
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

  it('sends nothing but the content type: the passkey travels in the session, not on the request', async () => {
    const { calls, client } = recorder(view);
    await changeGrants(client, { fleet: { use: false } });
    expect(calls[0]?.path).toBe(GRANTS_PATH);
    expect([...new Headers(calls[0]?.init?.headers)]).toEqual([['content-type', 'application/json']]);
  });

  it('refuses a patch that changes nothing, the way the contract does', async () => {
    const { client } = recorder(view);
    await expect(changeGrants(client, {})).rejects.toThrow();
  });
});
