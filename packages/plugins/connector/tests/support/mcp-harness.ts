import { CAPABILITY_NAMES, type CapabilityGrants } from '@ferretry/core-gate/contract';
import type { ApiRequest, ApiResponse } from '@ferretry/kernel/contract';
import { ConnectorMcpEndpoint } from '../../daemon/adapters/mcp/mcp-endpoint.ts';
import type { ConnectorCallRecord, ConnectorCallsLog } from '../../daemon/lib/mcp/ports.ts';
import { ConnectorTextGuard } from '../../daemon/lib/mcp/redaction.ts';
import { ConnectorToolbox } from '../../daemon/lib/mcp/toolbox.ts';
import type { ConnectorAccess } from '../../daemon/lib/ports.ts';
import { OWN_DOOR } from './door.ts';
import { AuditSpy, FakeDelegate, NOW, WRITE_ACCESS } from './mcp-fixtures.ts';

export const ALL_GRANTS: CapabilityGrants = Object.fromEntries(
  CAPABILITY_NAMES.map(capability => [capability, { use: true, configure: true }]),
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
  readonly delegate: FakeDelegate;
  readonly audit: AuditSpy;
  readonly calls: CallsSpy;
  readonly state: {
    grants: CapabilityGrants | undefined;
    now: number;
    access: ConnectorAccess | undefined;
    verifications: number;
    verifierFails: boolean;
    /** Whether the connector is on; a flip to `false` is an off in the middle of a request. */
    serving: boolean;
  };
}

export function rig(options: { redact?: (text: string) => Promise<string>; allowedOrigins?: string[] } = {}): Rig {
  const delegate = new FakeDelegate();
  const audit = new AuditSpy();
  const calls = new CallsSpy();
  const state: Rig['state'] = {
    grants: ALL_GRANTS,
    now: NOW,
    access: WRITE_ACCESS,
    verifications: 0,
    verifierFails: false,
    serving: true,
  };
  const toolbox = new ConnectorToolbox({
    daemonGrants: () => state.grants,
    guard: new ConnectorTextGuard(options.redact ?? (async text => text)),
    callsLog: calls,
    audit,
    now: () => state.now,
  });
  let counter = 0;
  const endpoint = new ConnectorMcpEndpoint({
    verifier: {
      verify: async bearer => {
        state.verifications += 1;
        if (state.verifierFails) throw new Error('the token store is unreadable');
        return bearer === TOKEN ? state.access : undefined;
      },
    },
    unauthorized: presented => ({
      status: 401,
      headers: new Map([['www-authenticate', presented ? 'Bearer error="invalid_token"' : 'Bearer']]),
      body: '',
    }),
    delegate,
    serving: () => state.serving,
    toolbox,
    now: () => state.now,
    newRequestId: () => `req-${++counter}`,
    serverVersion: '0.0.0-test',
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
  });
  return { endpoint, delegate, audit, calls, state };
}

export interface PostOptions {
  readonly token?: string | null;
  readonly origin?: string;
  readonly method?: string;
  readonly path?: string;
  readonly contentType?: string;
  /** `null` sends no Accept header at all. */
  readonly accept?: string | null;
  readonly protocolVersion?: string;
  /** Replaces reading the body, to say what a transport that refuses it does. */
  readonly readBody?: () => Promise<string>;
  /** Extra request headers, lower-case names (an `mcp-protocol-version`, say). */
  readonly headers?: Readonly<Record<string, string>>;
}

export function post(
  endpoint: ConnectorMcpEndpoint,
  body: unknown,
  options: PostOptions = {},
): Promise<ApiResponse | undefined> {
  const headers = new Map<string, string>([
    ['content-type', options.contentType ?? 'application/json'],
    ...(options.accept === null
      ? []
      : [['accept', options.accept ?? 'application/json, text/event-stream'] as [string, string]]),
  ]);
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  if (options.origin !== undefined) headers.set('origin', options.origin);
  if (options.protocolVersion !== undefined) headers.set('mcp-protocol-version', options.protocolVersion);
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const request = {
    method: options.method ?? 'POST',
    path: options.path ?? '/mcp',
    query: new Map(),
    headers,
    arrival: OWN_DOOR,
    clientAddress: '203.0.113.7',
    text: options.readBody ?? (async () => raw),
  } as ApiRequest;
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
