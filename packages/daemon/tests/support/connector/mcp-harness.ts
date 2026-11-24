import { DAEMON_CAPABILITIES, type CapabilityGrants } from '@ferretry/protocol';
import type { ApiRequest, ApiResponse } from '../../../../src/lib/api/http.ts';
import type { ConnectorAccess } from '../../../../src/lib/connector/ports.ts';
import { ConnectorToolbox } from '../../../../src/lib/connector/mcp/tools.ts';
import type { ConnectorCallRecord, ConnectorCallsLog } from '../../../../src/lib/connector/mcp/ports.ts';
import { ConnectorTextGuard } from '../../../../src/lib/connector/mcp/redaction.ts';
import { ConnectorMcpEndpoint } from '../../../../src/adapters/connector/mcp/mcp-endpoint.ts';
import { AuditSpy, FakeDispatch, NOW, WRITE_ACCESS } from './fixtures.ts';

export const ALL_GRANTS: CapabilityGrants = Object.fromEntries(
  DAEMON_CAPABILITIES.map(capability => [capability, { use: true, configure: true }]),
) as CapabilityGrants;

export class CallsSpy implements ConnectorCallsLog {
  readonly records: ConnectorCallRecord[] = [];
  async append(record: ConnectorCallRecord): Promise<void> {
    this.records.push(record);
  }
}

export const TOKEN = 'fyc_at_test-token-value-not-real';

export interface Rig {
  readonly endpoint: ConnectorMcpEndpoint;
  readonly dispatch: FakeDispatch;
  readonly audit: AuditSpy;
  readonly calls: CallsSpy;
  readonly state: {
    grants: CapabilityGrants | undefined;
    now: number;
    access: ConnectorAccess | undefined;
    verifications: number;
  };
}

export function rig(options: { redact?: (text: string) => Promise<string>; allowedOrigins?: string[] } = {}): Rig {
  const dispatch = new FakeDispatch();
  const audit = new AuditSpy();
  const calls = new CallsSpy();
  const state: Rig['state'] = { grants: ALL_GRANTS, now: NOW, access: WRITE_ACCESS, verifications: 0 };
  const toolbox = new ConnectorToolbox({
    daemonGrants: () => state.grants,
    guard: new ConnectorTextGuard({ redact: options.redact ?? (async text => text) }),
    callsLog: calls,
    audit,
    now: () => state.now,
  });
  let counter = 0;
  const endpoint = new ConnectorMcpEndpoint({
    verifier: {
      verify: async bearer => {
        state.verifications += 1;
        return bearer === TOKEN ? state.access : undefined;
      },
    },
    unauthorized: presented => ({
      status: 401,
      headers: new Map([['www-authenticate', presented ? 'Bearer error="invalid_token"' : 'Bearer']]),
      body: '',
    }),
    dispatch,
    toolbox,
    now: () => state.now,
    newRequestId: () => `req-${++counter}`,
    serverVersion: '0.0.0-test',
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
  });
  return { endpoint, dispatch, audit, calls, state };
}

export interface PostOptions {
  readonly token?: string | null;
  readonly origin?: string;
  readonly method?: string;
  readonly path?: string;
  readonly contentType?: string;
}

export function post(
  endpoint: ConnectorMcpEndpoint,
  body: unknown,
  options: PostOptions = {},
): Promise<ApiResponse | undefined> {
  const headers = new Map<string, string>([
    ['content-type', options.contentType ?? 'application/json'],
    ['accept', 'application/json, text/event-stream'],
  ]);
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  if (options.origin !== undefined) headers.set('origin', options.origin);
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const request: ApiRequest = {
    method: options.method ?? 'POST',
    path: options.path ?? '/mcp',
    query: new Map(),
    headers,
    loopback: true,
    text: async () => raw,
  };
  return endpoint.handle(request);
}

let id = 0;
export const rpc = (method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id: ++id,
  method,
  ...(params === undefined ? {} : { params }),
});
export const callTool = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args });

export const INIT = rpc('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'test', version: '1' },
});

export interface ToolReply {
  readonly status: number;
  readonly text: string;
  readonly isError: boolean;
  readonly raw: unknown;
}

export async function tool(r: Rig, name: string, args: unknown, options: PostOptions = {}): Promise<ToolReply> {
  const response = await post(r.endpoint, callTool(name, args), options);
  if (response === undefined) throw new Error('endpoint declined the path');
  const parsed = response.body === '' ? undefined : (JSON.parse(response.body) as Record<string, unknown>);
  const result = parsed?.result as { content?: { text: string }[]; isError?: boolean } | undefined;
  return {
    status: response.status,
    text: result?.content?.map(part => part.text).join('\n') ?? '',
    isError: result?.isError === true,
    raw: parsed,
  };
}
