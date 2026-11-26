import { GatePort } from '@ferretry/core-gate/contract';
import { definePlugin, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { ConnectionsPort } from '@ferretry/plugin-connections/contract';
import {
  APPROVE_CONNECTOR,
  CONNECTOR_CALLS,
  CONNECTOR_CONFIG,
  CONNECTOR_STATE,
  CONNECTOR_WORDS,
  GUARD_DOOR,
  GUARD_NONE,
  PAIRING_CONFIGURE,
  PAIRING_NARROWING,
  PAIRING_USE,
  RECORDED_BY_AUTHORITY,
  RECORDED_BY_HANDLER,
  SKIP_READ,
} from './contract/index.ts';

/**
 * Connector (docs/mcp-connector.md): the remote MCP connector — the Claude app reaches this machine's ferrets after the
 * owner approves it.
 *
 * TWO KINDS OF ROUTE, and the line between them is the whole security design:
 *
 * - The DOOR routes (`door: 'public'`) are the OAuth authorization server and `/mcp`. They are served ONLY to a public
 *   door arrival (this plugin's own `127.0.0.1` listener, or the built-in tunnel while it serves doors), never on the
 *   API listener or inside a session, and Gate parses no credential there: the handler reads its own bearer. Whether the
 *   connector is ON is the handler's answer (a door descriptor cannot carry a function), and off is exactly an unrouted
 *   path's 404.
 * - The OWNER routes (`/v1/connector…`) are a person's: a ferret and the connector's own principal are refused. Approving
 *   asks a passkey proved fresh for `approve-connector`; denying and revoking only take away.
 *
 * `/mcp` itself and the eleven tools arrive in a later unit; its route answers 401 / 501 until then.
 */
const DOOR = {
  door: 'public',
  minimum: 'none',
  caller: 'any',
  noStore: true,
  audit: RECORDED_BY_AUTHORITY,
  guard: GUARD_DOOR,
} as const;

export default definePlugin({
  id: 'connector',
  title: 'Connector',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  words: CONNECTOR_WORDS,

  // Gate records the connector's security events. Connections answers the built-in tunnel's hostname when no `publicUrl` is set.
  needs: { gate: GatePort },
  uses: { connections: ConnectionsPort },

  actions: {
    routes: [
      route('GET /.well-known/oauth-protected-resource', DOOR),
      route('GET /.well-known/oauth-protected-resource/mcp', DOOR),
      route('GET /.well-known/oauth-authorization-server', DOOR),
      route('POST /oauth/register', DOOR),
      route('GET /oauth/authorize', DOOR),
      route('GET /oauth/authorize/wait', DOOR),
      route('POST /oauth/token', DOOR),
      route('POST /oauth/revoke', DOOR),
      route('POST /mcp', DOOR),
      route('GET /mcp', DOOR),
      route('DELETE /mcp', DOOR),

      route('GET /v1/connector', {
        minimum: 'operator',
        caller: 'person',
        capability: PAIRING_USE,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('PUT /v1/connector', {
        minimum: 'operator',
        caller: 'person',
        capability: PAIRING_CONFIGURE,
        noStore: true,
        audit: RECORDED_BY_HANDLER,
        guard: GUARD_NONE,
      }),
      route('POST /v1/connector/requests/:id/approve', {
        minimum: 'operator',
        caller: 'person',
        capability: APPROVE_CONNECTOR,
        noStore: true,
        audit: RECORDED_BY_AUTHORITY,
        guard: GUARD_NONE,
      }),
      route('POST /v1/connector/requests/:id/deny', {
        minimum: 'operator',
        caller: 'person',
        capability: PAIRING_NARROWING,
        noStore: true,
        audit: RECORDED_BY_AUTHORITY,
        guard: GUARD_NONE,
      }),
      route('POST /v1/connector/grants/:id/revoke', {
        minimum: 'operator',
        caller: 'person',
        capability: PAIRING_NARROWING,
        noStore: true,
        audit: RECORDED_BY_AUTHORITY,
        guard: GUARD_NONE,
      }),
    ],
    cli: [
      verb('connector', {
        summary: 'see and approve the Claude connector that lets Claude read and drive your ferrets',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol document instead of the report' }],
      }),
      verb('connector status', {
        summary: 'show whether the connector is on, the sign-ins waiting, and the approved connections',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol document instead of the report' }],
      }),
      verb('connector approve', {
        summary: 'approve a sign-in by its match code or id (no passkey at the machine)',
        args: [{ name: 'request', help: 'the match code (K7Q-2MF) or id (cr_…) shown on the waiting page' }],
        options: [{ flag: '--json', help: 'print the grant as JSON' }],
      }),
      verb('connector deny', {
        summary: 'turn a sign-in down by its match code or id',
        args: [{ name: 'request', help: 'the match code or id of the sign-in' }],
        options: [{ flag: '--json', help: 'print the request as JSON' }],
      }),
      verb('connector revoke', {
        summary: "take an approved connection's access away; it is refused on its next call",
        args: [{ name: 'grant', help: 'the grant id (cg_…) from `fy connector`' }],
        options: [{ flag: '--json', help: 'print the grant as JSON' }],
      }),
    ],
  },

  data: {
    state: [CONNECTOR_STATE, CONNECTOR_CALLS],
    config: [CONNECTOR_CONFIG],
  },

  // The public door opens only for this plugin (a fixed kernel allow-list; declaring it cannot extend the list).
  permissions: { publicDoor: true },

  // The Settings › Claude connector tab: next to Connection (15), in the same group, so the owner finds where Claude reaches this machine beside how their own devices do.
  ui: {
    settings: [
      settingsTab('connector', { icon: 'plug-zap', group: 'devices-access', label: 'Claude connector', order: 16 }),
    ],
  },
});
