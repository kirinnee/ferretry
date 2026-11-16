import { describe, expect, it } from 'bun:test';
import {
  cancelMcpSignIn,
  checkMcpServer,
  finishMcpSignIn,
  readFerret,
  readFerretMcpServers,
  readFerrets,
  readMachineMcpServers,
  readMcpSignIns,
  signOutMcp,
  startMcpSignIn,
} from '../../../app/lib/client.ts';
import { ferretSummary } from '@ferretry/core-ferrets/contract/testing';
import { type Call, CALLBACK, completion, MCP, mcpConnection, mcpFlow, scriptedClient } from './mcp-fixtures.ts';

describe('the inventory reads', () => {
  it('read exactly this ferret’s servers, or the machine’s, parsed with the contract’s own schema', async () => {
    const calls: Call[] = [];
    const client = scriptedClient({ 'GET /v1/ferrets/:ferretId/mcp/servers': MCP, 'GET /v1/mcp': MCP }, calls);

    expect(await readFerretMcpServers(client, 'ferret a')).toEqual(MCP);
    expect(await readMachineMcpServers(client)).toEqual(MCP);
    expect(calls.map(call => [call.route, call.params])).toEqual([
      ['GET /v1/ferrets/:ferretId/mcp/servers', { ferretId: 'ferret a' }],
      ['GET /v1/mcp', undefined],
    ]);
  });

  it('refuse at the call an answer the contract would not have sent', async () => {
    const client = scriptedClient({ 'GET /v1/mcp': { servers: [{ name: 'x' }], problems: [] } });
    await expect(readMachineMcpServers(client)).rejects.toThrow();
  });
});

describe('Check', () => {
  const answer = {
    id: 'id-linear-component',
    name: 'linear',
    transport: 'http',
    outcome: 'connected',
    elapsedMs: 5,
    checkedAt: '2026-10-16T10:00:00.000Z',
    toolCount: 1,
    tools: ['issues'],
  };

  it('asks as the ferret when it is given one, and as the machine when not', async () => {
    const calls: Call[] = [];
    const client = scriptedClient({ 'POST /v1/mcp/check': answer }, calls);

    expect((await checkMcpServer(client, 'id-linear-component', 'ferret-a')).outcome).toBe('connected');
    await checkMcpServer(client, 'id-linear-component');

    expect(calls.map(call => call.body)).toEqual([
      { id: 'id-linear-component', sessionId: 'ferret-a' },
      { id: 'id-linear-component' },
    ]);
  });
});

describe('the MCP sign-in client', () => {
  it('reads every server’s sign-in with the auth list route', async () => {
    const calls: Call[] = [];
    const client = scriptedClient({ 'GET /v1/mcp/auth': { connections: [mcpConnection()] } }, calls);

    const list = await readMcpSignIns(client);

    expect(list.connections[0]?.component).toBe('linear');
    expect(calls).toEqual([{ route: 'GET /v1/mcp/auth', params: undefined, body: undefined }]);
  });

  it('starts on the component, sending only the return address', async () => {
    const calls: Call[] = [];
    const client = scriptedClient({ 'POST /v1/mcp/auth/:component': mcpFlow() }, calls);

    await startMcpSignIn(client, 'my server', { redirectUri: 'https://pwa.example.test/oauth/mcp-callback' });
    await startMcpSignIn(client, 'my server', {});

    expect(calls.map(call => call.params)).toEqual([{ component: 'my server' }, { component: 'my server' }]);
    expect(calls.map(call => call.body)).toEqual([{ redirectUri: 'https://pwa.example.test/oauth/mcp-callback' }, {}]);
  });

  it('refuses at the call a start the daemon would refuse', async () => {
    const client = scriptedClient({});
    await expect(startMcpSignIn(client, 'linear', { redirectUri: '' })).rejects.toThrow();
  });

  it('S174 finishes on the flow with the address in the body and nowhere else, and keeps no token', async () => {
    const calls: Call[] = [];
    const client = scriptedClient({ 'POST /v1/mcp/auth/flows/:flowId': completion() }, calls);

    const answer = await finishMcpSignIn(client, 'flow/one', CALLBACK);

    expect(answer.connection.state).toBe('signed-in');
    expect(calls[0]?.body).toEqual({ callback: CALLBACK });
    // The address (which holds a code) is the body and only the body: not the route, not the params.
    expect(calls[0]?.route).not.toContain('code');
    expect(JSON.stringify(calls[0]?.params)).not.toContain('code');
    // The connection the daemon answers names its secrets and carries no value.
    expect(Object.keys(answer.connection).sort()).toEqual([
      'component',
      'expiresAt',
      'issuer',
      'renewable',
      'secrets',
      'signedInAt',
      'state',
    ]);
  });

  it('S174 refuses at the call an answer that carries a token field', async () => {
    const client = scriptedClient({
      'POST /v1/mcp/auth/flows/:flowId': completion({ ...mcpConnection(), accessToken: 'fixture-token' } as never),
    });
    await expect(finishMcpSignIn(client, 'flow-one', CALLBACK)).rejects.toThrow();
  });

  it('cancels a flow and signs a component out', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      {
        'DELETE /v1/mcp/auth/flows/:flowId': { flowId: 'mcp-flow-one', cancelled: true },
        'DELETE /v1/mcp/auth/:component': { component: 'linear', removed: true, revoked: false },
      },
      calls,
    );

    expect(await cancelMcpSignIn(client, 'mcp-flow-one')).toEqual({ flowId: 'mcp-flow-one', cancelled: true });
    expect(await signOutMcp(client, 'linear')).toEqual({ component: 'linear', removed: true, revoked: false });
    expect(calls.map(call => call.route)).toEqual([
      'DELETE /v1/mcp/auth/flows/:flowId',
      'DELETE /v1/mcp/auth/:component',
    ]);
  });
});

describe('mcp#1 the ferret reads, through Ferrets’ own routes', () => {
  // The daemon answers a whole summary; MCP keeps the five fields it uses and ignores the rest.
  const summary = ferretSummary({
    id: 'f1',
    name: 'Marin',
    runtime: 'marin',
    state: 'idle',
    harness: 'claude-code',
    folder: '/w',
  });

  it('reads one ferret by id and the whole list, keeping only what MCP uses', async () => {
    const calls: Call[] = [];
    const client = scriptedClient({ 'GET /v1/ferrets/:ferretId': summary, 'GET /v1/ferrets': [summary] }, calls);
    expect(await readFerret(client, 'f1')).toMatchObject({ id: 'f1', name: 'Marin', runtime: 'marin', state: 'idle' });
    expect(await readFerrets(client)).toHaveLength(1);
    expect(calls.map(call => [call.route, call.params])).toEqual([
      ['GET /v1/ferrets/:ferretId', { ferretId: 'f1' }],
      ['GET /v1/ferrets', undefined],
    ]);
  });

  it('refuses an answer that is not a ferret', async () => {
    const client = scriptedClient({ 'GET /v1/ferrets/:ferretId': { id: 'f1', name: 'Marin', state: 'asleep' } });
    await expect(readFerret(client, 'f1')).rejects.toThrow();
  });
});
