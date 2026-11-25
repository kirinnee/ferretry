import type { PluginClient, TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { ConnectorGrantViewSchema, ConnectorPendingViewSchema, ConnectorStatusSchema } from '../../contract/index.ts';
import { renderApproved, renderDenied, renderRevoked, renderStatus } from './render.ts';

/** The command a person types, so every message names it rather than inventing one. */
const CLIENT_NAME = 'fy';

type ConnectorVerb = 'connector' | 'connector status' | 'connector approve' | 'connector deny' | 'connector revoke';

/**
 * `fy connector …`, bound to the kernel's per-daemon client. This command line holds the host's admin token, so it is the
 * owner at the machine: approving needs no passkey here (docs/mcp-connector.md) and asks no confirmation — the match code
 * the owner types IS the confirmation, and it must match the page they opened from Claude. A refusal (not found, expired,
 * already decided, connector off) is the daemon's own sentence, printed by the shell with exit 1.
 */
export function buildConnectorVerbs(
  client: PluginClient,
  io: TerminalIo,
  nowMs: () => number,
): Record<ConnectorVerb, VerbHandler> {
  const json = (options: Readonly<Record<string, unknown>>): boolean => options.json === true;
  const status: VerbHandler = async ({ options }) => {
    const view = ConnectorStatusSchema.parse(await client.call('GET /v1/connector'));
    io.out(json(options) ? JSON.stringify(view) : renderStatus(view, CLIENT_NAME, nowMs()));
    return 0;
  };
  const act =
    (route: string, param: 'id', say: (answer: unknown, asJson: boolean) => string): VerbHandler =>
    async ({ args, options }) => {
      const target = args[0];
      if (target === undefined || target === '') {
        io.err('name the sign-in or grant to act on\n');
        return 2;
      }
      io.out(say(await client.call(route, { params: { [param]: target }, body: {} }), json(options)));
      return 0;
    };
  return {
    connector: status,
    'connector status': status,
    'connector approve': act('POST /v1/connector/requests/:id/approve', 'id', (answer, asJson) => {
      const grant = ConnectorGrantViewSchema.parse(answer);
      return asJson ? JSON.stringify(grant) : renderApproved(grant, CLIENT_NAME);
    }),
    'connector deny': act('POST /v1/connector/requests/:id/deny', 'id', (answer, asJson) => {
      const pending = ConnectorPendingViewSchema.parse(answer);
      return asJson ? JSON.stringify(pending) : renderDenied(pending);
    }),
    'connector revoke': act('POST /v1/connector/grants/:id/revoke', 'id', (answer, asJson) => {
      const grant = ConnectorGrantViewSchema.parse(answer);
      return asJson ? JSON.stringify(grant) : renderRevoked(grant);
    }),
  };
}
