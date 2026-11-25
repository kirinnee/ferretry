import type {
  ApiRequest,
  Cancel,
  ConfigPort,
  Log,
  PublicDoorHandle,
  PublicDoorPort,
  StatePort,
} from '@ferretry/kernel/contract';
import {
  CONNECTOR_CONFIG,
  ConnectorConfigSchema,
  type ConnectorChange,
  type ConnectorStatus,
  ConnectorStatusSchema,
} from '../../contract/index.ts';
import { webCryptoConnector } from './crypto.ts';
import { ConnectorOAuthHttp } from './http/oauth-http.ts';
import { ConnectorMcpStub } from './http/mcp-stub.ts';
import { ConnectorAuthority } from './oauth/authority.ts';
import { ConnectorMemory } from './oauth/model.ts';
import { ConnectorRateLimiter } from './oauth/rate-limiter.ts';
import { doorPeer } from './peer.ts';
import type { ConnectorAuditSink, ConnectorEndpoints, ConnectorHttpHandler } from './ports.ts';
import { type ConnectorSettings, connectorSettings } from './settings.ts';
import { KernelConnectorStore } from './store.ts';

/** What the service needs from the kernel, as ports: nothing here reads a clock, a file or an address itself. */
export interface ConnectorServiceDeps {
  readonly config: Pick<ConfigPort, 'file' | 'watch' | 'fileState' | 'writeAsOwner'>;
  readonly state: Pick<StatePort, 'read' | 'write'>;
  readonly publicDoor: PublicDoorPort;
  readonly audit: ConnectorAuditSink;
  readonly clock: { now(): number };
  /** The built-in tunnel's hostname as an origin (`https://<id>.<zone>`), or `undefined` while it has none. Read at every use. */
  readonly tunnelOrigin: () => string | undefined;
  /** Where the app is: the waiting page's "Open Ferretry" link points there. */
  readonly appOrigin: string;
  readonly daemonId: string;
  readonly log: Log;
}

/** The answer of a switch: done, or a sentence saying why not. Nothing is left changed when it is a refusal. */
export type ConnectorChangeResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

const WAITING_FOR_TUNNEL =
  "The connector is on, and waiting for this machine's built-in tunnel. Turn the tunnel on in Settings › Connection.";
const STARTING = 'The connector is starting; ask again in a moment.';

/**
 * THE CONNECTOR, WIRED (docs/mcp-connector.md "Where it listens"): the authorization server and its door, kept in step
 * with `config/connector.yaml`.
 *
 * WHERE IT IS SERVED depends on whose address it has. An operator's own `publicUrl` WINS and is never overwritten: the
 * connector listens on its own `127.0.0.1` port for whatever tunnel the operator runs, and the built-in tunnel does NOT
 * serve it. With no `publicUrl` the issuer is this machine's built-in tunnel hostname and the tunnel's own listener serves
 * the door routes; no port of the connector's own is bound. If that hostname ever changes, the issuer and every token's
 * audience change with it and every token stops, by design.
 *
 * LIVE. The config is watched: a changed address, port or switch re-opens or closes the listener at once, and turning it
 * off stops answering at once (the handlers say 404 the moment the config says off, whatever door the request used).
 */
export class ConnectorService {
  readonly authority: ConnectorAuthority;
  readonly handlers: readonly ConnectorHttpHandler[];
  readonly endpoints: ConnectorEndpoints;
  readonly store: KernelConnectorStore;
  private door: { readonly port: number; readonly handle: PublicDoorHandle } | undefined;
  /** Why a switched-on connector could not open its own listener, until it can. */
  private problem: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private watching: Cancel | undefined;

  constructor(private readonly deps: ConnectorServiceDeps) {
    const service = this;
    // Getters, never a snapshot: the tunnel's hostname is known only once it is provisioned, and can change.
    const origin = (): string => service.origin() ?? 'https://connector.invalid';
    this.endpoints = {
      get issuer() {
        return origin();
      },
      get resource() {
        return `${origin()}/mcp`;
      },
      get resourceMetadataUrl() {
        return `${origin()}/.well-known/oauth-protected-resource/mcp`;
      },
      appOrigin: deps.appOrigin,
      daemonId: deps.daemonId,
    };
    this.store = new KernelConnectorStore(deps.state);
    this.authority = new ConnectorAuthority({
      clock: deps.clock,
      crypto: webCryptoConnector,
      store: this.store,
      audit: deps.audit,
      endpoints: this.endpoints,
      // Read live: an extra redirect URI the owner confirmed applies without a restart.
      get allowedRedirectUris() {
        const settings = service.settings();
        return settings.kind === 'enabled' ? settings.redirectUris : [];
      },
      memory: new ConnectorMemory(),
      limiter: new ConnectorRateLimiter(deps.clock),
    });
    this.handlers = [
      new ConnectorOAuthHttp(this.authority, this.endpoints),
      new ConnectorMcpStub(this.authority, this.endpoints),
    ];
  }

  // ─── what the config says now ──────────────────────────────────────────────────────────────────────────────────

  /** The file in effect (its last good version); a file with none in effect reads as off. */
  settings(): ConnectorSettings {
    const state = this.deps.config.fileState(CONNECTOR_CONFIG);
    if (state.state === 'invalid' && !state.inEffect)
      return {
        kind: 'disabled',
        reason: `The connector is off: config/connector.yaml is not valid (${state.sentences[0] ?? 'unreadable'}).`,
      };
    return connectorSettings(this.deps.config.file(CONNECTOR_CONFIG) ?? ConnectorConfigSchema.parse({}));
  }

  /** The address Claude is given: the operator's own, else the built-in tunnel's, else none yet. */
  origin(): string | undefined {
    const settings = this.settings();
    return settings.kind === 'enabled' ? (settings.publicUrl ?? this.deps.tunnelOrigin()) : undefined;
  }

  /**
   * Whether the door answers THIS request: switched on, an address to give, and not the tunnel's door when the operator's
   * own address wins. Anything else is the 404 an unrouted path gets.
   */
  serving(request: Pick<ApiRequest, 'arrival'>): boolean {
    const settings = this.settings();
    if (settings.kind !== 'enabled' || this.origin() === undefined) return false;
    const arrival = request.arrival;
    if (arrival.kind !== 'door') return false;
    return arrival.door === 'own' ? settings.publicUrl !== undefined : settings.publicUrl === undefined;
  }

  // ─── the owner's view ──────────────────────────────────────────────────────────────────────────────────────────

  async status(): Promise<ConnectorStatus> {
    const settings = this.settings();
    const held = this.deps.config.fileState(CONNECTOR_CONFIG).state === 'held';
    const grants = await this.authority.grants().catch(() => []);
    // Granted access is listed — and revocable — whether or not the connector is reachable: an owner who switched it off
    // to contain a grant must be able to end that grant without switching it back on.
    const off = (reason: string, switchedOn: boolean): ConnectorStatus =>
      ConnectorStatusSchema.parse({
        enabled: false,
        switchedOn,
        disabledReason: reason,
        pending: [],
        grants: [...grants],
      });
    if (settings.kind === 'disabled')
      return off(
        held ? 'Switching the connector on is waiting for your confirmation in the Ferretry app.' : settings.reason,
        false,
      );
    if (this.problem !== undefined) return off(this.problem, true);
    const origin = this.origin();
    if (origin === undefined) return off(WAITING_FOR_TUNNEL, true);
    if (settings.publicUrl !== undefined && this.door === undefined) return off(STARTING, true);
    return ConnectorStatusSchema.parse({
      enabled: true,
      switchedOn: true,
      publicUrlSource: settings.publicUrl === undefined ? 'tunnel' : 'configured',
      publicUrl: origin,
      mcpUrl: `${origin}/mcp`,
      pending: [...(await this.authority.pending())],
      grants: [...grants],
    });
  }

  /** The boot sentence: what the connector is doing, in one line. */
  bootNotice(): string {
    const settings = this.settings();
    if (settings.kind === 'disabled') return settings.reason;
    if (this.problem !== undefined) return `! connector not started: ${this.problem}`;
    return settings.publicUrl === undefined
      ? 'connector on, served over the built-in tunnel once it has a hostname'
      : `connector listening on 127.0.0.1:${String(settings.port)} for ${settings.publicUrl}/mcp`;
  }

  // ─── the listener ──────────────────────────────────────────────────────────────────────────────────────────────

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Brings the own-address listener in step with the config: open for an operator's address while on, closed otherwise. */
  reconcile(): Promise<string | undefined> {
    return this.serially(() => this.bind());
  }

  /** The work of {@link reconcile}, for a caller already inside the queue. */
  private async bind(): Promise<string | undefined> {
    const settings = this.settings();
    const wanted = settings.kind === 'enabled' && settings.publicUrl !== undefined ? settings.port : undefined;
    if (this.door !== undefined && this.door.port !== wanted) {
      const closing = this.door;
      this.door = undefined;
      await closing.handle.close();
    }
    this.problem = undefined;
    if (wanted !== undefined && this.door === undefined) {
      try {
        const handle = await this.deps.publicDoor.open({ port: wanted, peer: doorPeer });
        this.door = { port: wanted, handle };
      } catch (error) {
        this.problem = `The connector is on in config/connector.yaml but could not listen on 127.0.0.1:${String(wanted)}: ${error instanceof Error ? error.message : String(error)}`;
        this.deps.log.warn('the connector could not open its own listener', { port: wanted });
      }
    }
    return this.problem;
  }

  /** Brings the connector up for the config as it is, and follows every later change of it. */
  async start(): Promise<void> {
    this.watching ??= this.deps.config.watch(CONNECTOR_CONFIG, () => {
      void this.reconcile();
    });
    await this.reconcile();
    this.deps.log.info(this.bootNotice());
  }

  async stop(): Promise<void> {
    this.watching?.();
    this.watching = undefined;
    await this.serially(async () => {
      const closing = this.door;
      this.door = undefined;
      await closing?.handle.close();
    });
  }

  // ─── the switch ────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `PUT /v1/connector`: ONLY `enabled` is written, through the kernel's one config writer (the caller is a person; a
   * ferret and the connector's own principal never reach this). A switch-on that the config judge holds for the owner's
   * confirmation, a damaged state file or a taken port is a refusal with its sentence and leaves the file saying off.
   */
  change(change: ConnectorChange, actor: string): Promise<ConnectorChangeResult> {
    return this.serially(async (): Promise<ConnectorChangeResult> => {
      const file = this.deps.config.fileState(CONNECTOR_CONFIG);
      if (change.enabled) {
        if (file.state === 'invalid' && !file.inEffect)
          return {
            ok: false,
            message: `config/connector.yaml is not valid (${file.sentences[0] ?? 'unreadable'}); fix it, then switch the connector on.`,
          };
        // A damaged connector.json refuses here, loudly, rather than serving a door whose every token fails.
        try {
          await this.store.load();
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'The connector state could not be read.',
          };
        }
      }
      const refusal = await this.write(change.enabled);
      if (refusal !== undefined) return { ok: false, message: refusal };
      if (change.enabled) {
        // Opened here, inside the switch's own turn, so its answer is the switch's answer.
        const problem = await this.bind();
        if (problem !== undefined) {
          await this.write(false);
          await this.bind();
          return { ok: false, message: problem };
        }
      } else await this.bind();
      await this.deps.audit.record({ kind: 'connector.switched', enabled: change.enabled, actor });
      return { ok: true };
    });
  }

  /** Writes `enabled` and nothing else. A refusal is the sentence a person reads; `undefined` means it is in effect. */
  private async write(enabled: boolean): Promise<string | undefined> {
    const outcome = await this.deps.config.writeAsOwner(CONNECTOR_CONFIG, undefined, { patch: { enabled } });
    if (outcome.kind === 'written') return undefined;
    if (outcome.kind === 'held')
      return `Switching the connector on is waiting for your confirmation in the Ferretry app (${outcome.sentences.join(' ')})`.trim();
    if (outcome.kind === 'conflict')
      return 'config/connector.yaml changed while it was being written; read it again and retry.';
    return `config/connector.yaml could not be written: ${outcome.issues.map(issue => issue.message).join('; ') || 'refused'}`;
  }
}
