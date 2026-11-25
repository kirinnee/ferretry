import type { ApiRequest, CallContext, ConfigFileStatus, PublicDoorHandle } from '@ferretry/kernel/contract';
import {
  CONNECTOR_CONFIG,
  ConnectorConfigSchema,
  type ConnectorConfig,
  ConnectorStateFileSchema,
  type ConnectorState,
} from '../../contract/index.ts';
import { ConnectorService } from '../../daemon/lib/service.ts';
import type { ConnectorAuditEvent } from '../../daemon/lib/ports.ts';
import { base64url } from '../../daemon/lib/oauth/model.ts';
import { OWN_DOOR, TUNNEL_DOOR } from './door.ts';

export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
export const VERIFIER = 'v'.repeat(43);

/** `config/connector.yaml` as the kernel's config port would answer for it: the parsed file in effect, its state, and the owner's patch. */
class FakeConfig {
  file: ConnectorConfig | undefined;
  state: ConfigFileStatus = { state: 'absent', inEffect: false, sentences: [] };
  /** What the next owner write answers instead of writing, to model a held, conflicting or refused edit. */
  next: WriteAnswer | undefined;
  readonly writes: Record<string, unknown>[] = [];
  private listeners: (() => void)[] = [];

  constructor(initial?: Record<string, unknown>) {
    if (initial !== undefined) this.set(initial);
  }

  set(value: Record<string, unknown>): void {
    this.file = ConnectorConfigSchema.parse(value);
    this.state = { state: 'valid', inEffect: true, sentences: [] };
    for (const listener of this.listeners) listener();
  }

  readonly port = {
    file: (def: unknown) => {
      if (def !== CONNECTOR_CONFIG) throw new Error('another plugin file');
      return this.file;
    },
    fileState: () => this.state,
    watch: (_def: unknown, listener: () => void) => {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter(known => known !== listener);
      };
    },
    writeAsOwner: async (
      _def: unknown,
      _name: unknown,
      edit: { patch: Record<string, unknown> },
    ): Promise<WriteAnswer> => {
      if (this.next !== undefined) {
        const answer = this.next;
        this.next = undefined;
        return answer;
      }
      this.writes.push(edit.patch);
      this.set({ ...this.file, ...edit.patch });
      return { kind: 'written', etag: 'etag', loosened: [] };
    },
  };
}
type WriteAnswer = { kind: string; [key: string]: unknown };

/** An in-memory `state/connector/connector.json`, with a way to damage it. */
class FakeState {
  value: ConnectorState | undefined;
  damaged = false;
  readonly port = {
    read: async () =>
      this.damaged
        ? { ok: false as const, error: { file: 'connector.json', reason: 'unparsable', sentence: 'damaged' } }
        : { ok: true as const, value: this.value === undefined ? undefined : structuredClone(this.value) },
    write: async (_file: unknown, value: ConnectorState) => {
      this.value = ConnectorStateFileSchema.parse(structuredClone(value));
    },
  };
}

export interface World {
  readonly service: ConnectorService;
  readonly config: FakeConfig;
  readonly state: FakeState;
  readonly events: ConnectorAuditEvent[];
  readonly opened: {
    port: number;
    closed: boolean;
    peer: ((headers: ReadonlyMap<string, string>) => string) | undefined;
  }[];
  /** A tunnel hostname (an origin), or none. */
  tunnel: string | undefined;
  /** Makes the next `open` fail with this message (a port that is taken). */
  failOpen: string | undefined;
  time: number;
}

export function world(initial?: Record<string, unknown>): World {
  const config = new FakeConfig(initial);
  const state = new FakeState();
  const events: ConnectorAuditEvent[] = [];
  const opened: World['opened'] = [];
  const w: World = {
    service: undefined as never,
    config,
    state,
    events,
    opened,
    tunnel: undefined,
    failOpen: undefined,
    time: Date.parse('2026-11-25T10:00:00.000Z'),
  };
  const service = new ConnectorService({
    config: config.port as never,
    state: state.port as never,
    publicDoor: {
      open: async input => {
        if (w.failOpen !== undefined) throw new Error(w.failOpen);
        const record = { port: input.port, closed: false, peer: input.peer as never };
        opened.push(record);
        const handle: PublicDoorHandle = {
          port: input.port,
          close: async () => {
            record.closed = true;
          },
        };
        return handle;
      },
    },
    audit: {
      record: async event => {
        events.push(event);
      },
    },
    clock: { now: () => w.time },
    tunnelOrigin: () => w.tunnel,
    appOrigin: 'https://app.example',
    daemonId: 'fy_daemon_fixture',
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => ({}) as never },
  });
  return Object.assign(w, { service }) as World;
}

/** A request as the kernel hands it to a handler on a door. */
export function door(
  method: string,
  path: string,
  options: {
    readonly body?: string;
    readonly contentType?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly arrival?: ApiRequest['arrival'];
    readonly address?: string;
  } = {},
): ApiRequest {
  const url = new URL(path, 'https://door.example');
  return {
    method,
    path: url.pathname,
    query: new Map([...new Set(url.searchParams.keys())].map(key => [key, url.searchParams.getAll(key)])),
    headers: new Map([
      ['content-type', options.contentType ?? 'application/x-www-form-urlencoded'],
      ...Object.entries(options.headers ?? {}),
    ]),
    arrival: options.arrival ?? OWN_DOOR,
    clientAddress: options.address ?? '203.0.113.7',
    text: async () => options.body ?? '',
  } as ApiRequest;
}

export { OWN_DOOR, TUNNEL_DOOR };

/** The owner's call context: who acts and what the boundary derived for them. */
export function owner(
  options: {
    readonly params?: Record<string, string>;
    readonly body?: unknown;
    readonly actor?: string;
    readonly governed?: boolean;
    /** The acts this caller holds a fresh passkey proof for (claimed once). */
    readonly proofs?: string[];
  } = {},
): CallContext {
  const proofs = [...(options.proofs ?? [])];
  return {
    request: {
      method: 'POST',
      path: '/v1/connector',
      query: new Map(),
      headers: new Map(),
      arrival: { kind: 'local', privileged: false },
      text: async () => (options.body === undefined ? '' : JSON.stringify(options.body)),
    } as unknown as ApiRequest,
    params: new Map(Object.entries(options.params ?? {})),
    actor: options.actor ?? 'admin-cli',
    governance: options.governed === true ? { governed: true } : { governed: false },
    claimFreshStepUp: (act?: string) => {
      const at = proofs.indexOf(act ?? '');
      if (at < 0) return false;
      proofs.splice(at, 1);
      return true;
    },
  } as unknown as CallContext;
}

/** DCR → authorize → the waiting page's handle: one sign-in waiting for the owner. */
export async function signIn(w: World, name = 'Claude') {
  const [oauth] = w.service.handlers;
  if (oauth === undefined) throw new Error('no oauth handler');
  const registered = await oauth.handle(
    door('POST', '/oauth/register', {
      contentType: 'application/json',
      body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    }),
  );
  const client = JSON.parse(registered?.body ?? '{}') as { client_id: string };
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER))),
  );
  const authorize = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-1',
  });
  const redirected = await oauth.handle(door('GET', `/oauth/authorize?${authorize.toString()}`));
  const wait = new URL(redirected?.headers.get('location') ?? '');
  return { clientId: client.client_id, wait: `${wait.pathname}${wait.search}`, challenge };
}
