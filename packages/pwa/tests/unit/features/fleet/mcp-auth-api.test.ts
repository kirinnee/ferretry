import { describe, expect, it } from 'bun:test';
import { MCP_OAUTH_PATH } from '@ferretry/protocol';
import {
  cancelMcpSignIn,
  finishMcpSignIn,
  readMcpSignIns,
  signOutMcp,
  startMcpSignIn,
} from '../../../../src/features/fleet/mcp-auth-api.ts';
import { type Call, CALLBACK, completion, mcpConnection, mcpFlow, scriptedMcpClient } from './mcp-sign-in-support.ts';

describe('the MCP sign-in client', () => {
  it('reads every server’s sign-in with GET', async () => {
    const calls: Call[] = [];
    const client = scriptedMcpClient({ [`GET ${MCP_OAUTH_PATH}`]: { connections: [mcpConnection()] } }, calls);

    const list = await readMcpSignIns(client);

    expect(list.connections[0]?.component).toBe('linear');
    expect(calls).toEqual([{ path: MCP_OAUTH_PATH, method: 'GET', body: undefined }]);
  });

  it('starts with POST on the component, sending only the return address', async () => {
    const calls: Call[] = [];
    const client = scriptedMcpClient({ [`POST ${MCP_OAUTH_PATH}/my%20server`]: mcpFlow() }, calls);

    await startMcpSignIn(client, 'my server', { redirectUri: 'https://pwa.example.test/oauth/mcp-callback' });
    await startMcpSignIn(client, 'my server', {});

    expect(calls.map(call => call.body)).toEqual([{ redirectUri: 'https://pwa.example.test/oauth/mcp-callback' }, {}]);
  });

  it('refuses at the call a start the daemon would refuse', async () => {
    const client = scriptedMcpClient({});
    await expect(startMcpSignIn(client, 'linear', { redirectUri: '' })).rejects.toThrow();
  });

  it('finishes with POST on the flow, the address in the body and nowhere else', async () => {
    const calls: Call[] = [];
    const client = scriptedMcpClient({ [`POST ${MCP_OAUTH_PATH}/flows/flow%2Fone`]: completion() }, calls);

    const answer = await finishMcpSignIn(client, 'flow/one', CALLBACK);

    expect(answer.connection.state).toBe('signed-in');
    expect(calls[0]?.body).toEqual({ callback: CALLBACK });
    expect(calls[0]?.path).not.toContain('code');
  });

  it('cancels a flow and signs a component out with DELETE', async () => {
    const calls: Call[] = [];
    const client = scriptedMcpClient(
      {
        [`DELETE ${MCP_OAUTH_PATH}/flows/mcp-flow-one`]: { flowId: 'mcp-flow-one', cancelled: true },
        [`DELETE ${MCP_OAUTH_PATH}/linear`]: { component: 'linear', removed: true, revoked: false },
      },
      calls,
    );

    expect(await cancelMcpSignIn(client, 'mcp-flow-one')).toEqual({ flowId: 'mcp-flow-one', cancelled: true });
    expect(await signOutMcp(client, 'linear')).toEqual({ component: 'linear', removed: true, revoked: false });
    expect(calls.map(call => call.method)).toEqual(['DELETE', 'DELETE']);
  });
});
