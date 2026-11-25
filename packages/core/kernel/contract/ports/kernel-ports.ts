import type { ActRunner } from '../act.ts';
import type { Redaction } from '../bound.ts';
import type { SecretsPort } from '../secrets.ts';
import type { IdentitySigner } from '../session.ts';
import type { BindPort } from './bind.ts';
import type { CarrierListenerPort } from './carrier-listener.ts';
import type { Clock } from './clock.ts';
import type { ConfigFilesWriter, ConfigPort } from './config.ts';
import type { ContractPort } from './contract.ts';
import type { EventsPort } from './events.ts';
import type { FetchPort } from './fetch.ts';
import type { FileEventsPort } from './file-events.ts';
import type { HostFactsPort } from './host-facts.ts';
import type { IdentityPort } from './identity.ts';
import type { IdsPort } from './ids.ts';
import type { JobsPort } from './jobs.ts';
import type { LifecyclePort } from './lifecycle.ts';
import type { Log } from './log.ts';
import type { LoopPort } from './loop.ts';
import type { PathsPort } from './paths.ts';
import type { ProcessesPort } from './processes.ts';
import type { PublicDoorPort } from './public-door.ts';
import type { RootsPort } from './roots.ts';
import type { ScratchPort } from './scratch.ts';
import type { SelfCountersPort } from './self-counters.ts';
import type { SnapshotPort } from './snapshot.ts';
import type { SpawnPort } from './spawn.ts';
import type { StatePort } from './state.ts';
import type { DaemonTimings } from './timings.ts';
import type { UpdateHostPort } from './update-host.ts';
import type { WebSocketPort } from './websocket.ts';
import type { WorkersPort } from './workers.ts';

/**
 * The kernel ports every subsystem may receive in `build`, and nothing else from the kernel (§7.4). Halves never use
 * `Date.now`, `setTimeout`, `node:fs`, `process.env`, `fetch` or `Bun.spawn` directly (`banned-globals`, §7.7).
 */
export interface KernelPorts {
  readonly clock: Clock;
  readonly log: Log;
  readonly state: StatePort;
  readonly config: ConfigPort;
  readonly roots: RootsPort;
  readonly events: EventsPort;
  readonly jobs: JobsPort;
  readonly workers: WorkersPort;
  readonly spawn: SpawnPort;
  /** Fresh private (0700) folders for staging files a child reads (today's diff scratch), removed on close. */
  readonly scratch: ScratchPort;
  readonly fetch: FetchPort;
  /** WebSocket clients to the hosts the manifest declared in `permissions.network` (`ws:`/`wss:` only). */
  readonly websocket: WebSocketPort;
  /**
   * A loopback listener that serves ONE declared socket route and stamps every arrival `carried` (a carrier whose
   * traffic reaches this host through a local forwarder, like the tunnel's `cloudflared`). Refused unless the manifest
   * takes that carrier's hook and declares the route.
   */
  readonly carrierListener: CarrierListenerPort;
  /** Credential-less remote HTTP, only for the allow-listed plugin declaring `permissions.publicDoor`. */
  readonly publicDoor: PublicDoorPort;
  /** Where this daemon's own local listener really bound, once it has: read at the moment of use, never at build. */
  readonly bind: BindPort;
  /** Who this daemon is, read-only: its id and name, never its key. */
  readonly identity: IdentityPort;
  /** Read-only facts about where things are on this machine (daemon halves only; never on the app or CLI contexts). */
  readonly paths: PathsPort;
  /** Read-only facts about this machine from `/proc` and `/sys`; only for a manifest with `permissions.hostFacts`. */
  readonly hostFacts: HostFactsPort;
  /** THIS process's own `/proc/self/io` and `/proc/self/stat` counters and nothing else; only for a manifest with `permissions.selfCounters`. */
  readonly selfCounters: SelfCountersPort;
  /** Which directories the host polls instead of watching for file events; only for a manifest with `permissions.fileEvents`. */
  readonly fileEvents: FileEventsPort;
  /**
   * This user's live processes, as pids and yes/no answers only, and SIGTERM to one that runs from this plugin's own
   * folder; only for a manifest with `permissions.processes` ({@link ProcessesPort}).
   */
  readonly processes: ProcessesPort;
  /** The running build and its self-update launch; only for a manifest with `permissions.updateHost` (Updates). */
  readonly updateHost: UpdateHostPort;
  /**
   * The daemon's time-bound rules as this boot runs them: the shipped numbers, or `FYD_TEST_TIMINGS`'s shorter ones
   * (R247). Read-only; Access's idle expiry counts in `idleDayMs`.
   */
  readonly timings: DaemonTimings;
  /** How blocked this daemon's event loop has been, read-only and open to every plugin ({@link LoopPort}). */
  readonly loop: LoopPort;
  /** This plugin's OWN secrets, for its own daemon-side use: declared, named by its own config, known to the Vault. */
  readonly secrets: SecretsPort;
  /**
   * The daemon identity's fixed-label signatures (claim, tunnel, catalog), each refused unless this plugin is the
   * one allowed it (`sign`/`signTunnel`: Connections; `signCatalog`, `signLinkStoreRequest`: Catalogs). No key export, no raw signing.
   */
  readonly signer: IdentitySigner;
  /** The writer over every declared config file: Gate's alone, `undefined` for every other plugin. */
  readonly configFiles?: ConfigFilesWriter;
  readonly act: ActRunner;
  readonly ids: IdsPort;
  readonly redaction: Redaction;
  readonly snapshot: SnapshotPort;
  readonly lifecycle: LifecyclePort;
  /** This plugin's OWN effective contract hash, and no other package's (§9.6). */
  readonly contract: ContractPort;
}
