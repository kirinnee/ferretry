import { describe, expect, it } from 'bun:test';
import {
  changeConnector,
  type ConnectorClient,
  readConnector,
} from '../../../../src/features/connector/connector-api.ts';

interface Sent {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

/** A client that parses `answer` with the schema it is handed, as the real one does, and records what was sent. */
const clientAnswering = (answer: unknown, sent: Sent[] = []): ConnectorClient => ({
  request: (async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
    sent.push({ path, init });
    return schema.parse(answer);
  }) as ConnectorClient['request'],
});

const status = { enabled: false, pending: [], grants: [] };

describe('connector API', () => {
  it('PUTs { enabled } to /v1/connector and answers the status the daemon returned', async () => {
    const sent: Sent[] = [];
    const view = await changeConnector(
      clientAnswering(
        {
          enabled: true,
          switchedOn: true,
          publicUrlSource: 'tunnel',
          publicUrl: 'https://abc.tunnel.example',
          mcpUrl: 'https://abc.tunnel.example/mcp',
          pending: [],
          grants: [],
        },
        sent,
      ),
      true,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe('/v1/connector');
    expect(sent[0]?.init?.method).toBe('PUT');
    expect(new Headers(sent[0]?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({ enabled: true });
    expect(view.switchedOn).toBe(true);
    expect(view.publicUrlSource).toBe('tunnel');
    expect(view.mcpUrl).toBe('https://abc.tunnel.example/mcp');
  });

  it('sends enabled: false to switch it off', async () => {
    const sent: Sent[] = [];
    await changeConnector(clientAnswering({ ...status, switchedOn: false }, sent), false);
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({ enabled: false });
  });

  it('lets a refusal through unchanged, so the panel can word it', async () => {
    const refusing: ConnectorClient = {
      request: (async () => {
        throw new Error('refused');
      }) as ConnectorClient['request'],
    };
    await expect(changeConnector(refusing, true)).rejects.toThrow('refused');
  });

  it('reads switchedOn as what enabled says when an older daemon leaves it out', async () => {
    expect((await readConnector(clientAnswering({ ...status, enabled: true }))).switchedOn).toBe(true);
    expect((await readConnector(clientAnswering(status))).switchedOn).toBe(false);
  });

  it('keeps an explicit switchedOn: on but not reachable', async () => {
    const view = await readConnector(
      clientAnswering({ ...status, switchedOn: true, disabledReason: 'Turn on the tunnel in Settings › Connection.' }),
    );
    expect(view.enabled).toBe(false);
    expect(view.switchedOn).toBe(true);
    expect(view.disabledReason).toContain('tunnel');
  });

  it('reads an unknown publicUrlSource as absent rather than failing the panel', async () => {
    const view = await readConnector(
      clientAnswering({ ...status, switchedOn: true, publicUrlSource: 'carrier-pigeon' }),
    );
    expect(view.publicUrlSource).toBeUndefined();
  });
});
