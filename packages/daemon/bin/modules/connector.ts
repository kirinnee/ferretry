import { AsyncLocalStorage } from 'node:async_hooks';
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
import {
  CLAUDE_REDIRECT_URI,
  CONNECTOR_DEFAULT_PORT,
  type ConnectorConfiguration,
  connectorConfiguration,
} from '../../src/lib/connector/config.ts';
import { connectorListenerSurface, InProcessConnectorDispatch } from '../../src/lib/connector/listener.ts';
import { ConnectorTextGuard } from '../../src/lib/connector/mcp/redaction.ts';
import { ConnectorToolbox } from '../../src/lib/connector/mcp/tools.ts';
import { ConnectorAuthority } from '../../src/lib/connector/oauth/authority.ts';
import { unauthorizedResponse } from '../../src/lib/connector/oauth/discovery.ts';
import { ConnectorMemory } from '../../src/lib/connector/oauth/model.ts';
import { ConnectorRateLimiter } from '../../src/lib/connector/oauth/rate-limiter.ts';
import type { ConnectorEndpoints, ConnectorHttpHandler } from '../../src/lib/connector/ports.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import type {
  ConnectorAvailability,
  ConnectorChangeResult,
  ConnectorSubsystem,
} from '../../src/lib/runtime/mounts/connector.ts';
import type { TextRedactor } from '../../src/lib/secrets/redaction.ts';
import { daemonVersion } from '../../src/lib/version.ts';

/**
 * The remote MCP connector (docs/mcp-connector.md): the OAuth authorization server, the owner's
 * `/v1/connector/*` routes over it, and — once the daemon is serving — the routes it answers on.
 *
 * See `./learning.ts` for what a module file owns. TWO CONSTRUCTION POINTS: `build` makes the authority and the
 * owner's routes while the subsystems are made (the routes are mounted with every other route), and
 * `provides.listen` is called once in `start`, after the main dispatcher exists, because every tool acts
 * through that dispatcher.
 *
 * THE OWNER CAN SWITCH IT LIVE. Whether it is on is the one `connector.enabled` fact in `config/daemon.json`, read at
 * boot and changed by `PUT /v1/connector` (`change`) without a restart — the same key a host edit writes, written first.
 * WHERE it is served depends on whose address it has:
 *
 * - an operator's own `connector.publicUrl` wins and is never overwritten: the connector listens on its own loopback
 *   port for whatever tunnel the operator runs, exactly as before, and the built-in tunnel does NOT serve it;
 * - with no `publicUrl`, the issuer is this machine's built-in tunnel hostname and the connector's HTTP handlers are
 *   offered to the tunnel's own listener (`tunnelHandlers`) — no port of its own is bound. If the hostname ever
 *   changes, issuer and audience change with it and every token stops by design.
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
  /** The built-in tunnel's hostname as an origin (`https://<id>.<zone>`), or `undefined` while it has none. */
  readonly tunnelOrigin: () => string | undefined;
  /** The `connector` block of the document AS IT IS NOW (not as this boot read it), so a switch-on judges what it would write beside. */
  readonly readBlock: () => Promise<unknown>;
  /** Writes `connector.enabled` into the operator's document and nothing else. Rejects with a sentence's worth of error. */
  readonly writeEnabled: (enabled: boolean) => Promise<void>;
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
  /** The boot sentence: what the connector is doing, in one line. */
  readonly bootNotice: () => string;
  /** The `/v1/connector/*` routes' subsystem. */
  readonly subsystem: ConnectorSubsystem;
  /**
   * Called once when the daemon is serving. Remembers what the tools act through and, when the connector is on, brings
   * it up. What it binds (only ever the operator's own listener) releases through the lifecycle, registered the first
   * time something is bound. Never throws for a connector that cannot start — that is said in the availability sentence
   * and the boot log — only for a programming error.
   */
  listen(needs: ConnectorListenNeeds): Promise<void>;
  /**
   * The HTTP handlers the built-in tunnel's listener should offer right now: none unless the connector is on, serving, has
   * no address of the operator's own, and the tunnel has a hostname. Read on every request.
   */
  tunnelHandlers(): readonly ConnectorHttpHandler[];
}

const NOT_SWITCHED_ON = 'The connector is off. Switch it on in the app (Settings › Claude connector).';

function connectorEndpoints(
  origin: () => string,
  appOrigin: string,
  daemonId: () => string | undefined,
): ConnectorEndpoints {
  // Getters, never a snapshot: the tunnel's hostname is only known once it is provisioned, and can change.
  return {
    get issuer() {
      return origin();
    },
    get resource() {
      return `${origin()}/mcp`;
    },
    get resourceMetadataUrl() {
      return `${origin()}/.well-known/oauth-protected-resource/mcp`;
    },
    appOrigin,
    get daemonId() {
      return daemonId() ?? 'unknown';
    },
  };
}

export const connectorModule: DaemonModule<void, ConnectorNeeds, ConnectorModule> = {
  id: 'connector',
  build: (needs, _seams, lifecycle) => {
    const configuration: ConnectorConfiguration = connectorConfiguration(needs.block);
    // A damaged block can never be switched on (the sentence says what to fix), but the saved grants stay listed and
    // revocable: the authority is built either way, with the one redirect URI that needs no configuration.
    const invalidReason = configuration.kind === 'invalid' ? configuration.reason : undefined;
    const settings =
      configuration.kind === 'valid'
        ? configuration.settings
        : ({
            kind: 'enabled',
            publicUrl: undefined,
            port: CONNECTOR_DEFAULT_PORT,
            redirectUris: [CLAUDE_REDIRECT_URI],
          } as const);
    const configuredOrigin = settings.publicUrl;
    /** The address Claude is given: the operator's own, else the built-in tunnel's, else none yet. */
    const originNow = (): string | undefined => configuredOrigin ?? needs.tunnelOrigin();
    const endpoints = connectorEndpoints(
      () => originNow() ?? 'https://connector.invalid',
      needs.appOrigin,
      needs.daemonId,
    );
    const store = new FileConnectorStore(needs.stateDirectory);
    const audit = new SecurityLogConnectorAudit(needs.audit);
    let authority: ConnectorAuthority | undefined;
    const authorityOf = (): ConnectorAuthority => {
      authority ??= new ConnectorAuthority({
        clock: needs.clock,
        crypto: webCryptoConnector,
        store,
        audit,
        endpoints,
        allowedRedirectUris: settings.redirectUris,
        memory: new ConnectorMemory(),
        limiter: new ConnectorRateLimiter(needs.clock),
      });
      return authority;
    };
    /** Whether it is switched on: the document's answer at boot, then `change`'s. */
    let on = configuration.kind === 'valid' && configuration.enabled;
    /**
     * Which switched-on period a request began in. Bumped on every off, so a request that was authenticated in an
     * earlier period and resumes after the switch went off AND on again is still refused at the tools' door.
     */
    let epoch = 0;
    const requestEpoch = new AsyncLocalStorage<number>();
    /** Why a switched-on connector could not start, until it can. */
    let startProblem: string | undefined;
    let listenNeeds: ConnectorListenNeeds | undefined;
    /** The handlers, once the tools' door exists and the store has loaded. */
    let handlers: readonly ConnectorHttpHandler[] | undefined;
    /** The connector's own loopback listener, bound only for an operator's own address. */
    let bound: { close(): Promise<void> } | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    const serially = async <T>(work: () => Promise<T>): Promise<T> => {
      const run = queue.then(work);
      queue = run.catch(() => undefined);
      return await run;
    };

    /**
     * Handlers that answer only while the connector is SWITCHED ON. Every surface that serves them (the operator's own
     * loopback listener, the tunnel's) is given these, so a listener that came up ahead of the switch's commit — or a
     * request still arriving after an off — is the same 404 as any other path, and an authenticated request already in
     * flight cannot reach a fleet route after the switch said off (the tools' door below checks it again).
     */
    const gated = (inner: readonly ConnectorHttpHandler[]): readonly ConnectorHttpHandler[] =>
      inner.map(handler => ({
        handle: async request =>
          on ? await requestEpoch.run(epoch, async () => await handler.handle(request)) : undefined,
      }));

    const buildHandlers = async (needsNow: ConnectorListenNeeds): Promise<readonly ConnectorHttpHandler[]> => {
      // A damaged connector.json refuses here, loudly, rather than serving handlers whose every token fails.
      await store.load();
      const mcp = new ConnectorMcpEndpoint({
        verifier: authorityOf(),
        unauthorized: tokenPresented => unauthorizedResponse(endpoints, { tokenPresented }),
        dispatch: new InProcessConnectorDispatch({
          dispatch: async request =>
            on && requestEpoch.getStore() === epoch
              ? await needsNow.dispatch(request)
              : {
                  status: 503,
                  headers: new Map(),
                  body: JSON.stringify({ error: 'the connector was switched off', code: 'connector_disabled' }),
                },
          adminToken: needsNow.adminToken,
        }),
        toolbox: new ConnectorToolbox({
          daemonGrants: needs.daemonGrants,
          guard: new ConnectorTextGuard(needs.redactor, () => [needsNow.adminToken(), needsNow.wardenToken?.()]),
          callsLog: new FileConnectorCallsLog(join(needs.stateDirectory, 'connector')),
          audit,
          now: () => needs.clock.now(),
        }),
        now: () => needs.clock.now(),
        newRequestId: () => `connector-${randomUUID()}`,
        serverVersion: daemonVersion,
      });
      return gated([new ConnectorOAuthHttp(authorityOf(), endpoints), mcp]);
    };

    /** Brings it up for the current state: handlers always, and the loopback listener when the address is the operator's own. */
    let releaseRegistered = false;
    const bringUp = async (needsNow: ConnectorListenNeeds): Promise<void> => {
      if (lifecycle.releasing()) throw new Error('the daemon is shutting down');
      handlers ??= await buildHandlers(needsNow);
      if (configuredOrigin !== undefined && bound === undefined) {
        const listener = await needsNow.api.listen(connectorListenerSurface(handlers), {
          host: '127.0.0.1',
          port: settings.port,
          directLoopbackIsPrivileged: false,
          remotePeer: needsNow.remotePeer,
        });
        bound = {
          close: async () => {
            listener.closeSockets();
            await listener.stop();
          },
        };
        if (!releaseRegistered) {
          releaseRegistered = true;
          lifecycle.onRelease('connector listener', async () => await serially(bringDown));
        }
      }
    };
    const bringDown = async (): Promise<void> => {
      const closing = bound;
      bound = undefined;
      await closing?.close();
    };

    const availability = (): ConnectorAvailability => {
      if (invalidReason !== undefined) return { enabled: false, disabledReason: invalidReason, switchedOn: false };
      if (!on) return { enabled: false, disabledReason: NOT_SWITCHED_ON, switchedOn: false };
      if (startProblem !== undefined) return { enabled: false, disabledReason: startProblem, switchedOn: true };
      if (handlers === undefined)
        return {
          enabled: false,
          disabledReason: 'The connector is starting; ask again in a moment.',
          switchedOn: true,
        };
      if (configuredOrigin !== undefined) {
        if (bound === undefined)
          return {
            enabled: false,
            disabledReason: 'The connector is starting; ask again in a moment.',
            switchedOn: true,
          };
        return { enabled: true, publicUrl: configuredOrigin, mcpUrl: `${configuredOrigin}/mcp`, source: 'configured' };
      }
      const tunnel = needs.tunnelOrigin();
      if (tunnel === undefined)
        return {
          enabled: false,
          switchedOn: true,
          disabledReason:
            "The connector is on, and waiting for this machine's built-in tunnel. Turn the tunnel on in Settings › Connection.",
        };
      return { enabled: true, publicUrl: tunnel, mcpUrl: `${tunnel}/mcp`, source: 'tunnel' };
    };

    const change = async (enabled: boolean): Promise<ConnectorChangeResult> =>
      await serially(async (): Promise<ConnectorChangeResult> => {
        if (invalidReason !== undefined) return { ok: false, message: invalidReason };
        if (enabled) {
          // The switch judges the file as it is NOW: an address, port or redirect list the operator changed since this
          // daemon booted is not what is running, and switching on beside it would publish something they did not ask for.
          const current = connectorConfiguration(await needs.readBlock().catch(() => undefined));
          if (current.kind === 'invalid') return { ok: false, message: current.reason };
          if (JSON.stringify(current.settings) !== JSON.stringify(settings))
            return {
              ok: false,
              message:
                'The connector settings in config/daemon.json changed after this daemon started. Restart it (fy daemon restart) so they apply, then switch the connector on.',
            };
          if (listenNeeds === undefined)
            return { ok: false, message: 'The daemon is still starting. Try again in a moment.' };
        }
        try {
          if (enabled) {
            // Bring it up BEFORE writing the document: a damaged connector.json or a taken port must refuse with its
            // sentence and leave the document saying off, rather than record an "on" nothing answers.
            startProblem = undefined;
            if (listenNeeds !== undefined) await bringUp(listenNeeds);
            // Judged again immediately before the write: the narrowest window a hand edit can land in.
            const again = connectorConfiguration(await needs.readBlock().catch(() => undefined));
            if (again.kind !== 'valid' || JSON.stringify(again.settings) !== JSON.stringify(settings))
              throw new Error(
                'config/daemon.json changed while the connector was starting; restart the daemon and try again',
              );
            await needs.writeEnabled(true);
            on = true;
          } else {
            await needs.writeEnabled(false);
            on = false;
            epoch += 1;
            startProblem = undefined;
            await bringDown();
          }
        } catch (error) {
          if (enabled && !on) await bringDown().catch(() => undefined);
          return {
            ok: false,
            message: `The connector could not be switched ${enabled ? 'on' : 'off'}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        return { ok: true };
      });

    const provides: ConnectorModule = {
      bootNotice: () => {
        if (invalidReason !== undefined) return invalidReason;
        if (!on) return NOT_SWITCHED_ON;
        if (startProblem !== undefined) return `! connector not started: ${startProblem}`;
        return configuredOrigin !== undefined
          ? `connector listening on 127.0.0.1:${settings.port} for ${configuredOrigin}/mcp`
          : 'connector on, served over the built-in tunnel once it has a hostname';
      },
      subsystem: {
        acts: {
          pending: async () => await authorityOf().pending(),
          grants: async () => await authorityOf().grants(),
          approve: async (id, by) => await authorityOf().approve(id, by),
          deny: async (id, by) => await authorityOf().deny(id, by),
          revoke: async (id, by) => await authorityOf().revoke(id, by),
        },
        availability,
        change,
      },
      listen: async needsNow =>
        await serially(async () => {
          listenNeeds = needsNow;
          if (on) {
            try {
              await bringUp(needsNow);
            } catch (error) {
              startProblem = `The connector is on in config/daemon.json but could not start: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        }),
      tunnelHandlers: () =>
        on && configuredOrigin === undefined && handlers !== undefined && needs.tunnelOrigin() !== undefined
          ? handlers
          : [],
    };
    return { id: 'connector', provides, jobs: {}, contributes: {} };
  },
};
