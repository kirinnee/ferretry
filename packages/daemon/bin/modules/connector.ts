import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CapabilityGrants } from '@ferretry/protocol';
import { FileConnectorStore } from '../../src/adapters/connector/file-store.ts';
import { ConnectorOAuthHttp } from '../../src/adapters/connector/oauth-http.ts';
import { FileConnectorCallsLog } from '../../src/adapters/connector/mcp/calls-log.ts';
import { ConnectorMcpEndpoint } from '../../src/adapters/connector/mcp/mcp-endpoint.ts';
import { webCryptoConnector } from '../../src/adapters/connector/webcrypto.ts';
import type { ApiRequest, ApiResponse } from '../../src/lib/api/http.ts';
import type { ApiBindOptions, ApiServerPort } from '../../src/lib/api/server.ts';
import type { AuditSink } from '../../src/lib/audit/types.ts';
import { SecurityLogConnectorAudit } from '../../src/lib/connector/audit.ts';
import { type ConnectorSettings, connectorSettings } from '../../src/lib/connector/config.ts';
import { connectorListenerSurface, InProcessConnectorDispatch } from '../../src/lib/connector/listener.ts';
import { ConnectorTextGuard } from '../../src/lib/connector/mcp/redaction.ts';
import { ConnectorToolbox } from '../../src/lib/connector/mcp/tools.ts';
import { ConnectorAuthority } from '../../src/lib/connector/oauth/authority.ts';
import { unauthorizedResponse } from '../../src/lib/connector/oauth/discovery.ts';
import { ConnectorMemory } from '../../src/lib/connector/oauth/model.ts';
import { ConnectorRateLimiter } from '../../src/lib/connector/oauth/rate-limiter.ts';
import type { ConnectorEndpoints, ConnectorHttpHandler } from '../../src/lib/connector/ports.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import type { ConnectorAvailability, ConnectorSubsystem } from '../../src/lib/runtime/mounts/connector.ts';
import type { TextRedactor } from '../../src/lib/secrets/redaction.ts';
import { daemonVersion } from '../../src/lib/version.ts';

/**
 * The remote MCP connector (docs/mcp-connector.md): the OAuth authorization server, the owner's
 * `/v1/connector/*` routes over it, and — once the daemon is serving — its own loopback listener with `/mcp`.
 *
 * See `./learning.ts` for what a module file owns. TWO CONSTRUCTION POINTS: `build` makes the authority and the
 * owner's routes while the subsystems are made (the routes are mounted with every other route), and
 * `provides.listen` binds the listener in `start`, after the main dispatcher exists, because every tool acts
 * through that dispatcher. A connector that is off builds an authority-less subsystem whose routes say why, and
 * binds nothing.
 */

export interface ConnectorNeeds {
  /** The `connector` block of `config/daemon.json`, exactly as read (`unknown`, parsed here, never fatal). */
  readonly block: unknown;
  /** `<FY_HOME>/state`: `connector/connector.json` and `connector/calls.jsonl` live under it. */
  readonly stateDirectory: string;
  /** This daemon's id, for the app's deep link — known once pairing opened its state. */
  readonly daemonId: () => string | undefined;
  /** Where the app is (FY_APP_URL or the hosted app). */
  readonly appOrigin: string;
  readonly clock: { now(): number };
  readonly audit: AuditSink;
  /** The machine's enforced daemon-wide grants (`undefined`: cannot be read — every tool refuses). */
  readonly daemonGrants: () => CapabilityGrants | undefined;
  /** The fail-closed vault redactor operator reads use. */
  readonly redactor: TextRedactor;
}

interface ConnectorListenNeeds {
  readonly api: ApiServerPort;
  readonly dispatch: (request: ApiRequest) => Promise<ApiResponse>;
  readonly adminToken: () => string;
  /**
   * The warden's token, when this daemon runs one. With the admin token it is a bare base64url value no pattern
   * recognises, so the connector's text guard masks both as literals if a ferret ever prints one.
   */
  readonly wardenToken?: () => string | undefined;
  /** How a peer is keyed for rate limits behind `cloudflared` (`CF-Connecting-IP`, never trusted for authority). */
  readonly remotePeer: NonNullable<ApiBindOptions['remotePeer']>;
}

export interface ConnectorModule {
  readonly settings: ConnectorSettings;
  /** The `/v1/connector/*` routes' subsystem. */
  readonly subsystem: ConnectorSubsystem;
  /** Binds the listener when the connector is on; resolves to its closer, or `undefined` when off. */
  listen(needs: ConnectorListenNeeds): Promise<{ readonly url: string; close(): Promise<void> } | undefined>;
}

const OFF_ACTS: ConnectorSubsystem['acts'] = {
  pending: async () => [],
  grants: async () => [],
  approve: async () => ({ ok: false, code: 'not_found', message: 'The connector is off.' }),
  deny: async () => ({ ok: false, code: 'not_found', message: 'The connector is off.' }),
  revoke: async () => ({ ok: false, code: 'not_found', message: 'The connector is off.' }),
};

function connectorEndpoints(publicUrl: string, appOrigin: string, daemonId: string): ConnectorEndpoints {
  return {
    issuer: publicUrl,
    resource: `${publicUrl}/mcp`,
    resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
    appOrigin,
    daemonId,
  };
}

export const connectorModule: DaemonModule<void, ConnectorNeeds, ConnectorModule> = {
  id: 'connector',
  build: needs => {
    const settings = connectorSettings(needs.block);
    if (settings.kind === 'disabled') {
      const availability: ConnectorAvailability = { enabled: false, disabledReason: settings.reason };
      const provides: ConnectorModule = {
        settings,
        subsystem: { acts: OFF_ACTS, availability: () => availability },
        listen: async () => undefined,
      };
      return { id: 'connector', provides, jobs: {}, contributes: {} };
    }
    // The daemon id is known by the time any request arrives (pairing opens its state before the subsystems).
    const endpoints = (): ConnectorEndpoints =>
      connectorEndpoints(settings.publicUrl, needs.appOrigin, needs.daemonId() ?? 'unknown');
    const store = new FileConnectorStore(needs.stateDirectory);
    const audit = new SecurityLogConnectorAudit(needs.audit);
    let authority: ConnectorAuthority | undefined;
    const authorityOf = (): ConnectorAuthority => {
      authority ??= new ConnectorAuthority({
        clock: needs.clock,
        crypto: webCryptoConnector,
        store,
        audit,
        endpoints: endpoints(),
        allowedRedirectUris: settings.redirectUris,
        memory: new ConnectorMemory(),
        limiter: new ConnectorRateLimiter(needs.clock),
      });
      return authority;
    };
    // What the app and `fy connector` are told: ON only once the listener is actually bound, so a port that was taken
    // or a damaged connector.json never shows a copyable address nothing answers on.
    let availability: ConnectorAvailability = {
      enabled: false,
      disabledReason: 'The connector is starting; ask again in a moment.',
    };
    const provides: ConnectorModule = {
      settings,
      subsystem: {
        acts: {
          pending: async () => await authorityOf().pending(),
          grants: async () => await authorityOf().grants(),
          approve: async (id, by) => await authorityOf().approve(id, by),
          deny: async (id, by) => await authorityOf().deny(id, by),
          revoke: async (id, by) => await authorityOf().revoke(id, by),
        },
        availability: () => availability,
      },
      listen: async listenNeeds => {
        try {
          return await startListener(listenNeeds);
        } catch (error) {
          availability = {
            enabled: false,
            disabledReason: `The connector is on in config/daemon.json but could not start: ${error instanceof Error ? error.message : String(error)}`,
          };
          throw error;
        }
      },
    };
    const startListener = async (listenNeeds: ConnectorListenNeeds) => {
      // A damaged connector.json refuses here, loudly, rather than serving a listener whose every token fails.
      await store.load();
      const mcp = new ConnectorMcpEndpoint({
        verifier: authorityOf(),
        unauthorized: tokenPresented => unauthorizedResponse(endpoints(), { tokenPresented }),
        dispatch: new InProcessConnectorDispatch({
          dispatch: listenNeeds.dispatch,
          adminToken: listenNeeds.adminToken,
        }),
        toolbox: new ConnectorToolbox({
          daemonGrants: needs.daemonGrants,
          guard: new ConnectorTextGuard(needs.redactor, () => [listenNeeds.adminToken(), listenNeeds.wardenToken?.()]),
          callsLog: new FileConnectorCallsLog(join(needs.stateDirectory, 'connector')),
          audit,
          now: () => needs.clock.now(),
        }),
        now: () => needs.clock.now(),
        newRequestId: () => `connector-${randomUUID()}`,
        serverVersion: daemonVersion,
      });
      const handlers: ConnectorHttpHandler[] = [new ConnectorOAuthHttp(authorityOf(), endpoints()), mcp];
      const listener = await listenNeeds.api.listen(connectorListenerSurface(handlers), {
        host: '127.0.0.1',
        port: settings.port,
        directLoopbackIsPrivileged: false,
        remotePeer: listenNeeds.remotePeer,
      });
      availability = { enabled: true, publicUrl: settings.publicUrl, mcpUrl: `${settings.publicUrl}/mcp` };
      return {
        url: listener.url,
        close: async () => {
          listener.closeSockets();
          await listener.stop();
        },
      };
    };
    return { id: 'connector', provides, jobs: {}, contributes: {} };
  },
};
