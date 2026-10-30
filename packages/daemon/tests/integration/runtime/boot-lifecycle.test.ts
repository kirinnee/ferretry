import { afterEach, beforeEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { buildFleetManifest, RETIRED_FLEET_CONFIG_SENTENCE } from '@ferretry/fleet';
import {
  AnalyticsPricingViewSchema,
  AnalyticsResponseSchema,
  BrowserLoginStatusSchema,
  type ConfigChangeFrame,
  ConfigChangeFrameSchema,
  type ConfigChangeKind,
  ContextDowngradeRefusedBodySchema,
  ConversationMessagePointSchema,
  ConversationUnresumableBodySchema,
  type ConversionPreview,
  ConversionPreviewSchema,
  DaemonCarriersViewSchema,
  type FyEventStreamFrame,
  FyEventStreamFrameSchema,
  HealthViewSchema,
  LearningConfigSchema,
  LearningPatchResponseSchema,
  LearningStatusSchema,
  MigrationRefusedBodySchema,
  NameSuggestionsSchema,
  PairingCodeMintResponseSchema,
  PairingCodeStatusResponseSchema,
  ProposalViewSchema,
  pairingMintOutcome,
  RunManifestSchema,
  refusalNotice,
  SendResultSchema,
  SessionConfigSchema,
  SessionHypermediaPatchResultSchema,
  SessionListSchema,
  SessionPackPatchResultSchema,
  SessionResultSchema,
  SessionStateSchema,
  SessionTranscriptPageSchema,
  type SessionView,
  SessionViewSchema,
  type SttEnhancementResult,
  TerminalListViewSchema,
  TerminalViewSchema,
  TranscriptProvenanceSchema,
  TUNNEL_OFF_SENTENCE,
  TunnelStatusViewSchema,
  UNLOCK_REQUIRED_CODE,
  WILDCARD_BIND_HOST,
} from '@ferretry/protocol';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import { z } from 'zod';
import { buildWorld, checkConfiguration, type DaemonWorld, start, type WorldSeams } from '../../../bin/fyd.ts';
import {
  type BrowserLoginChild,
  type BrowserLoginRuntime,
  BrowserLoginWindowService,
  BrowserProfileStore,
  type BunRelayCarrier,
} from '../../../src/adapters/index.ts';
import { FileSessionEnvironmentStore } from '../../../src/adapters/session/lifecycle/index.ts';
import {
  FileSessionTranscriptMessageTokenCodec,
  sessionMessageTokenKeyFile,
} from '../../../src/adapters/session/transcript/file-message-token-codec.ts';
import { NodeTranscriptSource } from '../../../src/adapters/transcript/index.ts';
import { CloudflaredLocator } from '../../../src/adapters/tunnel/index.ts';
import {
  type BootNoticePort,
  CodexTranscriptParser,
  DEFAULT_CALLSIGN_POOL,
  digestConversation,
  EXIT_ADDRESS_CONFLICT,
  EXIT_ALREADY_RUNNING,
  type ExecutableResolverPort,
  MigrationPreflight,
  NO_RELAY_DIRECTORY,
  type PaneObservation,
  type ProcessInventoryPort,
  type ProcessObservation,
  parseSessionId,
  RETIRED_ACCOUNT_MODEL_NOTICE,
  RETIRED_FLEET_BLOCK_NOTICE,
  type RelayAdvertisement,
  type RelayCarrierSource,
  type ResumeLauncher,
  SESSION_ID_VARIABLE,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
  type SessionId,
  type SessionLifecycleLauncher,
  type SessionLifecycleRecord,
  sessionPaneEnvironment,
  type TerminalCapture,
  type TerminalRecord,
  type TerminalRuntimePort,
  verifySessionTranscriptMessageToken,
} from '../../../src/lib/index.ts';
import { CLOUDFLARED_NOT_ON_PATH, NO_TUNNEL_SERVICE } from '../../../src/lib/tunnel/index.ts';
import { daemonVersion } from '../../../src/lib/version.ts';
import { docxBytes } from '../../fixtures/docx.ts';
import { healthViewFixture } from '../../fixtures/health-view.ts';
import {
  es256Authenticator,
  CREDENTIAL_ID as PASSKEY_CREDENTIAL_ID,
  ORIGIN as PASSKEY_ORIGIN,
  assertion as passkeyAssertion,
  clientData as passkeyClientData,
  registration as passkeyRegistration,
} from '../../support/passkey-authenticator.ts';
import { deviceSession, newTestDevice, pairOverSession, TestSession } from '../../support/session-client.ts';
import { OS_CHOSEN_PORT, recordedPort } from '../support/os-port.ts';
import { ABSENT_USER_HOME, cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { FakeHostedService, fakeCloudflared, removeTempDirectories } from '../tunnel/support.ts';

/**
 * The daemon's boot lifecycle, driven through the real composition root.
 *
 * Everything here runs against a throwaway `FY_HOME` and an ephemeral loopback port (or, where the
 * port after one matters, a pair found free below that range): no real state home is resolved, no
 * known port is bound, and no daemon is left running — `untilShutdown` resolves
 * when the test says so, so `start` returns instead of serving forever.
 */

/** Bun declares `port` optional for the unix-socket case; a loopback `serve` always reports one. */
function boundPort(server: { readonly port?: number }): number {
  if (server.port === undefined) throw new Error('the fixture server reported no port');
  return server.port;
}

/**
 * A relay address that refuses every dial. The kernel chose its port and the test holds it for the whole
 * boot, so nothing else can take it the way a number found free and then released can be taken.
 */
function refusingRelay(): { readonly url: string; readonly port: number; readonly stop: () => Promise<void> } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('no relay here', { status: 404 }),
  });
  const port = boundPort(server);
  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/**
 * Where `strangerBesideAFreePort` looks: odd ports below every kernel's ephemeral range (Linux hands
 * out 32768 and up, macOS 49152 and up), so the port after each is below it too.
 */
const BELOW_EPHEMERAL = { first: 20_001, last: 32_765 } as const;

function isAddressInUse(error: unknown): boolean {
  return (error as { readonly code?: unknown } | null)?.code === 'EADDRINUSE';
}

/**
 * A stranger serving a preferred port, and the port after it proven bindable.
 *
 * NOT `port: 0`, which is what made this flaky. The kernel gives a port-0 listener an ODD port from
 * its ephemeral range and gives an outgoing connection an EVEN one from the same range, so the port
 * after a kernel-chosen one is exactly what this process's own loopback clients are handed as their
 * source port. With one such socket on it, the boot's probe is refused and reads the address as free,
 * the bind is refused with EADDRINUSE, and the binder waits out its window while the test looks at an
 * address that never answers. Below the ephemeral range neither port is ever handed out; binding the
 * second one before releasing it proves that nothing — no listener, no socket's source port, no
 * TIME_WAIT — holds it now. The walk is in steps of two, so two copies of this test running at once
 * can never pick each other's second port: each holds its first for as long as it runs.
 */
async function strangerBesideAFreePort(
  fetch: () => Response,
): Promise<{ readonly stranger: ReturnType<typeof Bun.serve>; readonly preferredPort: number }> {
  for (let port = BELOW_EPHEMERAL.first; port <= BELOW_EPHEMERAL.last; port += 2) {
    let stranger: ReturnType<typeof Bun.serve>;
    try {
      stranger = Bun.serve({ hostname: '127.0.0.1', port, fetch });
    } catch (error) {
      if (isAddressInUse(error)) continue;
      throw error;
    }
    try {
      await Bun.serve({ hostname: '127.0.0.1', port: port + 1, fetch: () => new Response('placeholder') }).stop(true);
      return { stranger, preferredPort: port };
    } catch (error) {
      await stranger.stop(true);
      if (!isAddressInUse(error)) throw error;
    }
  }
  throw new Error(
    `no free pair of consecutive ports from ${String(BELOW_EPHEMERAL.first)} to ${String(BELOW_EPHEMERAL.last + 1)}`,
  );
}

/** A real WebSocket listener that records the lifetime of every daemon carrier connection. */
function relaySocketProbe() {
  let opened = 0;
  let closed = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, host) => (host.upgrade(request) ? undefined : new Response('upgrade required', { status: 426 })),
    websocket: {
      open: () => {
        opened += 1;
      },
      message: () => undefined,
      close: () => {
        closed += 1;
      },
    },
  });
  return { server, opened: () => opened, closed: () => closed };
}

/**
 * The production composition with its one off-machine collaborator held offline by default.
 *
 * A boot test that means to prove discovery supplies its own directory below. Every other case must
 * not register a throwaway daemon identity with the hosted control plane merely because its fixture
 * omitted a relay block, nor make an integration result depend on that service being reachable.
 */
/**
 * A resolver that finds everything this host really has EXCEPT an agent harness.
 *
 * The boot preflight reports every harness it locates against the manifest, so without this the
 * machine running these tests would decide what most of them assert: a developer with Claude Code
 * installed gets a different preflight and warning than the CI runner, and every `said.stated[n]`
 * below shifts. Clearing `PATH` instead would have made the doctor report every program it needs
 * missing and turned `--check` non-zero, which is a different lie.
 *
 * Only `claude` and `codex` are hidden. Everything else resolves exactly as it does in production, so
 * "this host has no agent harness" becomes a property of the fixture rather than of the developer.
 */
function hostWithoutHarnesses(executables: ExecutableResolverPort): ExecutableResolverPort {
  const hidden = new Set(['claude', 'codex']);
  return {
    resolve: name => (hidden.has(name) ? undefined : executables.resolve(name)),
    runnable: path => executables.runnable(path),
  };
}

function buildIntegrationWorld(seams: WorldSeams = { userHome: ABSENT_USER_HOME }): DaemonWorld {
  const world = buildWorld({}, seams);
  return {
    ...world,
    harnesses: { ...world.harnesses, executables: hostWithoutHarnesses(world.harnesses.executables) },
    relayDirectory: { read: async (): Promise<RelayAdvertisement> => NO_RELAY_DIRECTORY },
    // The tunnel held off for the same reason, and DETERMINISTICALLY: whether this machine happens to
    // have `cloudflared` installed must not decide what a boot says.
    tunnelService: { read: async () => NO_TUNNEL_SERVICE },
    cloudflared: { locate: () => CLOUDFLARED_NOT_ON_PATH },
  };
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A `config/daemon.json` body. A boot imports nothing, so no case needs to opt out of an import. */
/**
 * Registers a first passkey and unlocks with it, over one device session — the two ceremonies a freshly
 * paired browser performs, answered against the challenges THIS daemon issued.
 */
async function unlockThroughTheDaemon(
  session: { request: TestSession['request'] },
  passkey: Awaited<ReturnType<typeof es256Authenticator>>,
): Promise<void> {
  const body = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'content-type': 'application/json' } });
  const challengeOf = (answer: { readonly body: string }): string =>
    z.object({ challenge: z.string() }).parse(JSON.parse(answer.body)).challenge;
  const registrationChallenge = challengeOf(
    await session.request('POST', '/v1/passkeys/options', body({ origin: PASSKEY_ORIGIN })),
  );
  const made = await passkeyRegistration(passkey, {
    client: passkeyClientData('webauthn.create', { challenge: registrationChallenge }),
  });
  const registered = await session.request(
    'POST',
    '/v1/passkeys',
    body({
      credentialId: toBase64Url(PASSKEY_CREDENTIAL_ID),
      clientDataJSON: toBase64Url(made.clientDataJSON),
      attestationObject: toBase64Url(made.attestationObject),
    }),
  );
  if (registered.status !== 201) throw new Error(`the first passkey was refused: ${registered.body}`);
  const unlockChallenge = challengeOf(
    await session.request('POST', '/v1/unlock/options', body({ origin: PASSKEY_ORIGIN })),
  );
  const proved = await passkeyAssertion(passkey, {
    client: passkeyClientData('webauthn.get', { challenge: unlockChallenge }),
  });
  const unlocked = await session.request(
    'POST',
    '/v1/unlock',
    body({
      credentialId: toBase64Url(PASSKEY_CREDENTIAL_ID),
      clientDataJSON: toBase64Url(proved.clientDataJSON),
      authenticatorData: toBase64Url(proved.authenticatorData),
      signature: toBase64Url(proved.signature),
    }),
  );
  if (unlocked.status !== 200) throw new Error(`the unlock was refused: ${unlocked.body}`);
}

function daemonDocument(document: Record<string, unknown>): string {
  return JSON.stringify(document);
}

/**
 * A state home that already has its layout, holding a configuration that binds the given port.
 *
 * The layout is established through the daemon's own storage rather than by hand, because a home
 * with hand-made directories and no version marker is exactly the foreign state the layout gate
 * exists to refuse. Configuration is written afterwards for the same reason.
 */
async function seedHome(home: string, port: number): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildIntegrationWorld().storage.open();
  await opened.storage.close();
  await writeFile(join(home, 'config', 'daemon.json'), daemonDocument({ host: '127.0.0.1', port }), { mode: 0o600 });
}

const SESSION_ID = 'wire-1';
/** The callsign the seeded session answers to. Taken from the shipped pool so the suggestion route
 *  is proved to skip a name it would otherwise have offered. */
const SEEDED_CALLSIGN = DEFAULT_CALLSIGN_POOL[0]!;

/**
 * A real session in the state home, written through the daemon's own storage.
 *
 * Both documents go through the protocol schemas first, so the fixture cannot drift from what the
 * daemon will parse back out — a hand-written config that the schema rejects would make the live
 * view silently empty and the test would still pass.
 */
async function seedSession(
  home: string,
  at: string,
  sessionId: string = SESSION_ID,
  /** Merged over the default running state, so a case can seed a FINISHED session without
   *  restating every field the schema demands. */
  state: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildIntegrationWorld().storage.open();
  const id = parseSessionId(sessionId);
  await opened.storage.writeConfig(
    id,
    SessionConfigSchema.parse({
      id: sessionId,
      incarnation: `${sessionId}-1`,
      runtimeGeneration: 1,
      name: 'Wire Subsystems',
      teammate: SEEDED_CALLSIGN,
      boardAccess: 'none',
      agent: 'claude-auto',
      harness: 'claude',
      modelHint: 'opus',
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: home,
      createdAt: at,
      updatedAt: at,
      turn: 1,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4_096,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    }),
  );
  await opened.storage.writeState(
    id,
    SessionStateSchema.parse({ id: sessionId, status: 'running', turn: 1, lastActivityAt: at, ...state }),
  );
  await opened.storage.close();
}

/**
 * Real journal history for a seeded session, written through the daemon's own storage.
 *
 * The event feed answers from the durable journal, so a fixture that hand-wrote `events.jsonl` would
 * be proving the socket against bytes the daemon would refuse. This uses the same append the daemon
 * itself uses, which is what makes the byte offsets its index resolves against true.
 */
async function seedEvents(home: string, sessionId: string, types: readonly string[]): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildIntegrationWorld().storage.open();
  const id = parseSessionId(sessionId);
  for (const type of types) await opened.storage.append(id, type, { seeded: type });
  await opened.storage.close();
}

/**
 * A terminal runtime that records instead of spawning.
 *
 * Substituted at `DaemonWorld.terminalRuntime` so the boot test never starts a shell or touches a
 * tmux socket. It behaves like tmux does in the one way the mount depends on: `list` is the
 * authority, so a rename that did not reach the runtime would not survive the next read.
 */
class RecordingTerminalRuntime implements TerminalRuntimePort {
  readonly opened: TerminalRecord[] = [];
  readonly killed: string[] = [];
  private readonly records = new Map<string, TerminalRecord>();

  async list(): Promise<readonly TerminalRecord[]> {
    return [...this.records.values()];
  }

  async create(input: Parameters<TerminalRuntimePort['create']>[0]): Promise<TerminalRecord> {
    const record: TerminalRecord = {
      id: input.id,
      ownerId: input.ownerId,
      title: input.title,
      root: input.cwd,
      tmuxSession: `fy-webterm-${input.ownerId}-${input.id}`,
      createdAtMs: 1_700_000_000_000,
      lastActivityAtMs: 1_700_000_000_000,
      ...input.size,
      ...(input.name === undefined ? {} : { name: input.name }),
    };
    this.records.set(record.id, record);
    this.opened.push(record);
    return record;
  }

  async rename(record: TerminalRecord, title: string): Promise<void> {
    this.records.set(record.id, { ...record, title });
  }

  async resize(record: TerminalRecord, size: { readonly cols: number; readonly rows: number }): Promise<void> {
    this.records.set(record.id, { ...record, ...size });
  }

  /** Bytes a viewer typed, decoded, so a case can assert what actually reached the pane. */
  readonly written: string[] = [];
  /** What the pane would draw. Non-empty so a real socket frame carries something assertable. */
  screen = 'ready $ ';

  async write(_record: TerminalRecord, bytes: Uint8Array): Promise<void> {
    this.written.push(new TextDecoder().decode(bytes));
  }

  async capture(): Promise<TerminalCapture> {
    return { lines: [this.screen], cols: 100, rows: 1, cursorX: this.screen.length, cursorY: 0, historySize: 0 };
  }

  /** The screen, followed by everything typed into it — enough for an agent's read to see its own input. */
  async text(): Promise<string> {
    return [this.screen, ...this.written].join('');
  }

  /** What is running in the pane: the shell, unless a case says otherwise. */
  foregroundCommand = 'sh';

  async foreground(): Promise<string> {
    return this.foregroundCommand;
  }

  async kill(record: TerminalRecord): Promise<void> {
    this.records.delete(record.id);
    this.killed.push(record.id);
  }
}

/**
 * An agent launcher that records instead of spawning.
 *
 * Substituted at `DaemonWorld.sessionLauncher` so the boot test never starts an agent, never touches
 * a tmux socket and never binds a pane. It behaves like tmux does in the two ways the lifecycle
 * depends on: a session is not alive until it has been launched, and it stops being alive when it is
 * killed — which is what makes a retried start idempotent rather than a second pane.
 */
class RecordingSessionLauncher implements SessionLifecycleLauncher {
  /** Every launch, as the argv and the directory it was launched in. */
  readonly launched: Array<{ readonly command: readonly string[]; readonly cwd: string }> = [];
  /** Every instruction typed into a ready pane. */
  readonly delivered: string[] = [];
  readonly stopped: string[] = [];
  private readonly live = new Set<string>();

  async alive(record: SessionLifecycleRecord): Promise<boolean> {
    return this.live.has(record.config.tmuxSession);
  }

  async launch(record: SessionLifecycleRecord): Promise<undefined> {
    this.launched.push({ command: [...record.config.command], cwd: record.config.cwd });
    this.live.add(record.config.tmuxSession);
  }

  async ready(_record: SessionLifecycleRecord): Promise<void> {
    // The fake has no terminal prompt to poll; a completed launch is immediately ready.
  }

  async deliver(
    _record: SessionLifecycleRecord,
    instruction: string,
    beforeWrite?: () => Promise<void>,
  ): Promise<void> {
    await beforeWrite?.();
    this.delivered.push(instruction);
  }

  async snapshot(_record: SessionLifecycleRecord): Promise<void> {
    // The integration world has no terminal screen; this proves lifecycle terminalization still
    // invokes its required capture seam without touching a host pane.
  }

  async stop(record: SessionLifecycleRecord): Promise<void> {
    this.stopped.push(record.config.tmuxSession);
    this.live.delete(record.config.tmuxSession);
  }
}

/**
 * A reviver that records instead of replacing a pane.
 *
 * Substituted at `DaemonWorld.createResumeLauncher` so the boot test never kills a tmux session and
 * never respawns an agent. It is the only thing a revive does that a test cannot let happen on the
 * host, so everything else stays production: the real resume service, the real turn-document store,
 * the real journalled transitions over the real state home, and the real route.
 *
 * `pane` is what the harness would be observed doing, set by the case. That single value is what
 * `planResume` branches on — a live pane is typed into, a gone one is relaunched — so making it a
 * field is what lets one boot prove both halves of the mount.
 */
class RecordingResumeLauncher implements ResumeLauncher {
  /** What `observe` reports. A session nothing is running: the revive must relaunch it. */
  pane: PaneObservation = { alive: false, dead: false, promptReady: false };
  /** Every session relaunched, in order. */
  readonly relaunched: string[] = [];
  /** Every instruction typed into a pane, live or replacement. */
  readonly delivered: string[] = [];
  readonly killed: string[] = [];
  readonly snapshots: string[] = [];
  /**
   * The production argv builder a revive runs, when a case hands it over: the replacement pane is the
   * one thing faked here, never what it would have been launched with.
   */
  argvFor: ((id: SessionId) => Promise<readonly string[] | undefined>) | undefined;
  /** What each relaunch would have run, when a case asked for it. */
  readonly argv: Array<readonly string[] | undefined> = [];

  async observe(): Promise<PaneObservation> {
    return this.pane;
  }

  async snapshot(id: string): Promise<void> {
    this.snapshots.push(id);
  }

  async kill(id: string): Promise<void> {
    this.killed.push(id);
  }

  async relaunch(id: string): Promise<undefined> {
    this.relaunched.push(id);
    if (this.argvFor !== undefined) this.argv.push(await this.argvFor(parseSessionId(id)));
  }

  async deliver(_id: string, instruction: string): Promise<void> {
    this.delivered.push(instruction);
  }

  async confirmExit(): Promise<{ readonly confirmed: boolean; readonly pane: PaneObservation }> {
    return { confirmed: true, pane: this.pane };
  }
}

/**
 * A process inventory that reports what the case decided instead of walking the host.
 *
 * Substituted inside a REAL `MigrationPreflight`, so every verdict, blind-spot rule and refusal the
 * gate applies is production's — only the `ps` walk it cannot perform against work that is not
 * actually running is replaced. It starts EMPTY, which is a pane with nothing in flight rather than
 * a pane nobody could read.
 */
class StubProcessInventory implements ProcessInventoryPort {
  observation: ProcessObservation = { kind: 'observed', processes: [] };
  /** How many times the gate actually walked a pane. A refusal decided ABOVE the gate leaves it at 0. */
  collections = 0;

  async collect(): Promise<ProcessObservation> {
    this.collections += 1;
    return this.observation;
  }
}

/** The wrapper name the seeded fleet publishes. It must match the lifecycle's auto-wrapper rule. */
const WRAPPER = 'claude-auto-boot';
/**
 * The account a migration moves onto: the SAME harness family, a different account, and a smaller
 * context window.
 *
 * Same family because that is the only migration the daemon performs — a session keeps its
 * transcript, its turn counter and its open tool ids across the move, and none of those means anything
 * to another harness. Smaller window so the downgrade refusal stays reachable without inventing a
 * session state.
 */
const TARGET_WRAPPER = 'claude-auto-target';
/** An account of the OTHER family, published so the cross-family refusal has something real to name. */
const CROSS_FAMILY_WRAPPER = 'codex-auto-target';

/** Account ids as the provisioner mints them. Opaque, and the only key anything here joins on. */
const BOOT_ACCOUNT = '00000000-0000-4000-8000-000000000b07';
const ORIGIN_ACCOUNT = '00000000-0000-4000-8000-0000000000f1';
const TARGET_ACCOUNT = '00000000-0000-4000-8000-0000000000f2';
const CROSS_FAMILY_ACCOUNT = '00000000-0000-4000-8000-0000000000f3';
const PRIMARY_ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const STAND_IN_ACCOUNT = '00000000-0000-4000-8000-0000000000a2';

/**
 * Publish a manifest THROUGH THE FLEET'S OWN WRITER, exactly as `fy fleet apply` does.
 *
 * Hand-written JSON here is what hid the defect this file now covers: the daemon's end-to-end test
 * wrote the shape the daemon's reader imagined, so both halves passed while neither could read what
 * `fy fleet apply` actually publishes. Building through `buildFleetManifest` makes that class of
 * fixture impossible — a payload no provisioner would write is refused here, in the test.
 */
async function publishManifest(home: string, accounts: readonly unknown[]): Promise<void> {
  await mkdir(join(home, 'fleet'), { recursive: true });
  await writeFile(
    join(home, 'fleet', 'manifest.json'),
    JSON.stringify(buildFleetManifest({ generatedAt: '2027-01-15T08:00:00.000Z', accounts })),
    { mode: 0o600 },
  );
}

/**
 * A fleet whose one account is published under a wrapper this host can actually run.
 *
 * The executable is REAL, because turning a published wrapper into a program a start may run is a
 * step the start genuinely performs — the lifecycle's own authorization refuses anything that is not
 * an absolute fleet wrapper. It is never executed: the launcher above is what would have run it. The
 * `PATH` entry is left in place deliberately even though nothing resolves a wrapper through `PATH`
 * any more: a daemon under a service manager has no such `PATH`, and this seed must not be the
 * reason a start works.
 */
async function seedFleet(home: string): Promise<string> {
  const binary = join(home, 'bin');
  await mkdir(binary, { recursive: true });
  const executable = join(binary, WRAPPER);
  // The wrapper DECLARES its harness home, which is how a real fleet wrapper is written and the only
  // evidence the daemon has for where this account's transcripts land.
  await writeFile(executable, `#!/bin/sh\nexport CLAUDE_CONFIG_DIR="${join(home, 'harness')}"\nexit 0\n`, {
    mode: 0o755,
  });
  await publishManifest(home, [
    {
      id: BOOT_ACCOUNT,
      kind: 'claude',
      mode: 'auto',
      wrapper: executable,
      home: join(home, 'harness'),
      displayName: 'Boot',
      defaultModel: 'claude-opus-5',
      models: [{ id: 'claude-opus-5', available: true }],
      available: true,
      unavailableReason: null,
    },
  ]);
  process.env.PATH = `${binary}:${process.env.PATH ?? ''}`;
  return executable;
}

/**
 * A fleet with somewhere to migrate TO, and somewhere a migration must REFUSE to go.
 *
 * Three accounts, because a migration has three answers to give. The origin serves a million-token
 * window, declared by its catalog entry, which is how a session comes to be running in one. The same-family target serves the default 200k, so the downgrade
 * refusal is reachable without inventing a session state. The cross-family account is published and
 * available and this host can run it: it is refused for what it IS, not for anything missing about it.
 */
async function seedMigrationFleet(home: string): Promise<void> {
  const binary = join(home, 'bin');
  await mkdir(binary, { recursive: true });
  // The two claude logins DECLARE their homes, as real fleet wrappers do: a migration carries the
  // conversation into the target's home, and a login that declares none is refused rather than moved
  // onto an empty conversation.
  const homes: Readonly<Record<string, string>> = {
    [WRAPPER]: join(home, 'homes', 'origin'),
    [TARGET_WRAPPER]: join(home, 'homes', 'target'),
  };
  for (const wrapper of [WRAPPER, TARGET_WRAPPER, CROSS_FAMILY_WRAPPER]) {
    const declared = homes[wrapper];
    await writeFile(
      join(binary, wrapper),
      declared === undefined ? '#!/bin/sh\nexit 0\n' : `#!/bin/sh\nexport CLAUDE_CONFIG_DIR="${declared}"\nexit 0\n`,
      { mode: 0o755 },
    );
  }
  await publishManifest(home, [
    {
      id: ORIGIN_ACCOUNT,
      kind: 'claude',
      mode: 'auto',
      wrapper: join(binary, WRAPPER),
      home: join(home, 'homes', 'origin'),
      displayName: 'Origin',
      defaultModel: 'claude-opus-5',
      // The shape a real manifest has: the BARE id, with the window the catalog declares for it. The
      // fixture used to list `claude-opus-5[1m]` as the id, which no published manifest does and which
      // hid a Restart planning 200k for a session running in a million.
      models: [{ id: 'claude-opus-5', available: true, context: 1_000_000 }],
      available: true,
      unavailableReason: null,
    },
    {
      id: TARGET_ACCOUNT,
      kind: 'claude',
      mode: 'auto',
      wrapper: join(binary, TARGET_WRAPPER),
      home: join(home, 'homes', 'target'),
      displayName: 'Target',
      defaultModel: 'claude-sonnet-5',
      models: [{ id: 'claude-sonnet-5', available: true }],
      available: true,
      unavailableReason: null,
    },
    {
      id: CROSS_FAMILY_ACCOUNT,
      kind: 'codex',
      mode: 'auto',
      wrapper: join(binary, CROSS_FAMILY_WRAPPER),
      home: join(home, 'homes', 'cross-family'),
      displayName: 'Other Family',
      defaultModel: 'gpt-5.6-terra',
      models: [{ id: 'gpt-5.6-terra', available: true }],
      available: true,
      unavailableReason: null,
    },
  ]);
  process.env.PATH = `${binary}:${process.env.PATH ?? ''}`;
}

/**
 * The host effects the login window performs, with no host behind them.
 *
 * This is the seam `bin/fyd.ts` already builds the window over, and it is substituted for exactly the
 * reason the world declares it: a real one starts an X server, a Chrome and a VNC server on whatever
 * machine runs the suite. Everything ABOVE it stays production — the window's state machine, the real
 * `BrowserProfileStore` over the test's own state home, the mount, the dispatcher and the socket — so
 * what is proved is that the daemon leases the profile, records the human's verdict and serves a
 * status the reader can parse.
 */
class RecordingLoginRuntime implements BrowserLoginRuntime {
  readonly spawned: string[][] = [];
  readonly terminated: string[] = [];
  readonly platform = 'linux' as const;
  readonly environmentSource = { PATH: '/usr/bin', HOME: '/home/operator' } as const;
  readonly hostname = 'boot-host';
  readonly sshUser = 'operator';
  private clock = Date.parse('2026-07-31T12:00:00.000Z');

  async display(): Promise<string> {
    return ':77';
  }

  chromeExecutable(): string {
    return '/usr/bin/google-chrome';
  }

  x11vncExecutable(): string {
    return '/usr/bin/x11vnc';
  }

  timeoutExecutable(): string {
    return '/usr/bin/timeout';
  }

  async chromeVersion(): Promise<string> {
    return 'Google Chrome 130.0.6723.116';
  }

  spawn(argv: readonly string[]): BrowserLoginChild {
    this.spawned.push([...argv]);
    return { pid: 1_000 + this.spawned.length, exited: new Promise<number>(() => undefined), kill: () => undefined };
  }

  async freePort(): Promise<number> {
    return 5_912;
  }

  async writePassword(): Promise<string> {
    return '/tmp/does-not-matter';
  }

  async waitForChrome(): Promise<void> {
    return undefined;
  }

  async waitForVnc(): Promise<void> {
    return undefined;
  }

  async removePassword(): Promise<void> {
    return undefined;
  }

  async terminateChrome(): Promise<void> {
    this.terminated.push('chrome');
  }

  async terminateVnc(): Promise<void> {
    this.terminated.push('vnc');
  }

  now(): number {
    return this.clock;
  }

  advance(milliseconds: number): void {
    this.clock += milliseconds;
  }
}

/**
 * A dictation enhancer that records what it was handed and answers from memory.
 *
 * It stands in for `SttEnhancementService` for one reason: the real one spends the operator's provider
 * credential on an outbound call to a third party. Everything the mount is responsible for stays
 * production — the route table, the credentials, the dispatcher and the transport.
 */
class RecordingSttEnhancer {
  readonly seen: unknown[] = [];

  async enhance(input: unknown): Promise<SttEnhancementResult> {
    this.seen.push(input);
    return { text: 'Ship the protocol package.', provider: 'groq', model: 'openai/gpt-oss-120b', latencyMs: 7 };
  }
}

/** Boots the production world against a seeded temp home, with shutdown driven by the test. */
async function worldAt(home: string, port: number, untilShutdown: () => Promise<void>): Promise<DaemonWorld> {
  await seedHome(home, port);
  // Arm the shutdown promise before the server can answer. `start` binds and serves `/healthz`
  // before it reaches its final `await world.untilShutdown()`, so a test that releases after the
  // health probe can otherwise call a still-empty resolver and leave the boot waiting forever.
  const shutdown = untilShutdown();
  return { ...buildIntegrationWorld(), untilShutdown: () => shutdown };
}

/**
 * Everything a boot said, so a refusal is asserted on its MESSAGE and not only on its exit code.
 *
 * The entire defect these tests guard was an exit code with no message — a launcher telling an
 * operator to inspect a log file that was empty — so a test that checked the code alone would have
 * passed against the broken daemon.
 */
function recordingNotices(): { readonly port: BootNoticePort; readonly steps: string[]; readonly stated: string[] } {
  const steps: string[] = [];
  const stated: string[] = [];
  return {
    steps,
    stated,
    port: {
      step: (name, detail) => steps.push(detail === undefined ? name : `${name} — ${detail}`),
      state: message => stated.push(message),
    },
  };
}

/**
 * A state home with its layout but NO recorded port, which is what a machine that has never started
 * a daemon actually looks like — and the only state in which a boot may choose its own address.
 */
async function seedHomeWithoutPort(home: string): Promise<void> {
  process.env.FY_HOME = home;
  const opened = await buildIntegrationWorld().storage.open();
  await opened.storage.close();
  await writeFile(join(home, 'config', 'daemon.json'), daemonDocument({ host: '127.0.0.1' }), { mode: 0o600 });
}

async function runCleanups(cleanups: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
  for (const cleanup of cleanups) await cleanup();
}

describe('daemon boot lifecycle', () => {
  const previousHome = process.env.FY_HOME;
  const previousPath = process.env.PATH;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await cleanupTempDirectories();
  });

  it('should serve health and usage over the configured address, then release everything', async () => {
    // Arrange
    const home = await tempDirectory('fyd-boot');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });

    // Act
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    // The server is listening once /healthz answers; the poll bounds how long boot may take.
    let health: Response | undefined;
    for (let attempt = 0; attempt < 100 && health === undefined; attempt += 1) {
      health = await fetch(`http://127.0.0.1:${port}/healthz`)
        .then(answer => (answer.ok ? answer : undefined))
        .catch(() => undefined);
      if (health === undefined) await Bun.sleep(50);
    }
    const usage = await fetch(`http://127.0.0.1:${port}/usage`);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/usage`);
    // A mounted subsystem, reached with the token the boot minted. The session does not exist, so a
    // MOUNTED pin board answers `not-found`; an unmounted one would answer `unknown_route`.
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const pins = await fetch(`http://127.0.0.1:${port}/v1/sessions/absent/pins`, {
      headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
    });
    release();
    const code = await exit;
    await runCleanups(cleanups);
    const afterStop = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);

    // Assert
    should(code).equal(0);
    should(health?.status).equal(200);
    should((await health!.json()) as { status: string }).have.property('status', 'ok');
    should(usage.status).equal(200);
    should((await usage.json()) as { ready: boolean }).have.property('ready', false);
    should(unauthorized.status).equal(401);
    should(pins.status).equal(404);
    should((await pins.json()) as { code: string }).have.property('code', 'not-found');
    should(afterStop).be.undefined();
    // The API tokens were minted into the home, which only a boot that reached the server does.
    should(await readdir(home)).containEql('api-token');
  });

  it('should resolve Codex provenance before one message read and issue against the persisted context', async () => {
    // Arrange: a real Codex home whose one rollout did not exist at session creation. The opening
    // row carries this session's private correlation token, which is the resolver's ownership proof.
    const home = await tempDirectory('fyd-message-discovery');
    const codexHome = await tempDirectory('fyd-message-discovery-codex');
    const at = '2026-08-06T12:00:00.000Z';
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await seedSession(home, at);
    const correlationToken = join(home, 'state', 'sessions', SESSION_ID);
    const rolloutId = '11111111-2222-4333-8444-555555555555';
    const rolloutDirectory = join(codexHome, 'sessions', '2026', '08', '06');
    const rolloutFile = join(rolloutDirectory, `rollout-2026-08-06-${rolloutId}.jsonl`);
    const selectedText = `Read ${correlationToken}/turns/turn-001.md now, then fork this row.`;
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(
      rolloutFile,
      `${[
        JSON.stringify({ type: 'session_meta', payload: { id: rolloutId, cwd: home } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: selectedText }] },
        }),
      ].join('\n')}\n`,
    );
    process.env.FY_HOME = home;
    const seeded = await buildWorld({}, { userHome: ABSENT_USER_HOME }).storage.open();
    const id = parseSessionId(SESSION_ID);
    const config = SessionConfigSchema.parse(await seeded.storage.readConfig(id));
    await seeded.storage.writeConfig(id, {
      ...config,
      agent: 'codex-auto',
      harness: 'codex',
      modelHint: 'terra',
      model: 'gpt-5.6-terra',
      transcript: {
        v: 1,
        home: codexHome,
        identity: 'undiscovered',
        baseline: [],
        correlationToken,
      },
    });
    await seeded.storage.append(id, 'session.created', { agent: 'codex-auto' });
    await seeded.storage.close();

    // Act: the first GET itself performs discovery. Production must persist it, re-read that
    // completed record, and only then perform the transcript-byte read that produces this token.
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    const base = `http://127.0.0.1:${String(port)}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`${base}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const response = await fetch(`${base}/v1/sessions/${SESSION_ID}/messages?limit=1`, {
      headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
    });
    const page = SessionTranscriptPageSchema.parse(await response.json());
    const completed = SessionConfigSchema.parse(
      JSON.parse(await readFile(join(home, 'state', 'sessions', SESSION_ID, 'config.json'), 'utf8')),
    );
    const message = page.messages[0];
    if (message === undefined || completed.transcript === undefined)
      throw new Error('the first message read did not return one row under completed provenance');
    const batch = await new NodeTranscriptSource(new CodexTranscriptParser()).read(rolloutFile, {
      sessionId: SESSION_ID,
    });
    const digest = digestConversation(SESSION_ID, batch, message.point);
    const evidence = digest.selectionEvidence;
    if (evidence === undefined) throw new Error('the production parser read carried no row commitment');
    const keyFile = sessionMessageTokenKeyFile(join(home, 'state'));
    const verifier = new FileSessionTranscriptMessageTokenCodec(keyFile, () => {
      throw new Error('the GET must already have durably published its token key');
    });
    should(evidence.rawPrefix.byteLength).equal(32);
    should(ConversationMessagePointSchema.safeParse(message.point).success).equal(true);
    should(TranscriptProvenanceSchema.safeParse(completed.transcript).success).equal(true);
    const context = {
      sessionId: SESSION_ID,
      incarnation: completed.incarnation,
      provenance: completed.transcript,
    };
    const wrongIncarnationVerdict = await verifySessionTranscriptMessageToken(
      verifier,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
      { ...context, incarnation: `${completed.incarnation}-wrong` },
      message.point,
      evidence.rawPrefix,
      message.selectionBinding,
    );
    const verdict = await verifySessionTranscriptMessageToken(
      verifier,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
      context,
      message.point,
      evidence.rawPrefix,
      message.selectionBinding,
    );
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert: issuing against the pre-resolution `undiscovered` snapshot would make this exact
    // verification stale. Acceptance proves the GET used the persisted correlated record instead.
    should(code).equal(0);
    should(response.status).equal(200);
    should(page.sessionId).equal(SESSION_ID);
    should(page.messages.map(row => row.text)).eql([selectedText]);
    should(completed.transcript.identity).equal('correlated');
    should(completed.transcript.harnessSessionId).equal(rolloutId);
    should(completed.transcript.file).equal(rolloutFile);
    should(wrongIncarnationVerdict).equal('stale');
    should(verdict).equal('accepted');
  });

  it('should mint, redeem over a direct session, persist and authenticate a device key through the production composition root', async () => {
    const home = await tempDirectory('fyd-pairing');
    const relay = refusingRelay();
    const relayUrl = relay.url;
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await writeFile(
      join(home, 'config', 'daemon.json'),
      daemonDocument({
        host: '127.0.0.1',
        port: OS_CHOSEN_PORT,
        carriers: [{ kind: 'relay', url: relayUrl, reconnectSeconds: 3_600 }],
      }),
      { mode: 0o600 },
    );
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`${base}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const adminToken = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const admin = { authorization: `Bearer ${adminToken}` };
    const origin = 'https://ferretry.pages.dev';

    const preflight = await fetch(`${base}/v1/pair`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    /*
     * THE HOST MINTS WITH NOTHING SET UP. A fresh install has no operator secret of any kind, and the
     * host's own admin token is ungoverned, so the first code is one request away — the state a
     * person on their own machine is actually in. A governed (remote) mint is held behind the passkey
     * step-up at the boundary, which is proved where that boundary lives.
     */
    const mintedResponse = await fetch(`${base}/v1/pair/code`, { method: 'POST', headers: admin });
    const minted = PairingCodeMintResponseSchema.parse(await mintedResponse.json());
    /*
     * THE ADVERTISEMENT, FROM A DAEMON THAT REALLY BOOTED, ON THE DEFAULT BIND.
     *
     * This home records `host: 127.0.0.1` — the default — so this is the exact configuration that used
     * to answer with a QR of an address that, on the phone reading it, named the phone. The link is
     * still minted, because a browser on this machine redeems it perfectly; what must be true is that
     * the response SAYS who that is. The mint request above arrives on loopback and the answer must
     * not depend on that: this asserts the daemon's configuration decided it, not the requester.
     */
    const invitation = pairingMintOutcome(minted);
    if (invitation.kind !== 'invitation') throw new Error('a loopback-bound daemon still hands out its own address');
    /*
     * REDEMPTION IS A SESSION NOW, over this daemon's own direct socket: the daemon is proved against
     * the fingerprint the link names before the code leaves the client, and what it registers is a KEY.
     * The plain-HTTP route is gone, which this journey also proves.
     */
    const device = await newTestDevice();
    const httpRedemption = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ code: minted.code, deviceName: 'Browser phone' }),
    });
    const pairing = await pairOverSession(base, minted.daemonId, minted.code, '  Browser phone  ', device);
    if (pairing.kind !== 'paired') throw new Error('the direct session refused a fresh code');
    const paired = pairing.response;
    const replay = await pairOverSession(base, minted.daemonId, minted.code, 'Browser phone', await newTestDevice());
    const statusResponse = await fetch(`${base}/v1/pair/code/${minted.pairingId}`, { headers: admin });
    const status = PairingCodeStatusResponseSchema.parse(await statusResponse.json());
    // THE DEVICE KEY IS THE CREDENTIAL: a session it signs is served; the same id signed by another
    // key is refused; and an app still sending the old bearer token is told to update.
    const asDevice = await deviceSession(base, minted.daemonId, paired.deviceId, device, { origin });
    /*
     * THE UNLOCK, THROUGH THE PRODUCTION COMPOSITION ROOT (zero-trust.md B1). The machine unlocks on
     * opening by default, so the freshly paired device is refused everything first; it registers its
     * first passkey inside the window after pairing — served before an unlock — and unlocks with it.
     * A software authenticator stands in for the person's; the daemon's verifier is the real one.
     */
    const locked = await asDevice.request('GET', '/v1/usage');
    const passkey = await es256Authenticator();
    await unlockThroughTheDaemon(asDevice, passkey);
    const usage = await asDevice.request('GET', '/v1/usage');
    const refreshed = DaemonCarriersViewSchema.parse(JSON.parse((await asDevice.request('GET', '/v1/carriers')).body));
    asDevice.close();
    const impostor = await TestSession.open(base, minted.daemonId, {
      kind: 'auth',
      deviceId: paired.deviceId,
      device: await newTestDevice(),
    });
    const impostorClosed = await impostor.closed();
    const outdatedApp = await fetch(`${base}/v1/usage`, {
      headers: { origin, authorization: `Bearer fy_device_${'a'.repeat(43)}` },
    });
    // A browser on an origin this daemon was not told to serve cannot even open the socket.
    const foreignOrigin = await fetch(`${base}/v1/rendezvous/${minted.daemonId}/client`, {
      headers: {
        origin: 'https://not-ferretry.example',
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      },
    });
    // There is no ticket to buy any more, for anybody: every browser stream is a session.
    const noTicket = await fetch(`${base}/v1/events/ticket`, { method: 'POST', headers: admin });
    const deviceDocument = await readFile(join(home, 'state', 'devices.json'), 'utf8');
    release();
    const code = await exit;
    await runCleanups(cleanups);
    await relay.stop();

    should(code).equal(0);
    should(preflight.status).equal(204);
    should(preflight.headers.get('access-control-allow-origin')).equal(origin);
    should(mintedResponse.status).equal(201);
    should(minted.ttlSeconds).equal(120);
    should(new URL(invitation.pairUrl).hash).containEql(minted.code);
    should(new URL(invitation.pairUrl).search).not.containEql(minted.code);
    should(invitation.reach).equal('local-only');
    should(invitation.daemonUrl).equal(`${base}/`);
    // No route, and nothing public. An app from before device keys pairing over plain HTTP is told,
    // in the shared sentence, that IT is the side to update — never a 401 that reads as a wrong code.
    should(httpRedemption.status).equal(426);
    should(paired.daemonId).equal(minted.daemonId);
    should(paired.idleExpiryDays).equal(30);
    should(replay.kind).equal('refused');
    should(status.status).equal('redeemed');
    if (status.status !== 'redeemed') throw new Error('expected a redeemed pairing status');
    should(status.deviceName).equal('Browser phone');
    should(usage.status).equal(200);
    should([locked.status, JSON.parse(locked.body).code]).deepEqual([401, UNLOCK_REQUIRED_CODE]);
    should(refreshed.carriers).deepEqual(paired.carriers);
    should(impostorClosed.code).equal(4403);
    should(outdatedApp.status).equal(426);
    should(foreignOrigin.status).equal(403);
    should(noTicket.status).equal(404);
    should(paired.carriers).deepEqual([
      { kind: 'direct', url: base },
      { kind: 'relay', url: relayUrl },
    ]);
    should(deviceDocument).containEql('Browser phone');
    // The daemon keeps the PUBLIC half and nothing a copy of this file could replay.
    should(deviceDocument).containEql(device.publicKey);
    should(deviceDocument).not.containEql('tokenHash');
  });

  it('should switch the hosted tunnel on live, serve it as a remote carrier, and release it when switched off', async () => {
    // `docs/relay-protocol.md` §15 "The daemon end", end to end: the production tunnel carrier against a
    // fake hosted service on loopback (which verifies each signature over its own host) and a fake
    // `cloudflared` executable. The test dials the dedicated listener directly, which is exactly where
    // `cloudflared` forwards a tunnelled browser — from this host's loopback. The tunnel is opt-in, so
    // the document names none and it is switched on through `PUT /v1/tunnel` — what `fy daemon tunnel
    // on` sends — with no restart.
    // Arrange
    const home = await tempDirectory('fyd-tunnel');
    const service = new FakeHostedService();
    const fake = await fakeCloudflared();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const seeded = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    const world: DaemonWorld = {
      ...seeded,
      tunnelService: { read: async () => ({ kind: 'available', origin: service.origin }) },
      cloudflared: new CloudflaredLocator({ FY_CLOUDFLARED: fake.path }),
    };
    // The origin this build DISCOVERS, which a release is signed only for: the fake service, read live
    // by the production carrier exactly as a daemon reads its own environment. Restored below.
    const discovery = process.env.FY_RELAY_DIRECTORY_ORIGIN;
    process.env.FY_RELAY_DIRECTORY_ORIGIN = service.origin;
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    const base = `http://127.0.0.1:${port}`;
    const origin = 'https://ferretry.pages.dev';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`${base}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const adminToken = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const minted = PairingCodeMintResponseSchema.parse(
      await (
        await fetch(`${base}/v1/pair/code`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}` } })
      ).json(),
    );
    const device = await newTestDevice();
    const pairing = await pairOverSession(base, minted.daemonId, minted.code, 'Tunnel phone', device);
    if (pairing.kind !== 'paired') throw new Error('the direct session refused a fresh code');
    const direct = await deviceSession(base, minted.daemonId, pairing.response.deviceId, device, { origin });
    await unlockThroughTheDaemon(direct, await es256Authenticator());
    const tunnelView = async () =>
      TunnelStatusViewSchema.parse(JSON.parse((await direct.request('GET', '/v1/tunnel')).body));
    const switchTunnel = async (enabled: boolean) =>
      await fetch(`${base}/v1/tunnel`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    const beforeOptIn = await tunnelView();
    const provisionedBeforeOptIn = service.provisions.length;
    const switchedOn = await switchTunnel(true);
    await waitUntil(() => service.provisions.length > 0, 'the tunnel to be provisioned');
    const originPort = service.provisions[0]?.originPort ?? 0;
    const tunnelBase = `http://127.0.0.1:${String(originPort)}`;
    const carriersOf = async (session: TestSession) =>
      DaemonCarriersViewSchema.parse(JSON.parse((await session.request('GET', '/v1/carriers')).body)).carriers;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await carriersOf(direct)).some(carrier => carrier.kind === 'tunnel')) break;
      await Bun.sleep(25);
    }

    // Act — the same device, through the tunnel's own listener.
    const tunnelled = await deviceSession(tunnelBase, minted.daemonId, pairing.response.deviceId, device, { origin });
    const carriersThroughTunnel = await carriersOf(tunnelled);
    const privilegedThroughTunnel = await tunnelled.request('POST', '/v1/agent/tools', { body: '{}' });
    const privilegedDirect = await direct.request('POST', '/v1/agent/tools', { body: '{}' });
    const grantsThroughTunnel = JSON.parse((await tunnelled.request('GET', '/v1/grants')).body) as Record<
      string,
      unknown
    >;
    const plainHttp = await Promise.all(
      ['/healthz', '/v1/carriers', `/v1/health?token=${adminToken}`].map(
        async path =>
          (await fetch(`${tunnelBase}${path}`, { headers: { authorization: `Bearer ${adminToken}` } })).status,
      ),
    );
    // First contact is never carried by a tunnel: a fresh code tried there is refused like a wrong one,
    // and — because the attempt never reached the pairing service — still redeems directly afterwards.
    const second = PairingCodeMintResponseSchema.parse(
      await (
        await fetch(`${base}/v1/pair/code`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}` } })
      ).json(),
    );
    const pairedOverTunnel = await pairOverSession(
      tunnelBase,
      second.daemonId,
      second.code,
      'Stranger',
      await newTestDevice(),
    );
    const pairedDirectAfter = await pairOverSession(
      base,
      second.daemonId,
      second.code,
      'Second phone',
      await newTestDevice(),
    );
    const upView = await tunnelView();
    tunnelled.close();
    // Off, live: the answer comes once the tunnel is withdrawn, stopped and released back to the pool.
    const switchedOff = await switchTunnel(false);
    const offView = TunnelStatusViewSchema.parse(await switchedOff.json());
    const carriersAfterOff = await carriersOf(direct);
    const documentAfterOff = JSON.parse(await readFile(join(home, 'config', 'daemon.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const listenerAfterOff = await fetch(`${tunnelBase}/healthz`).catch(() => 'refused');
    const holdingAfterOff = await readFile(join(home, 'state', 'tunnel.json'), 'utf8').catch(() => 'forgotten');
    direct.close();
    release();
    const code = await exit;
    await runCleanups(cleanups);
    process.env.FY_RELAY_DIRECTORY_ORIGIN = discovery;
    const afterStop = await fetch(`${tunnelBase}/healthz`).catch(() => 'refused');
    await service.stop();
    await removeTempDirectories();

    // Assert
    should(code).equal(0);
    // Opt-in: nothing was asked of the hosted service until the switch was turned on.
    should(beforeOptIn).deepEqual({
      enabled: false,
      explicit: false,
      state: 'off',
      tunnelUrl: null,
      sentence: TUNNEL_OFF_SENTENCE,
    });
    should(provisionedBeforeOptIn).equal(0);
    should(switchedOn.status).equal(200);
    should(upView).deepEqual({
      enabled: true,
      explicit: true,
      state: 'up',
      tunnelUrl: 'https://quiet-otter.tunnels.example',
      sentence: 'Tunnel: up — https://quiet-otter.tunnels.example',
    });
    // Off: withdrawn from the published set, the listener closed, the tunnel released and forgotten,
    // and the decision written as one explicit entry beside the legacy keys it does not supersede.
    should(offView.state).equal('off');
    should(carriersAfterOff).deepEqual([{ kind: 'direct', url: base }]);
    should(listenerAfterOff).equal('refused');
    should(holdingAfterOff).equal('forgotten');
    should(service.releases.length).equal(1);
    should(documentAfterOff).deepEqual({
      host: '127.0.0.1',
      port,
      carriers: [{ kind: 'tunnel', source: 'discovery', enabled: false }],
    });
    should(service.verdicts).deepEqual([true, true]);
    // Published after direct and before any relay, at the hostname the service provisioned.
    should(carriersThroughTunnel).deepEqual([
      { kind: 'direct', url: base },
      { kind: 'tunnel', url: 'https://quiet-otter.tunnels.example' },
    ]);
    // A tunnel arrival is remote: no privileged-only route, governed and not host-local, like a relay.
    should(privilegedThroughTunnel.status).equal(403);
    should(privilegedDirect.status).not.equal(403);
    should([grantsThroughTunnel.governed, grantsThroughTunnel.hostLocal]).deepEqual([true, false]);
    should(pairedOverTunnel.kind).equal('refused');
    should(pairedDirectAfter.kind).equal('paired');
    // Nothing but the session route is served on the tunnel's port, whatever credential is presented.
    should(plainHttp).deepEqual([404, 404, 404]);
    should(afterStop).equal('refused');
  });

  it('should release on update the tunnel the old implied-on default provisioned, and say how to turn it on', async () => {
    // A daemon that provisioned a tunnel before the tunnel became opt-in, booting on the same document
    // — which names no tunnel, and so now means none. Nothing is provisioned, and the held tunnel goes
    // back to the pool with one line saying why and how to have it back.
    // Arrange
    const home = await tempDirectory('fyd-tunnel-migration');
    const service = new FakeHostedService();
    const fake = await fakeCloudflared();
    const said = recordingNotices();
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const seeded = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await writeFile(
      join(home, 'state', 'tunnel.json'),
      `${JSON.stringify({ version: 1, origin: service.origin, tunnelUrl: 'https://quiet-otter.tunnels.example' })}\n`,
      { mode: 0o600 },
    );
    const world: DaemonWorld = {
      ...seeded,
      notices: said.port,
      tunnelService: { read: async () => ({ kind: 'available', origin: service.origin }) },
      cloudflared: new CloudflaredLocator({ FY_CLOUDFLARED: fake.path }),
    };
    const discovery = process.env.FY_RELAY_DIRECTORY_ORIGIN;
    process.env.FY_RELAY_DIRECTORY_ORIGIN = service.origin;

    // Act
    const exit = start(world, cleanups);
    await waitUntil(() => service.releases.length > 0, 'the held tunnel to be released');
    await waitUntil(
      () => said.stated.some(line => line.startsWith('tunnel carrier off (opt-in) — released')),
      'the release to be said',
    );
    const holding = await readFile(join(home, 'state', 'tunnel.json'), 'utf8').catch(() => 'forgotten');
    release();
    const code = await exit;
    await runCleanups(cleanups);
    process.env.FY_RELAY_DIRECTORY_ORIGIN = discovery;
    await service.stop();
    await removeTempDirectories();

    // Assert
    should(code).equal(0);
    should(service.provisions).deepEqual([]);
    should(service.verdicts).deepEqual([true]);
    should(holding).equal('forgotten');
    should(said.steps).containEql('tunnel carrier off (opt-in) — turn on with `fy daemon tunnel on`');
    should(said.stated).containEql(
      'tunnel carrier off (opt-in) — released https://quiet-otter.tunnels.example; turn on with `fy daemon tunnel on`',
    );
  });

  it('should delete a stale operator-password verifier at boot and say so once', async () => {
    // The passkey step-up replaced the operator password with no compatibility path, so a verifier an
    // older daemon left behind gates nothing. Left in place it would read as a lock to anyone who found
    // it, so a real boot removes it and tells the operator where the password went.
    // Arrange — a state home with the retired file in it, and a second boot with none.
    const home = await tempDirectory('fyd-retired-password');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const said = recordingNotices();
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      notices: said.port,
    };
    const stale = join(home, 'state', 'operator-password.json');
    await writeFile(stale, '{"argon2id":"$argon2id$stale"}\n', { mode: 0o600 });

    // Act
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const afterBoot = await readdir(join(home, 'state'));
    release();
    const code = await exit;
    await runCleanups(cleanups);

    const secondHome = await tempDirectory('fyd-no-retired-password');
    const secondCleanups: Array<() => void | Promise<void>> = [];
    const secondSaid = recordingNotices();
    let secondRelease = (): void => {};
    const secondWorld = {
      ...(await worldAt(secondHome, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          secondRelease = resolve;
        });
      })),
      notices: secondSaid.port,
    };
    const secondExit = start(secondWorld, secondCleanups);
    const secondPort = await recordedPort(secondHome);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${secondPort}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    secondRelease();
    const secondCode = await secondExit;
    await runCleanups(secondCleanups);

    // Assert
    should(code).equal(0);
    should(afterBoot).not.containEql('operator-password.json');
    const retired = said.steps.filter(step => step.startsWith('operator password retired'));
    should(retired).have.length(1);
    should(retired[0]).match(/deleted state\/operator-password\.json/u);
    // A machine that never had one is told nothing: the notice is true only when a file was there.
    should(secondCode).equal(0);
    should(secondSaid.steps.filter(step => step.startsWith('operator password retired'))).be.empty();
  });

  /**
   * The task board, driven through the production composition root over a real socket.
   *
   * This is the test the unit "is it mounted" assertion cannot be: it proves the board DOES ITS JOB —
   * the record is created by the real reducer, committed by the real file store into the real session
   * directory inside the state home, read back by a second request, enriched from the real session
   * index, and visible to the fleet-wide read. Nothing here is faked but the shutdown signal.
   */
  it('should create, persist, enrich and re-read a task through the mounted board', async () => {
    // Arrange
    const home = await tempDirectory('fyd-tasks');
    const at = '2026-07-31T09:00:00.000Z';
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await seedSession(home, at);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const base = `http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/tasks`;

    // Act
    const created = await fetch(base, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'feature',
        title: 'Mount the task boards',
        ask: { text: 'the daemon had no boards', source: 'human' },
      }),
    });
    const createdBody = (await created.json()) as { id: string; assignee: string; live: { assigneeName: string } };
    const advanced = await fetch(`${base}/${createdBody.id}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status', status: 'in_progress', reason: 'wiring it' }),
    });
    // Assigned by CALLSIGN, which is what `fy task create --assignee <who>` documents its argument as,
    // and by a name nothing answers to.
    const byCallsign = await fetch(base, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'chore',
        title: 'Resolve the assignee',
        ask: { text: 'a teammate owns it', source: 'human' },
        assignee: SEEDED_CALLSIGN,
      }),
    });
    const byCallsignBody = (await byCallsign.json()) as {
      id: string;
      live: { assigneeSessionId: string | null; assigneeName: string | null; assigneeStatus: string | null };
    };
    const byStranger = await fetch(base, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'chore',
        title: 'Owned by nobody here',
        ask: { text: 'nothing answers to this', source: 'human' },
        assignee: 'not-a-teammate',
      }),
    });
    const byStrangerBody = (await byStranger.json()) as { live: { assigneeSessionId: string | null } };
    const listed = await fetch(base, { headers });
    const detail = await fetch(`${base}/${createdBody.id}`, { headers });
    const fleet = await fetch(`http://127.0.0.1:${port}/v1/tasks`, { headers });
    const listedBody = (await listed.json()) as { tasks: { id: string; status: string }[]; parseErrors: number };
    const detailBody = (await detail.json()) as { activity: { type: string }[] };
    const fleetBody = (await fleet.json()) as { sessionId: null; tasks: { sessionId: string; id: string }[] };
    // The board is one atomic snapshot inside the session's own private directory.
    const snapshot = await readFile(join(home, 'state', 'sessions', SESSION_ID, 'tasks.json'), 'utf8');
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(created.status).equal(201);
    should(createdBody.id).equal('F1');
    // An omitted assignee means the owning session, which the mount must not collapse to `null`.
    should(createdBody.assignee).equal(SESSION_ID);
    // Enrichment came from the real session index, not from anything the request carried.
    should(createdBody.live.assigneeName).equal('Wire Subsystems');
    // A teammate CALLSIGN resolved to the session that answers to it, over the real session
    // documents. This is the capability `exactWorkerAssignee` was built for and nothing called: the
    // daemon matched session ids only, so every task a person assigned by name reported a null live
    // column.
    should(byCallsign.status).equal(201);
    should(byCallsignBody.live.assigneeSessionId).equal(SESSION_ID);
    should(byCallsignBody.live.assigneeName).equal('Wire Subsystems');
    should(byCallsignBody.live.assigneeStatus).equal('running');
    // A name nothing answers to stays honestly unknown rather than being attached to whoever was
    // nearest in the index.
    should(byStrangerBody.live.assigneeSessionId).be.null();
    should(advanced.status).equal(200);
    should(listed.status).equal(200);
    should(listedBody.parseErrors).equal(0);
    should(listedBody.tasks.map(task => [task.id, task.status])).deepEqual([
      ['F1', 'in_progress'],
      ['C1', 'todo'],
      ['C2', 'todo'],
    ]);
    // The history survived the second request, which only a durable board can do.
    should(detailBody.activity.map(event => event.type)).deepEqual(['created', 'status']);
    should(fleetBody.sessionId).be.null();
    should(fleetBody.tasks.map(task => [task.sessionId, task.id])).deepEqual([
      [SESSION_ID, 'F1'],
      [SESSION_ID, 'C1'],
      [SESSION_ID, 'C2'],
    ]);
    should(JSON.parse(snapshot) as { tasks: unknown[] })
      .have.property('tasks')
      .with.length(3);
  });

  /**
   * The session read, driven through the production composition root over a real socket.
   *
   * It proves the mount DOES ITS JOB rather than merely existing: the fleet comes from the real
   * session index, both documents are parsed back out by the same protocol schemas that wrote them,
   * and the directory each view reports is the one the layout actually put the documents in — which
   * the case checks by reading a file out of it. A session the index does not hold is absent, and a
   * session whose documents no longer satisfy the protocol is refused rather than reported missing.
   *
   * The mounted attention board is held to those same two answers on those same two ids, because its
   * existence proof is this registry. A board with no ledger file is legitimately empty, so a check
   * that read only the ledger would answer `200 { count: 0 }` both for a session that does not exist
   * and for one whose documents are damaged — the failure mode that hides a session waiting on the
   * human behind an empty board.
   */
  it('should list and read the seeded sessions through the mounted session read', async () => {
    // Arrange
    const home = await tempDirectory('fyd-sessions');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await seedSession(home, '2026-07-30T09:00:00.000Z', 'wire-one');
    await seedSession(home, '2026-07-31T09:00:00.000Z', 'wire-two', { status: 'completed', turn: 4 });
    // A session the index holds whose state document the protocol will refuse. Written straight into
    // the session directory, because the storage writer would not accept it either.
    await seedSession(home, '2026-07-31T10:00:00.000Z', 'wire-bad');
    await writeFile(join(home, 'state', 'sessions', 'wire-bad', 'state.json'), JSON.stringify({ id: 'wire-bad' }), {
      mode: 0o600,
    });
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;

    // Act
    const listed = await fetch(sessions, { headers });
    const one = await fetch(`${sessions}/wire-one`, { headers });
    const absent = await fetch(`${sessions}/wire-ghost`, { headers });
    const unusable = await fetch(`${sessions}/wire-bad`, { headers });
    // The same three sessions asked for their attention board. The board's existence proof is the
    // session registry, so each answer is the registry's answer rather than the ledger file's — and
    // none of these sessions has ever written an `attention.json`, so a ledger-only check would have
    // served all three the same empty board.
    const liveBoard = await fetch(`${sessions}/wire-one/attention`, { headers });
    const absentBoard = await fetch(`${sessions}/wire-ghost/attention`, { headers });
    const unusableBoard = await fetch(`${sessions}/wire-bad/attention`, { headers });
    const listedBody = SessionListSchema.parse(await listed.json());
    const oneBody = SessionViewSchema.parse(await one.json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(listed.status).equal(200);
    // The two usable sessions, in the real index's newest-first order. The third is omitted rather
    // than half-reported.
    should(listedBody.map(session => [session.config.id, session.state.status])).deepEqual([
      ['wire-two', 'completed'],
      ['wire-one', 'running'],
    ]);
    should(one.status).equal(200);
    should(oneBody.config.name).equal('Wire Subsystems');
    should(oneBody.config.cwd).equal(home);
    // The reported directory is the layout's own, proved by reading the marker the storage wrote.
    should(oneBody.directory).equal(join(home, 'state', 'sessions', 'wire-one'));
    should(await readFile(join(oneBody.directory, 'session-version'), 'utf8')).not.be.empty();
    should(absent.status).equal(404);
    should((await absent.json()) as { code: string }).have.property('code', 'not-found');
    // Omitted from the list, but answerable here: "it does not exist" would be a lie.
    should(unusable.status).equal(500);
    should((await unusable.json()) as { code: string }).have.property('code', 'unusable_session_document');
    // The control: a session the registry proves, with no ledger written, DOES get the empty board.
    // Without this line the two refusals below could be a route that fails for everyone.
    should(liveBoard.status).equal(200);
    should((await liveBoard.json()) as { count: number }).have.property('count', 0);
    // The attention board answers on the same two ids, and a missing ledger file is an empty board
    // ONLY when the registry can prove the session. A session nothing holds is not-found rather than
    // a 200 board with nothing on it, which is what a ledger-only existence check would have served.
    should(absentBoard.status).equal(404);
    should((await absentBoard.json()) as { code: string }).have.property('code', 'not-found');
    // Session document damage fails the board CLOSED. Neither answer here is 200: the daemon cannot
    // prove the session exists, so it must not report "no attention" for a session that may well be
    // blocked on the human — a silent empty board is the failure mode that hides a waiting session.
    should(unusableBoard.status).equal(500);
    should((await unusableBoard.json()) as { code: string }).have.property('code', 'internal_error');
  });

  /**
   * Starting and stopping a session, driven through the production composition root over a real
   * socket. This is the capability the daemon did not have: every other mount is addressed by a
   * session id, and nothing could create one.
   *
   * Only the agent launcher is substituted, at the seam `DaemonWorld` exposes for exactly this —
   * spawning an agent is not something a suite may do. EVERYTHING else is production: the fleet
   * manifest resolves the wrapper, this host's `PATH` resolves the executable, the real planner shapes
   * the session, the real lifecycle service writes the real state home, and the answer comes back
   * through the same reader `GET /v1/sessions` serves.
   *
   * The assertion that matters most is that the session is VISIBLE afterwards. The lifecycle and the
   * protocol describe a session with two different documents in one file, and a start that wrote only
   * the lifecycle's half would answer 201 and then be dropped by every mounted read — the session list,
   * the task board's enrichment, analytics and the callsign pool all `safeParse` that document.
   */
  it('should start, launch, list and stop a session through the mounted lifecycle', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-start');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
    };
    // AFTER the layout is established: a home holding files with no version marker is exactly the
    // foreign state the layout gate refuses.
    const executable = await seedFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const body = JSON.stringify({
      agent: WRAPPER,
      mode: 'auto',
      prompt: 'wire the session lifecycle',
      name: 'Wire Session Lifecycle',
      teammate: SEEDED_CALLSIGN,
      cwd: home,
    });
    const startCall = async (requestId: string): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId },
        body,
      });

    // Act
    const started = await startCall('req-boot-1');
    const startedBody = SessionViewSchema.parse(await started.json());
    // The retry the protocol client performs itself after a transport error.
    const retried = await startCall('req-boot-1');
    const retriedBody = SessionViewSchema.parse(await retried.json());
    // Counted here rather than at the end: two more starts follow, and both are meant to launch.
    const launchesAfterRetry = launcher.launched.length;
    const listed = SessionListSchema.parse(await (await fetch(sessions, { headers })).json());
    const names = NameSuggestionsSchema.parse(
      await (await fetch(`http://127.0.0.1:${port}/v1/names?count=8`, { headers })).json(),
    );
    // The turn-one document the agent is told to read, inside the session's own private directory.
    const turnOne = await readFile(
      join(home, 'state', 'sessions', startedBody.config.id, 'turns', 'turn-001.md'),
      'utf8',
    );
    const stopped = await fetch(`${sessions}/${startedBody.config.id}/stop`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'the task is done' }),
    });
    const stoppedBody = SessionViewSchema.parse(await stopped.json());
    const unknownAgent = await fetch(sessions, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': 'req-boot-2' },
      body: JSON.stringify({ agent: 'claude-auto-absent', mode: 'auto', prompt: 'nobody can serve this', cwd: home }),
    });
    // A second session asking for the callsign the first one claimed, then the same start allowing a
    // fallback. The claim is what makes the first a refusal rather than a duplicate name.
    const contested = async (requestId: string, fallback: boolean): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId },
        body: JSON.stringify({
          agent: WRAPPER,
          mode: 'auto',
          prompt: 'contest the callsign',
          teammate: SEEDED_CALLSIGN,
          teammateFallback: fallback,
          cwd: home,
        }),
      });
    const taken = await contested('req-boot-3', false);
    const fellBack = await contested('req-boot-4', true);
    const fellBackBody = SessionViewSchema.parse(await fellBack.json());
    // The third step of the retry contract: after a start whose answer was lost, the client asks which
    // session its request id produced, proving with the digest of the very body it posted.
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    const recovery = (value: string): string =>
      `${sessions}/by-request/req-boot-1?payload=${encodeURIComponent(value)}`;
    const recovered = await fetch(recovery(digest), { headers });
    const recoveredBody = SessionViewSchema.parse(await recovered.json());
    const wrongDigest = await fetch(recovery(createHash('sha256').update('{}', 'utf8').digest('hex')), { headers });
    const neverSent = await fetch(`${sessions}/by-request/req-never?payload=${digest}`, { headers });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(started.status).equal(201);
    // The document records the wrapper NAME every account is published under, never the absolute
    // program: the fleet manifest, `fy ps` and the analytics index all join on this value.
    should(startedBody.config.agent).equal(WRAPPER);
    should(startedBody.config.harness).equal('claude');
    // The model came from the manifest's own default through the real planner.
    should(startedBody.config.model).equal('claude-opus-5');
    should(startedBody.config.name).equal('Wire Session Lifecycle');
    should(startedBody.state.status).equal('running');
    // The agent that was launched is the ABSOLUTE executable this host resolved, in the caller's
    // directory — not a bare name the lifecycle would have refused. It carries the harness session
    // id this start MINTED, which is what makes the transcript path below true rather than guessed.
    const launched = launcher.launched[0];
    should(launched?.cwd).equal(home);
    should(launched?.command.slice(0, 2)).deepEqual([executable, '--session-id']);
    // It may READ exactly this session's own hand-off folders without a permission prompt — its turn
    // documents, its queued messages, its starting attachments and the copies a send delivers — and
    // the launch grants nothing broader: no other folder, and no write anywhere.
    const own = join(home, 'state', 'sessions', startedBody.config.id);
    const grants = (launched?.command ?? []).filter(argument => argument.startsWith('--allowedTools'));
    should(grants.slice(0, 3)).deepEqual([
      `--allowedTools=Read(/${join(own, 'turns')}/**)`,
      `--allowedTools=Read(/${join(own, 'channel')}/**)`,
      `--allowedTools=Read(/${join(own, 'attachments')}/**)`,
    ]);
    // The attachment store's tree is keyed by this daemon's pairing identity, then by the session.
    const store = join(home, 'state', 'attachments');
    should(grants).have.length(4);
    should(grants[3]?.startsWith(`--allowedTools=Read(/${store}/`)).be.true();
    should(grants[3]?.endsWith(`/${startedBody.config.id}/**)`)).be.true();
    should(grants[3]?.slice(`--allowedTools=Read(/${store}/`.length).split('/')).have.length(3);
    should(
      launched?.command.some(argument => argument === '--add-dir' || argument.startsWith('--add-dir=')),
    ).be.false();
    // The transcript record is on the session's own document, in the same write as everything else
    // the start decided — and it names the exact file the harness will write.
    const provenance = startedBody.config.transcript;
    should(provenance).have.properties({ home: join(home, 'harness'), identity: 'minted' });
    should(provenance?.harnessSessionId).equal(launched?.command[2]);
    should(provenance?.file).equal(
      join(
        home,
        'harness',
        'projects',
        home.replaceAll(/[^a-zA-Z0-9]/gu, '-'),
        `${provenance?.harnessSessionId}.jsonl`,
      ),
    );
    // The assignment was handed over by pointing the agent at a file, and the file is really there.
    should(launcher.delivered[0]).containEql('turns/turn-001.md');
    should(turnOne).containEql('wire the session lifecycle');
    // The retry answered with the SAME session and launched nothing further: one request id, one agent.
    should(retriedBody.config.id).equal(startedBody.config.id);
    should(launchesAfterRetry).equal(1);
    // Visible to the fleet read, which only a document satisfying BOTH schemas can be.
    should(listed.map(session => session.config.id)).deepEqual([startedBody.config.id]);
    // Where its journal stood, so a reader starting the live feed here replays none of the history.
    should(listed[0]?.journalSequence).be.a.Number().and.be.above(0);
    // And visible to the callsign pool: the name this session took is no longer offered.
    should(names).not.containEql(SEEDED_CALLSIGN);
    should(stopped.status).equal(200);
    should(stoppedBody.state.status).equal('stopped');
    should(stoppedBody.state.reason).equal('the task is done');
    // The stop merged over the document rather than replacing it: the protocol half survived a
    // transition that knows nothing about it.
    should(stoppedBody.config.agent).equal(WRAPPER);
    should(stoppedBody.config.model).equal('claude-opus-5');
    should(launcher.stopped).have.length(1);
    // A fleet that publishes no such account is the caller's mistake, named as one.
    should(unknownAgent.status).equal(404);
    should((await unknownAgent.json()) as { code: string }).have.property('code', 'unknown_agent');
    // The callsign was CLAIMED, not merely recorded: a second session cannot answer to it, because a
    // bare callsign that resolved to two sessions would name neither.
    should(startedBody.config.teammate).equal(SEEDED_CALLSIGN);
    should(taken.status).equal(409);
    should((await taken.json()) as { code: string }).have.property('code', 'callsign_taken');
    // A caller who allows a substitute gets a real free pool name instead of a refusal.
    should(fellBack.status).equal(201);
    should(fellBackBody.config.teammate).not.equal(SEEDED_CALLSIGN);
    should(DEFAULT_CALLSIGN_POOL).containEql(fellBackBody.config.teammate);
    // The recovery read answers with the session that request id actually started, so a start whose
    // response was lost in transport is recoverable instead of leaving a running session nobody knows
    // about. The digest is the proof: without it any holder of the admin token could enumerate other
    // callers' request ids, and a digest of a different body names a start this was not.
    should(recovered.status).equal(200);
    should(recoveredBody.config.id).equal(startedBody.config.id);
    should(wrongDigest.status).equal(409);
    should((await wrongDigest.json()) as { code: string }).have.property('code', 'request_id_reused');
    // A request id no start ever carried is the honest miss: that start never reached the daemon.
    should(neverSent.status).equal(404);
  });

  /**
   * Agent names, through the real composition root: a start that names nobody is given a first name
   * from the pool, and a rename CLAIMS the new name through the same ledger — so a name another agent
   * holds is refused in plain words, and the rename is journalled with the actor that made it.
   *
   * WHY THIS TIER. The automatic claim and the rename's ports are wired in `bin/fyd.ts`, which is
   * excluded from both coverage ledgers; nothing below this proves the assembled daemon does either.
   */
  it('should name every new agent and rename one through the mounted route', async () => {
    // Arrange
    const home = await tempDirectory('fyd-agent-names');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: new RecordingSessionLauncher(),
    };
    await seedFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = {
      authorization: `Bearer ${token}`,
      'x-ferretry-client': 'cli',
      'content-type': 'application/json',
    };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startOne = async (requestId: string, extra: Readonly<Record<string, string>>): Promise<SessionView> =>
      SessionViewSchema.parse(
        await (
          await fetch(sessions, {
            method: 'POST',
            headers: { ...headers, 'x-fy-request-id': requestId },
            body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'do the work', cwd: home, ...extra }),
          })
        ).json(),
      );
    const rename = async (id: string, body: unknown): Promise<Response> =>
      await fetch(`${sessions}/${id}/rename`, { method: 'POST', headers, body: JSON.stringify(body) });

    // Act
    const unnamed = await startOne('req-names-1', { name: 'Fix The Build' });
    const named = await startOne('req-names-2', { teammate: SEEDED_CALLSIGN });
    const taken = await rename(unnamed.config.id, { teammate: SEEDED_CALLSIGN });
    const renamed = await rename(unnamed.config.id, { teammate: 'Mary-Jane', name: 'Ship The Build' });
    const renamedBody = SessionViewSchema.parse(await renamed.json());
    const contested = await fetch(sessions, {
      method: 'POST',
      headers: { ...headers, 'x-fy-request-id': 'req-names-3' },
      body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'take it', cwd: home, teammate: 'Mary-Jane' }),
    });
    const absent = await rename('ses-absent', { teammate: 'marin' });
    const journal = await readFile(join(home, 'state', 'sessions', unnamed.config.id, 'events.jsonl'), 'utf8');
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // Named from the pool without being asked, and still distinct from the agent that asked for one.
    should(DEFAULT_CALLSIGN_POOL).containEql(unnamed.config.teammate);
    should(unnamed.config.teammate).not.equal(SEEDED_CALLSIGN);
    should(named.config.teammate).equal(SEEDED_CALLSIGN);
    should(taken.status).equal(409);
    should((await taken.json()) as { code: string }).have.property('code', 'name_taken');
    should(renamed.status).equal(200);
    should(renamedBody.config.teammate).equal('mary-jane');
    should(renamedBody.config.name).equal('Ship The Build');
    // The new name is CLAIMED: a later start cannot take it either.
    should(contested.status).equal(409);
    should((await contested.json()) as { code: string }).have.property('code', 'callsign_taken');
    should(absent.status).equal(404);
    const entry = journal
      .split('\n')
      .filter(line => line.includes('session.renamed'))
      .map(line => JSON.parse(line) as { data: Record<string, unknown> })[0];
    should(entry?.data).have.properties({
      actor: 'admin-cli',
      to: { teammate: 'mary-jane', name: 'Ship The Build' },
    });
  });

  /**
   * Hypermedia, through the real composition root: every new ferret starts with it on, and the switch
   * writes BOTH places it lives — the configuration every surface reads and the launch environment the
   * pane reads — so the next launch is told what the owner chose (docs/hypermedia.md).
   *
   * WHY THIS TIER. The two writes are wired in `bin/fyd.ts`, which is excluded from both coverage
   * ledgers; the unit suite proves the decision and nothing below this proves the assembled daemon
   * records it where `fy mcp serve` will read it.
   */
  it('should start an auto ferret with hypermedia off, and let the owner switch it on and off for the next launch', async () => {
    // Arrange
    const home = await tempDirectory('fyd-hypermedia');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: new RecordingSessionLauncher(),
    };
    await seedFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = {
      authorization: `Bearer ${token}`,
      'x-ferretry-client': 'cli',
      'content-type': 'application/json',
    };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const switchTo = async (id: string, enabled: boolean): Promise<Response> =>
      await fetch(`${sessions}/${id}/hypermedia`, { method: 'PATCH', headers, body: JSON.stringify({ enabled }) });
    const environments = new FileSessionEnvironmentStore(id => join(home, 'state', 'sessions', id));

    // Act
    const started = SessionViewSchema.parse(
      await (
        await fetch(sessions, {
          method: 'POST',
          headers: { ...headers, 'x-fy-request-id': 'req-hypermedia-1' },
          body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'explain it', cwd: home }),
        })
      ).json(),
    );
    const on = await switchTo(started.config.id, true);
    const onBody = SessionHypermediaPatchResultSchema.parse(await on.json());
    const storedOn = await environments.read(parseSessionId(started.config.id));
    const off = await switchTo(started.config.id, false);
    const offBody = SessionHypermediaPatchResultSchema.parse(await off.json());
    const stored = await environments.read(parseSessionId(started.config.id));
    const absent = await switchTo('ses-absent', true);
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // An auto ferret starts with hypermedia off; the owner's explicit switch is what turns it on or off.
    should(started.config.hypermedia).be.false();
    should(onBody.view.config.hypermedia).be.true();
    should(onBody.note).startWith('Hypermedia is on');
    should(sessionPaneEnvironment(parseSessionId(started.config.id), storedOn, 'auto')).have.property(
      'FY_HYPERMEDIA',
      '1',
    );
    should(off.status).equal(200);
    should(offBody.view.config.hypermedia).be.false();
    should(offBody.note).startWith('Hypermedia is off');
    should(stored).have.property('FY_HYPERMEDIA', '0');
    should(sessionPaneEnvironment(parseSessionId(started.config.id), stored, 'interactive')).have.property(
      'FY_HYPERMEDIA',
      '0',
    );
    should(absent.status).equal(404);
  });

  /**
   * Pack mode, through the real composition root (docs/pack-mode.md): every start with a parent is held
   * to the sub-ferret limits whichever route made it, each new ferret's launch environment says whether
   * it is told about Pack mode (never at the deepest level), the per-ferret switch writes both places,
   * and a running ferret's result reads as unfinished.
   *
   * WHY THIS TIER. The hooks are wired in `bin/fyd.ts`, which is excluded from both coverage ledgers.
   */
  it('should hold every start with a parent to the sub-ferret limits and tell each ferret about Pack mode', async () => {
    // Arrange
    const home = await tempDirectory('fyd-pack');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: new RecordingSessionLauncher(),
    };
    await seedFleet(home);
    // Tighter than the defaults, so it applies at once: one running sub-ferret per unattended ferret.
    await writeFile(join(home, 'config', 'pack.yaml'), 'limits:\n  autoChildren: 1\n', { mode: 0o600 });
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = {
      authorization: `Bearer ${token}`,
      'x-ferretry-client': 'cli',
      'content-type': 'application/json',
    };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startOne = async (request: string, parent?: string): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'x-fy-request-id': request },
        body: JSON.stringify({
          agent: WRAPPER,
          mode: 'auto',
          prompt: 'work',
          cwd: home,
          ...(parent === undefined ? {} : { parent }),
        }),
      });
    const environments = new FileSessionEnvironmentStore(id => join(home, 'state', 'sessions', id));
    const pack = async (id: string): Promise<string | undefined> =>
      (await environments.read(parseSessionId(id))).FY_PACK;

    // Act
    const root = SessionViewSchema.parse(await (await startOne('req-pack-root')).json());
    const child = SessionViewSchema.parse(await (await startOne('req-pack-child', root.config.id)).json());
    const second = await startOne('req-pack-second', root.config.id);
    const grandchild = SessionViewSchema.parse(await (await startOne('req-pack-grand', child.config.id)).json());
    const tooDeep = await startOne('req-pack-deep', grandchild.config.id);
    const off = await fetch(`${sessions}/${root.config.id}/pack`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    const offBody = SessionPackPatchResultSchema.parse(await off.json());
    const result = SessionResultSchema.parse(
      await (await fetch(`${sessions}/${child.config.id}/result`, { headers })).json(),
    );
    const refusals = [await second.json(), await tooDeep.json()] as { code?: string }[];
    const environment = {
      root: await pack(root.config.id),
      child: await pack(child.config.id),
      grand: await pack(grandchild.config.id),
    };
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(child.config.parent).equal(root.config.id);
    should(second.status).equal(409);
    should(tooDeep.status).equal(409);
    should(refusals.map(body => body.code)).deepEqual(['limit_reached', 'depth_exceeded']);
    should({ ...environment, root: environment.root }).deepEqual({ root: '0', child: '1', grand: '0' });
    should(offBody.view.config.pack).be.false();
    should(offBody.note).startWith('Pack mode is off');
    should(result).deepEqual({ id: child.config.id, status: child.state.status, finished: false });
  });

  /**
   * A start naming a model the account cannot serve, through the real composition root.
   *
   * WHY THIS TIER. The refusal is decided in `bin/fyd.ts`, which is excluded from BOTH coverage
   * ledgers, so the unit suite can prove the planner REFUSES and nothing above this proves the
   * assembled daemon answers with it. Delete the check and every gate in the repository stays green
   * while the daemon goes back to launching a model nobody asked for.
   *
   * AND THE CALLSIGN. The name is claimed before the plan, because the plan is named after it, so this
   * is the one refusal that happens with a pool name already reserved. All three starts here ask for
   * the SAME callsign and the third succeeds — which is the only way to prove the two refusals released
   * it rather than parking it for the whole resolution window.
   */
  it('should refuse a start naming a model the account cannot serve, and free the callsign it claimed', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-model-refusal');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
    };
    const executable = await seedFleet(home);
    // Republished over the seed with a second model the operator has taken OUT of service, carrying
    // their own reason. That sentence is the most useful thing this daemon will ever have to say about
    // that model, and a generic "not served" would throw it away.
    await publishManifest(home, [
      {
        id: BOOT_ACCOUNT,
        kind: 'claude',
        mode: 'auto',
        wrapper: executable,
        home: join(home, 'harness'),
        displayName: 'Boot',
        defaultModel: 'claude-opus-5',
        models: [
          { id: 'claude-opus-5', available: true },
          {
            id: 'claude-haiku-4-5',
            available: false,
            unavailableReason: 'this subscription tier does not include Haiku',
          },
        ],
        available: true,
        unavailableReason: null,
      },
    ]);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startCall = async (requestId: string, model?: string): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId },
        body: JSON.stringify({
          agent: WRAPPER,
          mode: 'auto',
          prompt: 'name a model this account cannot serve',
          teammate: SEEDED_CALLSIGN,
          cwd: home,
          ...(model === undefined ? {} : { model }),
        }),
      });

    // Act
    const unknownModel = await startCall('req-model-1', 'gpt-5.6-terra');
    const unknownBody = (await unknownModel.json()) as { readonly code: string; readonly error: string };
    const withdrawnModel = await startCall('req-model-2', 'claude-haiku-4-5');
    const withdrawnBody = (await withdrawnModel.json()) as { readonly code: string; readonly error: string };
    // No model at all, asking for the very callsign both refusals claimed.
    const reclaimed = await startCall('req-model-3');
    const reclaimedBody = SessionViewSchema.parse(await reclaimed.json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // 409, not 503: the account is a perfectly good target and would start a session for any model it
    // declares, so a retry of this request cannot succeed and must not be invited.
    should(unknownModel.status).equal(409);
    should(unknownBody.code).equal('unservable_model');
    should(unknownBody.error).match(/does not serve model "gpt-5\.6-terra"/u);
    // What it DOES serve, so the refusal ends the question instead of starting one.
    should(unknownBody.error).match(/It serves claude-opus-5/u);
    should(withdrawnModel.status).equal(409);
    should(withdrawnBody.error).match(/cannot serve model "claude-haiku-4-5": this subscription tier/u);
    // NOTHING was launched for either refusal: the substitution used to happen after this point, so a
    // launch count of one is the difference between refusing and quietly running something else.
    should(launcher.launched).have.length(1);
    should(reclaimed.status).equal(201);
    should(reclaimedBody.config.model).equal('claude-opus-5');
    // The callsign both refusals asked for, held by the start that actually happened.
    should(reclaimedBody.config.teammate).equal(SEEDED_CALLSIGN);
  });

  /**
   * Fast mode at launch, through the production composition root.
   *
   * WHY THIS TIER. The decisions are made in `bin/fyd.ts` — refuse a model with no fast mode before
   * anything is written, read the login's fixed overlay, record the state the session launched in — and
   * that file is outside both ledgers. What matters is the assembled behaviour: a start that names fast
   * mode launches with the overlay REPLACED (Claude honours one `--settings`, so the permission mode has
   * to travel with it), a restart keeps the state the pane was last switched to, and a model with no
   * fast mode is refused with the callsign freed.
   */
  it('should launch in fast mode, keep it across a restart, and refuse a model that has none', async () => {
    // Arrange
    const home = await tempDirectory('fyd-fast-mode');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    const reviver = new RecordingResumeLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
      createResumeLauncher: (
        _storage: unknown,
        relaunch: (id: SessionId) => Promise<readonly string[] | undefined>,
      ) => {
        reviver.argvFor = relaunch;
        return reviver;
      },
    };
    const wrapper = await seedFleet(home);
    const harness = join(home, 'harness');
    await mkdir(join(harness, '.fy'), { recursive: true });
    await writeFile(
      join(harness, '.fy', 'fixed.json'),
      JSON.stringify({ permissions: { defaultMode: 'auto' }, skipAutoPermissionPrompt: true }),
    );
    await publishManifest(home, [
      {
        id: BOOT_ACCOUNT,
        kind: 'claude',
        mode: 'auto',
        wrapper,
        home: harness,
        displayName: 'Boot',
        defaultModel: 'claude-opus-5-5',
        models: [
          { id: 'claude-opus-5-5', available: true },
          { id: 'claude-sonnet-5-5', available: true },
        ],
        available: true,
        unavailableReason: null,
      },
    ]);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const cli = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startCall = async (requestId: string, fields: Record<string, unknown>): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...cli, 'x-fy-request-id': requestId },
        body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'go fast', cwd: home, ...fields }),
      });
    const overlay = (argv: readonly string[]): unknown => {
      const at = argv.indexOf('--settings');
      return at < 0 ? undefined : JSON.parse(argv[at + 1] ?? 'null');
    };

    // Act
    const refused = await startCall('req-fast-1', {
      model: 'claude-sonnet-5-5',
      fast: true,
      teammate: SEEDED_CALLSIGN,
    });
    const refusedBody = (await refused.json()) as { readonly code: string; readonly error: string };
    const fast = await startCall('req-fast-2', { fast: true, teammate: SEEDED_CALLSIGN });
    const fastRaw: unknown = await fast.json();
    if (fast.status !== 201) throw new Error(`the fast start failed: ${JSON.stringify(fastRaw)}`);
    const id = SessionViewSchema.parse(fastRaw).config.id;
    const plain = await startCall('req-fast-3', {});
    const plainBody = SessionViewSchema.parse(await plain.json());
    const configFile = join(home, 'state', 'sessions', id, 'config.json');
    const stateFile = join(home, 'state', 'sessions', id, 'state.json');
    const document = async (file: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    // The owner typed /fast off in the pane; the harness said so after the start decided.
    await writeFile(
      stateFile,
      JSON.stringify({
        ...(await document(stateFile)),
        observedFast: false,
        observedModelAt: '2099-01-01T00:00:00.000Z',
      }),
      { mode: 0o600 },
    );
    await fetch(`${sessions}/${id}/stop`, {
      method: 'POST',
      headers: cli,
      body: JSON.stringify({ reason: 'pane died' }),
    });
    reviver.pane = { alive: false, dead: false, promptReady: false };
    const revived = await fetch(`${sessions}/${id}/resume`, {
      method: 'POST',
      headers: cli,
      body: JSON.stringify({ message: 'pick it back up' }),
    });
    const revivedConfig = await document(configFile);
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(refused.status).equal(409);
    should(refusedBody.code).equal('unservable_model');
    should(refusedBody.error).equal('claude-sonnet-5-5 has no fast mode');
    // The refusal launched nothing, and the callsign it claimed went to the start that did happen.
    should(launcher.launched).have.length(2);
    should(SessionViewSchema.parse(fastRaw).config.teammate).equal(SEEDED_CALLSIGN);
    // The overlay travels with fast mode: dropping it would launch an unattended agent without its permission mode.
    should(overlay(launcher.launched[0]?.command ?? [])).deepEqual({
      permissions: { defaultMode: 'auto' },
      skipAutoPermissionPrompt: true,
      fastMode: true,
    });
    should(SessionViewSchema.parse(fastRaw).config.launchFast).equal(true);
    // A start that named nothing asserts nothing and records nothing the login did not save.
    should(overlay(launcher.launched[1]?.command ?? [])).be.undefined();
    should(plainBody.config.launchFast).be.undefined();
    // THE RESTART keeps what the pane was switched to, not what the start asked for.
    should(revived.status).equal(200);
    should(overlay(reviver.argv[0] ?? [])).containEql({ fastMode: false });
    should(revivedConfig.launchFast).equal(false);
  });

  /**
   * The first start a stranger types: the account `fy fleet ls` lists FIRST, which is the one for
   * using the harness in a terminal and not one this daemon may launch.
   *
   * WHY THIS TIER. The refusal is decided in `bin/fyd.ts`, excluded from both ledgers, so only the
   * assembled daemon can prove it answers with the account that WOULD work rather than the bare path
   * the launch's own authorization can see. Both modes are asked, because the first-run audit tried
   * `--mode interactive` next and got the same unexplained refusal.
   */
  it('should refuse the terminal account by naming the auto account that can run the session', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-terminal-account');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
    };
    const executable = await seedFleet(home);
    // The default fleet's shape: the terminal account listed first, its auto account beside it. Its
    // wrapper is real and runnable, so nothing but the account itself can be why it is refused.
    const terminal = join(home, 'bin', 'claude-default');
    await writeFile(terminal, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const account = (id: string, wrapper: string, mode: 'auto' | 'interactive') => ({
      id,
      kind: 'claude',
      mode,
      wrapper,
      home: join(home, 'homes', basename(wrapper)),
      displayName: basename(wrapper),
      defaultModel: 'claude-opus-5',
      models: [{ id: 'claude-opus-5', available: true }],
      available: true,
      unavailableReason: null,
    });
    await publishManifest(home, [
      account('00000000-0000-4000-8000-00000000d0a1', terminal, 'interactive'),
      account(BOOT_ACCOUNT, executable, 'auto'),
    ]);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startCall = async (requestId: string, mode: 'auto' | 'interactive'): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId },
        body: JSON.stringify({ agent: 'claude-default', mode, prompt: 'hello', cwd: home }),
      });

    // Act
    const asAuto = await startCall('req-terminal-1', 'auto');
    const asAutoBody = (await asAuto.json()) as { readonly code: string; readonly error: string };
    const asInteractive = await startCall('req-terminal-2', 'interactive');
    const asInteractiveBody = (await asInteractive.json()) as { readonly code: string; readonly error: string };
    const listed = SessionListSchema.parse(await (await fetch(sessions, { headers })).json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    for (const [response, body] of [
      [asAuto, asAutoBody],
      [asInteractive, asInteractiveBody],
    ] as const) {
      should(response.status).equal(400);
      should(body.code).equal('invalid_request');
      // The account that works, and the command that uses it — not the path the launch would name.
      should(body.error).match(/Start it on claude-auto-boot instead: `fy start --agent claude-auto-boot/u);
      should(body.error).not.match(/not a fleet auto wrapper/u);
    }
    // Refused before anything was written or launched, so a corrected retry starts clean.
    should(launcher.launched).have.length(0);
    should(listed).have.length(0);
  });

  /**
   * Spawn ancestry cannot come from the mounted fleet list, even though both project the same four
   * configuration fields. That list deliberately omits an unusable session so one damaged record
   * does not take `fy ps` down; lineage needs the opposite answer, because omitting a damaged parent
   * turns "the parent cannot be read" into the false fact that no parent exists and writes an
   * unshielded stamp onto its child.
   *
   * Both production callers are pinned here. An ordinary start must refuse before launch, while a
   * relaunch that already replaced its pane remains successful but leaves its legacy missing stamp
   * untouched. Writing `wardenLineage: false` in the latter case would make the swallowed recorder
   * failure indistinguishable from a proved negative on the next read.
   */
  it('should refuse a damaged indexed parent instead of excluding it from spawn ancestry', async () => {
    // Arrange
    const home = await tempDirectory('fyd-spawn-ancestry-damaged');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    const reviver = new RecordingResumeLauncher();
    const at = '2026-08-06T10:00:00.000Z';
    const parentId = 'wire-warden-parent';
    const legacyChildId = 'wire-legacy-child';
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
      createResumeLauncher: () => reviver,
    };
    await seedFleet(home);
    await seedSession(home, at, parentId);
    await seedSession(home, at, legacyChildId, { status: 'stopped' });
    // These two records predate spawn stamping: the parent is recognisable as a warden by its label,
    // and the child still needs its first relaunch stamp. Written through storage so both ids are in
    // the authoritative index before the daemon opens it.
    process.env.FY_HOME = home;
    const seeded = await buildWorld({}, { userHome: ABSENT_USER_HOME }).storage.open();
    const parentConfig = SessionConfigSchema.parse(await seeded.storage.readConfig(parseSessionId(parentId)));
    const childConfig = SessionConfigSchema.parse(await seeded.storage.readConfig(parseSessionId(legacyChildId)));
    await seeded.storage.writeConfig(parseSessionId(parentId), { ...parentConfig, label: 'fleet-warden' });
    await seeded.storage.writeConfig(parseSessionId(legacyChildId), { ...childConfig, parent: parentId });
    await seeded.storage.close();
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-ferretry-client': 'cli',
    };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const parentFile = join(home, 'state', 'sessions', parentId, 'config.json');
    const readableParent = SessionConfigSchema.parse(JSON.parse(await readFile(parentFile, 'utf8')));
    // Corrupt the record AFTER boot, so the index still authoritatively names it while the public
    // list's intentional safeParse filtering omits it.
    await writeFile(
      parentFile,
      JSON.stringify({
        ...readableParent,
        provenance: {
          v: 1,
          at,
          origin: 'warden',
          wardenLineage: true,
          lineageSource: 'none',
        },
      }),
      { mode: 0o600 },
    );

    // Act
    const listedBefore = SessionListSchema.parse(await (await fetch(sessions, { headers })).json());
    const refused = await fetch(sessions, {
      method: 'POST',
      headers: { ...headers, 'x-fy-request-id': 'req-damaged-ancestry-1' },
      body: JSON.stringify({
        agent: WRAPPER,
        mode: 'auto',
        prompt: 'must not launch without ancestry',
        parent: parentId,
        cwd: home,
      }),
    });
    const refusedBody = (await refused.json()) as { code: string };
    const relaunched = await fetch(`${sessions}/${legacyChildId}/resume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'resume without weakening the shield' }),
    });
    const relaunchedBody = SessionViewSchema.parse(await relaunched.json());
    const listedAfter = SessionListSchema.parse(await (await fetch(sessions, { headers })).json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // This omission is the mounted list's documented availability policy and the reason ancestry
    // must enumerate the index separately. The valid legacy child remains visible beside the hole.
    should(listedBefore.map(session => session.config.id)).deepEqual([legacyChildId]);
    // The ordinary start read every indexed ancestor and failed before it claimed a pane. Under the
    // old list-based snapshot this returned 201 with `wardenLineage: false`.
    should(refused.status).equal(500);
    should(refusedBody.code).equal('internal_error');
    should(launcher.launched).have.length(0);
    // The relaunch itself already happened and therefore remains successful. Its recorder hit the
    // same strict snapshot, was swallowed at the documented recovery boundary, and wrote no false
    // negative over the legacy absence.
    should(relaunched.status).equal(200);
    should(reviver.relaunched).deepEqual([legacyChildId]);
    should(relaunchedBody.config.provenance).be.undefined();
    should(listedAfter.map(session => session.config.id)).deepEqual([legacyChildId]);
    should(listedAfter[0]?.config.provenance).be.undefined();
  });

  /**
   * A damaged callsign ledger must NOT leak its absolute path, and must read as the unavailable
   * condition it is rather than a launch defect.
   *
   * The reservation file is the only proof an in-flight start owns its name, so the store fails closed
   * over a damaged one. That refusal used to surface as `500 session_launch_failed` carrying the
   * adapter's verbatim error — ledger path and all — in the body. It is now a stable `503
   * callsign_unavailable` with a fixed, path-free message: the caller may retry once the store is
   * mended, and no agent on the host learns where the daemon keeps its state.
   */
  it('should answer a path-free 503 for a start over a damaged callsign ledger', async () => {
    // Arrange
    const home = await tempDirectory('fyd-callsign-damaged');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
    };
    await seedFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    // Corrupt the reservation ledger AFTER boot: a missing file is an empty ledger, so the damage must
    // be real bytes the decoder refuses.
    const ledger = join(home, 'state', 'callsigns.json');
    await mkdir(join(home, 'state'), { recursive: true });
    const damaged = 'not json at all';
    await writeFile(ledger, damaged, { mode: 0o600 });

    // Act — a start that asks for a callsign must claim it before launch, and the claim reads this file.
    const refused = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': 'req-callsign-1' },
      body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'claim a name', teammate: 'atlas', cwd: home }),
    });
    const body = (await refused.json()) as { code: string; error: string };
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(refused.status).equal(503);
    should(body.code).equal('callsign_unavailable');
    // The message is the allocator's fixed, path-free string; the whole body omits the temp home the
    // ledger path would have exposed.
    should(body.error).equal('callsign persistence failed');
    should(JSON.stringify(body)).not.containEql(home);
    // Nothing launched — the start failed at the claim, before the pane.
    should(launcher.launched).have.length(0);
    // And the damaged evidence is left untouched for diagnosis.
    should(await readFile(ledger, 'utf8')).equal(damaged);
  });

  /**
   * `fy start --board-access worker`, driven end to end through the production composition root.
   *
   * The start refused this with `501` on the belief that it "would launch a pane holding a capability
   * that authorizes nothing until a third party acts". It hands the pane no capability at all: a child
   * grant is a PENDING INTENT by construction, so the state the refusal was avoiding is the only state
   * the domain can produce, and refusing it meant the flag could not be used.
   *
   * This proves the grant DOES ITS JOB rather than merely being reachable: a real board is created over
   * two real sessions, the creator's capability is read from the file the daemon actually delivered it
   * to, and the intent the start produced is read back out of `task-boards.json` on disk.
   *
   * It also pins the ORDERING, which is the part a unit test cannot see. The grant is requested after
   * the session record exists — the board's directory reads the session's own documents — and before
   * the launch, so a refusal costs no agent: the refused start's session is `stopped` and the launcher
   * never saw it.
   */
  it('should request a child grant for a start that asked for board access', async () => {
    // Arrange
    const home = await tempDirectory('fyd-board-access-start');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
    };
    await seedFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startSession = async (
      requestId: string,
      fields: Readonly<Record<string, unknown>>,
      extra: Readonly<Record<string, string>> = {},
    ): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId, ...extra },
        body: JSON.stringify({ agent: WRAPPER, cwd: home, prompt: 'work the board', ...fields }),
      });

    // Act
    // The membership ROOT: live, interactive and top-level, which is the only shape the domain lets
    // request a child grant.
    const root = SessionViewSchema.parse(await (await startSession('req-board-root', { mode: 'interactive' })).json());
    const coordinator = SessionViewSchema.parse(
      await (await startSession('req-board-coordinator', { mode: 'auto', parent: root.config.id })).json(),
    );
    // The operator's capability is minted LAZILY, on the first request that has to check one — the
    // same shape as the API token, which the first authenticated request mints. So this is the
    // operator's real first move: try, be refused, then read what `fyd` issued.
    const createBoard = async (adminCapability: string): Promise<Response> =>
      await fetch(`http://127.0.0.1:${port}/v1/task-boards/create`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-board-admin-capability': adminCapability },
        body: JSON.stringify({ creatorSessionId: root.config.id, coordinatorSessionId: coordinator.config.id }),
      });
    const beforeMint = await createBoard('not-the-operator');
    const adminCapability = (await readFile(join(home, 'board-admin-capability'), 'utf8')).trim();
    const created = await createBoard(adminCapability);
    // The root's own board capability, read from the file the daemon delivered it to rather than from
    // the response — the response never carries one, which is the point of the environment channel.
    const rootEnvironment = JSON.parse(
      await readFile(join(home, 'state', 'sessions', root.config.id, 'environment.json'), 'utf8'),
    ) as Readonly<Record<string, string>>;
    const rootCapability = rootEnvironment.FY_BOARD_CAPABILITY ?? '';
    const launchesBeforeRefusals = launcher.launched.length;
    // The start under test.
    const granted = await startSession(
      'req-board-child',
      { mode: 'auto', parent: root.config.id, boardAccess: 'worker' },
      { 'x-fy-board-capability': rootCapability },
    );
    const grantedBody = SessionViewSchema.parse(await granted.json());
    const boardDocument = JSON.parse(await readFile(join(home, 'task-boards.json'), 'utf8')) as {
      readonly boards: ReadonlyArray<{
        readonly childGrantIntents: ReadonlyArray<{
          readonly targetSessionId: string;
          readonly requestedRole: string;
          readonly status: string;
        }>;
      }>;
    };
    // No capability at all, and a capability that names no membership: the two refusals a caller can
    // actually produce.
    const noCapability = await startSession('req-board-bare', {
      mode: 'auto',
      parent: root.config.id,
      boardAccess: 'worker',
    });
    const refused = await startSession(
      'req-board-stranger',
      { mode: 'auto', parent: root.config.id, boardAccess: 'worker' },
      { 'x-fy-board-capability': 'not-anybody-s-capability' },
    );
    const listed = SessionListSchema.parse(await (await fetch(sessions, { headers })).json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(beforeMint.status).equal(403);
    should(created.status).equal(201);
    should(rootCapability).not.be.empty();
    // The start was SERVED, where it used to answer 501.
    should(granted.status).equal(201);
    // And the document it wrote records what the caller asked for. Recording `none` here would make
    // every surface reading this session disagree with the intent the board is holding for it.
    should(grantedBody.config.boardAccess).equal('worker');
    // The intent is real, durable and PENDING — which is the only status the request reducer produces,
    // for any requester, coordinator included.
    should(
      boardDocument.boards
        .flatMap(board => board.childGrantIntents)
        .map(intent => [intent.targetSessionId, intent.requestedRole, intent.status]),
    ).deepEqual([[grantedBody.config.id, 'worker', 'pending']]);
    // A missing secret is reported the way the eight board routes report one.
    should(noCapability.status).equal(401);
    should((await noCapability.json()) as { code: string }).have.property('code', 'missing_capability');
    // A capability naming no membership is the board's own refusal, in the board's own vocabulary
    // rather than flattened into `session_launch_failed`.
    should(refused.status).equal(403);
    should((await refused.json()) as { code: string }).have.property('code', 'forbidden');
    // NEITHER refusal cost an agent: the grant is requested before the launch, so the only session the
    // two refusals left behind is the stranger's, and it is stopped rather than running.
    should(launcher.launched).have.length(launchesBeforeRefusals + 1);
    const refusedSessions = listed.filter(session => session.config.boardAccess === 'worker');
    should(refusedSessions.map(session => session.state.status).sort()).deepEqual(['running', 'stopped']);
    should(refusedSessions.find(session => session.state.status === 'stopped')?.state.reason).containEql(
      'board access refused',
    );
  });

  /**
   * The files an opening message attached, driven through the production composition root.
   *
   * `initialAttachments` was refused with `501` for four units on the belief that attachments need a
   * multipart route the daemon does not have. They do not: the bytes are INLINE in this very start
   * body, and the only place they are spent is the turn-one document the same start writes. This
   * proves the extractor DOES ITS JOB rather than merely being reachable — the DOCX is a real OOXML
   * archive, the text comes out of `word/document.xml` through the production inflater, and the
   * agent is pointed at both files by absolute path.
   */
  it('should store the files an opening message attached and name them in turn one', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-attachments');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
    };
    await seedFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const post = async (requestId: string, body: Readonly<Record<string, unknown>>): Promise<Response> =>
      await fetch(sessions, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': requestId },
        body: JSON.stringify(body),
      });

    // Act
    const started = await post('req-attach-1', {
      agent: WRAPPER,
      mode: 'auto',
      prompt: 'summarize the attached brief',
      cwd: home,
      initialAttachments: [
        { filename: 'brief.docx', base64: Buffer.from(docxBytes('the brief in a real docx')).toString('base64') },
        { filename: 'diagram.png', mime: 'image/png', base64: Buffer.from([1, 2, 3]).toString('base64') },
      ],
    });
    const startedBody = SessionViewSchema.parse(await started.json());
    const directory = join(home, 'state', 'sessions', startedBody.config.id);
    const turnOne = await readFile(join(directory, 'turns', 'turn-001.md'), 'utf8');
    const extracted = await readFile(join(directory, 'attachments', 'brief.docx.txt'), 'utf8');
    const storedFiles = (await readdir(join(directory, 'attachments'))).sort();
    // A file with nothing to attach it to: the CLI refuses the same combination on `fy send`.
    const bare = await post('req-attach-2', {
      agent: WRAPPER,
      mode: 'interactive',
      cwd: home,
      initialAttachments: [{ filename: 'brief.docx', base64: 'QUJD' }],
    });
    // A filename that names no file is the caller's mistake, named as one rather than turned into a
    // directory the attachment would be written outside of.
    const unnamed = await post('req-attach-3', {
      agent: WRAPPER,
      mode: 'auto',
      prompt: 'summarize this',
      cwd: home,
      initialAttachments: [{ filename: '..', base64: 'QUJD' }],
    });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(started.status).equal(201);
    // The opening message the agent is handed names both files, and the extracted text beside one.
    should(turnOne).containEql('summarize the attached brief');
    should(turnOne).containEql(join(directory, 'attachments', 'brief.docx'));
    should(turnOne).containEql(join(directory, 'attachments', 'diagram.png'));
    should(turnOne).containEql(`extracted text: ${join(directory, 'attachments', 'brief.docx.txt')}`);
    // And the words really came out of the archive: this is the capability the four allowlist lines
    // were holding, proved end to end rather than asserted.
    should(extracted).equal('the brief in a real docx');
    should(storedFiles).deepEqual(['brief.docx', 'brief.docx.txt', 'diagram.png']);
    // The agent was pointed at the turn document, which is what carries the paths.
    should(launcher.delivered[0]).containEql('turns/turn-001.md');
    should(bare.status).equal(400);
    should((await bare.json()) as { code: string }).have.property('code', 'invalid_request');
    should(unnamed.status).equal(400);
    should((await unnamed.json()) as { code: string }).have.property('code', 'invalid_request');
  });

  /**
   * Reviving a session, driven through the production composition root over a real socket.
   *
   * This proves the revive DOES ITS JOB rather than merely being constructed, and it needs a session
   * only the mounted start can produce: the resume launcher relaunches the terminal named in that
   * session's own configuration document, and it reads the command out of the argv the start recorded.
   *
   * All three branches the domain plans are driven against ONE real state home, because they differ
   * only in what the pane is doing:
   *
   *   * A LIVE pane and a message is a SEND — the message is typed into the running agent rather than
   *     its terminal being replaced, and the daemon's own turn counter does not move, because nothing
   *     observed an answer.
   *   * A LIVE pane and NO message is a refusal: there is nothing to hand a running agent.
   *   * A GONE pane is a relaunch: the turn counter moves, a numbered turn document is written into
   *     the session's own private directory, and the agent is pointed at that file.
   */
  it('should send into a live session, refuse an empty revive, and relaunch a stopped one', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-resume');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    const reviver = new RecordingResumeLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
      createResumeLauncher: () => reviver,
    };
    await seedFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const cli = { ...headers, 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startResponse = await fetch(sessions, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-resume-1' },
      body: JSON.stringify({
        agent: WRAPPER,
        mode: 'auto',
        prompt: 'wire the revive',
        name: 'Wire Session Revive',
        cwd: home,
      }),
    });
    // Parsed rather than cast, so a start that failed fails HERE with the daemon's own reason instead
    // of surfacing as an unrelated assertion about a session that was never created.
    const started = SessionViewSchema.parse(await startResponse.json());
    const id = started.config.id;
    const resume = async (body: unknown): Promise<Response> =>
      await fetch(`${sessions}/${id}/resume`, { method: 'POST', headers: cli, body: JSON.stringify(body) });

    // Act
    // A live harness at a prompt: the revive types into it rather than replacing it.
    reviver.pane = { alive: true, dead: false, promptReady: true };
    const sent = await resume({ message: 'keep going, the gate is green' });
    const sentBody = SessionViewSchema.parse(await sent.json());
    // Counted here rather than at the end, because a relaunch follows and is meant to.
    const relaunchesAfterSend = reviver.relaunched.length;
    const emptyIntoLive = await resume({});
    // The session ends, and its pane goes with it.
    const stopped = await fetch(`${sessions}/${id}/stop`, {
      method: 'POST',
      headers: cli,
      body: JSON.stringify({ reason: 'the turn finished' }),
    });
    reviver.pane = { alive: false, dead: false, promptReady: false };
    const revived = await resume({ message: 'pick the migration back up' });
    const revivedBody = SessionViewSchema.parse(await revived.json());
    // Both turn documents, in the session's own private directory: the assignment the start handed
    // over, and the one the revive did.
    const turnDirectory = join(home, 'state', 'sessions', id, 'turns');
    const turns = (await readdir(turnDirectory)).sort();
    const turnOne = await readFile(join(turnDirectory, 'turn-001.md'), 'utf8');
    const turnTwo = await readFile(join(turnDirectory, 'turn-002.md'), 'utf8');
    // The same revive over the WARDEN token, which must not be able to relaunch an agent.
    const wardenToken = (await readFile(join(home, 'api-warden-token'), 'utf8')).trim();
    const asWarden = await fetch(`${sessions}/${id}/resume`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wardenToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'a warden should not reach this' }),
    });
    const absent = await fetch(`${sessions}/no-such-session/resume`, { method: 'POST', headers: cli, body: '{}' });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // A live pane was SENT into: the instruction is the message itself, not a turn-file pointer, and
    // no relaunch happened at all.
    should(sent.status).equal(200);
    should(reviver.delivered[0]).equal('keep going, the gate is green');
    should(relaunchesAfterSend).equal(0);
    // The daemon's turn counter did not move, because a send is not a turn the daemon wrote.
    should(sentBody.state.turn).equal(started.state.turn);
    // Nothing to hand a running agent is a stated refusal, not a silent no-op that reports success.
    should(emptyIntoLive.status).equal(409);
    should((await emptyIntoLive.json()) as { code: string }).have.property('code', 'resume_refused');
    should(stopped.status).equal(200);
    // The stopped session came back: a real relaunch of the terminal its own document names.
    should(revived.status).equal(200);
    should(reviver.relaunched).deepEqual([id]);
    should(revivedBody.state.status).equal('running');
    // The counter moved for the relaunch, because THIS turn is one the daemon itself wrote.
    should(revivedBody.state.turn).equal(started.state.turn + 1);
    // And it wrote it where the agent was pointed: the instruction names the very file on disk.
    should(reviver.delivered.at(-1)).containEql('turns/turn-002.md');
    should(turnTwo).containEql('pick the migration back up');
    // The NEW document, beside the original — not over it. A start records which turn it handed over
    // precisely so a revive numbers the next one rather than overwriting the session's own assignment.
    should(turns).deepEqual(['turn-001.md', 'turn-002.md']);
    should(turnOne).containEql('wire the revive');
    // The revive merged over the document rather than replacing it: the protocol half survived a
    // transition that knows nothing about it.
    should(revivedBody.config.agent).equal(WRAPPER);
    should(revivedBody.config.name).equal('Wire Session Revive');
    // `admin` scope, matching the start and the stop: a revive relaunches a process holding the
    // daemon's own privileges, so the warden token is refused rather than served.
    should(asWarden.status).equal(403);
    should(absent.status).equal(404);
    should((await absent.json()) as { code: string }).have.property('code', 'not-found');
  });

  /**
   * ONE TEAMMATE TALKING TO ANOTHER, attributed, through the production composition root.
   *
   * THE CHAIN THIS CLOSES. `FY_SESSION_ID` appeared nowhere in this daemon, so the third link of a
   * four-link chain was missing and the whole feature was dead:
   *
   *   1. the launcher exports the pane's own id as `FY_SESSION_ID` — proved against real `new-session`
   *      arguments in `tests/integration/session/lifecycle/storage-and-tmux.test.ts`;
   *   2. the CLI reads it and sends it as `x-ferretry-session-id` (`resolveConnection`, CLI suite);
   *   3. the authorization boundary turns that header into `peer:<id>` and the send mount takes `from`
   *      from THAT and never from the body — this case;
   *   4. the send domain attributes the message and ends the recipient's park on it.
   *
   * Only the value in step 1 is what step 3 reads back, and it is the session's own id — so the header
   * here carries exactly what a real pane would have in its environment. Before this, every peer
   * message was anonymous: the receiving agent was told nothing about who was talking to it, and no
   * `--peer` park could ever end.
   *
   * THE CONTROL MATTERS AS MUCH AS THE CASE. The same send with no session header must journal NO
   * `from`, because that is the bug's own signature — an attribution that appears whatever the caller
   * presents would prove nothing about where it came from.
   */
  it('should attribute a peer send to the sending session, and only when it identifies itself', async () => {
    // Arrange
    const home = await tempDirectory('fyd-peer-send');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    const reviver = new RecordingResumeLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
      createResumeLauncher: () => reviver,
    };
    await seedFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const cli = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-ferretry-client': 'cli',
    };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startSession = async (name: string, requestId: string): Promise<SessionView> => {
      const response = await fetch(sessions, {
        method: 'POST',
        headers: { ...cli, 'x-fy-request-id': requestId },
        body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: `work on ${name}`, name, cwd: home }),
      });
      const raw: unknown = await response.json();
      if (response.status !== 201) throw new Error(`the fixture start failed: ${JSON.stringify(raw)}`);
      return SessionViewSchema.parse(raw);
    };
    // Two real sessions, because attribution is a fact about a pair: the sender must be a session the
    // daemon can resolve, or the reference degrades to an unattributed send.
    const sender = await startSession('Peer Sender', 'req-peer-sender');
    const recipient = await startSession('Peer Recipient', 'req-peer-recipient');
    const journalOf = async (id: string): Promise<Array<Record<string, unknown>>> =>
      (await readFile(join(home, 'state', 'sessions', id, 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>);
    const send = async (headers: Readonly<Record<string, string>>, message: string, requestId: string) =>
      await fetch(`${sessions}/${recipient.config.id}/send`, {
        method: 'POST',
        headers: { ...cli, ...headers, 'x-fy-request-id': requestId },
        body: JSON.stringify({ message }),
      });

    // Act
    // A live harness at a prompt, so the message is handed to the agent rather than queued.
    reviver.pane = { alive: true, dead: false, promptReady: true };
    // THE HEADER VALUE IS TAKEN FROM THE PRODUCTION PANE ENVIRONMENT, not written as a literal: this is
    // the same function the launcher hands to `tmux -e`, so the two halves of the chain meet on one
    // value rather than on two spellings of it. A pane launched with no identity — the state this unit
    // found the daemon in — presents nothing here, and every assertion about `from` below fails.
    const paneEnvironment = sessionPaneEnvironment(parseSessionId(sender.config.id), {}, 'auto');
    const attributed = await send(
      { 'x-ferretry-session-id': paneEnvironment[SESSION_ID_VARIABLE] ?? '' },
      'the gate is green, pick up the migration',
      'req-peer-send-1',
    );
    const attributedBody: unknown = await attributed.json();
    const afterAttributed = await journalOf(recipient.config.id);
    const delivered = reviver.delivered.at(-1);
    const outbox = await readFile(
      join(home, 'state', 'sessions', sender.config.id, 'channel', 'outbox.jsonl'),
      'utf8',
    ).catch(() => undefined);
    const inbox = await readFile(
      join(home, 'state', 'sessions', recipient.config.id, 'channel', 'inbox.jsonl'),
      'utf8',
    );
    // The control: the human's own CLI, holding the same admin token and naming no pane.
    const anonymous = await send({}, 'and this one is from the human', 'req-peer-send-2');
    const afterAnonymous = await journalOf(recipient.config.id);
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(attributed.status).equal(200);
    should(SendResultSchema.parse(attributedBody).config.id).equal(recipient.config.id);
    // THE JOURNAL NAMES THE SENDER. `from` is the server's own resolution of the peer actor — the
    // route reads it off `peer:<id>` and refuses to read it from the body — so this row is the proof
    // that an in-pane caller can identify itself at all.
    const accepted = afterAttributed.filter(entry => entry.type === 'control.send_accepted');
    should(accepted).have.length(1);
    should(accepted[0]?.data).match({ from: sender.config.id });
    // The receiving agent is TOLD who is talking to it, in the payload it actually reads. An
    // unattributed peer message is one an agent cannot reply to.
    should(delivered).containEql(`session ${sender.config.id}`);
    should(delivered).containEql('not from the owner');
    // Both halves of the conversation are durable: the recipient's inbox and the sender's own outbox.
    should(inbox).containEql(`"from":"${sender.config.id}"`);
    should(outbox).containEql(`"to":"${recipient.config.id}"`);
    // AND THE CONTROL: the human's send is journalled with no sender at all. Attribution comes from
    // the credential and the pane header, so a caller that names no pane is not given one.
    const anonymousAccepted = afterAnonymous
      .filter(entry => entry.type === 'control.send_accepted')
      .filter(entry => (entry.data as Record<string, unknown>).sendId === 'req-peer-send-2');
    should(anonymous.status).equal(200);
    should(anonymousAccepted).have.length(1);
    should(anonymousAccepted[0]?.data).not.have.property('from');
  });

  /**
   * Migrating a session onto another account, driven through the production composition root.
   *
   * This proves the destructive-migration SAFETY GATE does its job rather than merely being
   * constructed: `MigrationPreflight` was built, tested and assigned to a world field that nothing
   * ever called, so `POST /v1/sessions/:id/migrate` — a route the protocol client has always spoken —
   * answered `unknown_route`, and the one gate in the product that refuses to destroy work guarded an
   * operation the product could not perform.
   *
   * THE GATE ITSELF IS REAL HERE. Only its two host probes are doubled — the process-table walk and
   * the pane capture, which cannot be driven without running the very work they inspect — so the
   * verdicts, the blind-spot rules, the refusal, the report and the handoff are production's.
   *
   * The order of the calls is the argument:
   *
   *   * AN ACCOUNT OF THE WRONG HARNESS FAMILY is refused first of all, and nothing is even inspected.
   *     The CLI has always called this operation same-kind while the daemon compared nothing, so a
   *     claude session could be migrated onto a codex account: same id, same journal, same open tool
   *     ids, and a harness that can read none of them. The account named here is published, available
   *     and runnable — it is refused for what it is.
   *   * A SMALLER CONTEXT WINDOW is refused before anything is inspected, because a migration that
   *     truncates the conversation it exists to preserve is not one the caller asked for.
   *   * A DESTRUCTIVE process in the pane is refused with the inventory in the message, and nothing
   *     is written: no report, and a configuration document still naming the account it started on.
   *   * A CLEAN pane migrates: the document is restamped, the LIVE pane is replaced rather than typed
   *     into, and the replacement agent is handed a turn document pointing at the report.
   *   * AN AGENT THE FLEET DOES NOT PUBLISH is a 404 about the agent, not about the session.
   */
  it('should refuse an unsafe migration and move a session the gate clears', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-migrate');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    const reviver = new RecordingResumeLauncher();
    const inventory = new StubProcessInventory();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
      createResumeLauncher: () => reviver,
      // The REAL gate over doubled host probes: everything it decides is production's.
      migratePreflight: new MigrationPreflight(inventory, { visible: async () => undefined }),
    };
    await seedMigrationFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const cli = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startResponse = await fetch(sessions, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-migrate-1' },
      body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'wire the migration', cwd: home }),
    });
    // Answered rather than cast, so a start that failed fails HERE with the daemon's own reason
    // instead of surfacing as an unrelated assertion about a session that was never created.
    const startedRaw: unknown = await startResponse.json();
    if (startResponse.status !== 201) throw new Error(`the fixture start failed: ${JSON.stringify(startedRaw)}`);
    const started = SessionViewSchema.parse(startedRaw);
    const id = started.config.id;
    const configFile = join(home, 'state', 'sessions', id, 'config.json');
    const reportFile = join(home, 'state', 'sessions', id, 'migration-inflight.md');
    // Each ask carries its OWN request id, because each is a different question put to a world that
    // has changed since the last one. Reusing an id is how the route recognises a retried POST, and a
    // retry is exactly what these are not.
    const migrate = async (body: unknown, requestId: string): Promise<Response> =>
      await fetch(`${sessions}/${id}/migrate`, {
        method: 'POST',
        headers: { ...cli, 'x-fy-request-id': requestId },
        body: JSON.stringify(body),
      });
    const storedConfig = async (): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;

    // Act
    // The pane is alive and at a prompt throughout: a migration must replace it anyway.
    reviver.pane = { alive: true, dead: false, promptReady: true };
    // A CODEX ACCOUNT, for a claude session. Published, available, runnable — and not this session's
    // family, which is the whole of the refusal. `allowContextDowngrade` is set so the refusal cannot
    // be the window's; the ordering assertions below are what prove nothing was touched.
    const crossFamily = await migrate(
      { agent: CROSS_FAMILY_WRAPPER, allowContextDowngrade: true },
      'req-migrate-cross-1',
    );
    const crossFamilyBody = (await crossFamily.json()) as { error: string; code: string };
    const afterCrossFamily = await storedConfig();
    // Counted here: everything below is meant to inspect the pane, and this refusal must not have.
    const collectionsAfterCrossFamily = inventory.collections;
    const reportAfterCrossFamily = await readFile(reportFile, 'utf8').catch(() => undefined);
    const relaunchesAfterCrossFamily = reviver.relaunched.length;
    const snapshotsAfterCrossFamily = reviver.snapshots.length;
    // The same refusal presented again under the SAME request id, corrected to a same-family account.
    // A pre-destruction refusal spends no receipt, so this must be evaluated afresh rather than
    // answered from the ledger — the caller's remedy is to fix the account, not to mint a new id.
    const correctedUnderSameId = await migrate(
      { agent: TARGET_WRAPPER, allowContextDowngrade: true },
      'req-migrate-cross-1',
    );
    const correctedBody = (await correctedUnderSameId.json()) as { error: string; code: string };
    // The session is `running` and its pane holds nothing: an agent mid-turn is work this gate will
    // not interrupt, and it says so rather than moving a session out from under a thinking agent.
    const midTurn = await migrate({ agent: TARGET_WRAPPER, allowContextDowngrade: true }, 'req-migrate-ask-1');
    const midTurnBody = (await midTurn.json()) as { error: string; code: string };
    const afterMidTurn = await storedConfig();
    // The account runs out of quota. Nothing mounted produces this status — the quota reader that
    // would is not mounted — so the state document is seeded directly, which is the whole reason a
    // migration exists: an operator moves a rate-limited session onto an account with headroom.
    const stateFile = join(home, 'state', 'sessions', id, 'state.json');
    await writeFile(
      stateFile,
      JSON.stringify({ ...(JSON.parse(await readFile(stateFile, 'utf8')) as object), status: 'rate_limited' }),
      { mode: 0o600 },
    );
    // The target serves a 200k window and this session was started on a 1M model.
    const downgrade = await migrate({ agent: TARGET_WRAPPER }, 'req-migrate-ask-2');
    const afterDowngrade = await storedConfig();
    // A destructive command in the pane, which the gate must refuse to interrupt.
    inventory.observation = {
      kind: 'observed',
      processes: [{ pid: 4242, argv: 'git push origin main', verdict: 'destructive_to_interrupt' }],
    };
    const refused = await migrate({ agent: TARGET_WRAPPER, allowContextDowngrade: true }, 'req-migrate-ask-3');
    const refusedBody = (await refused.json()) as { error: string; code: string };
    const afterRefusal = await storedConfig();
    const reportAfterRefusal = await readFile(reportFile, 'utf8').catch(() => undefined);
    // The command finished; nothing is in flight.
    inventory.observation = { kind: 'observed', processes: [] };
    // THE SESSION HAS A TOOL OPEN, AND ITS TRANSCRIPT SAYS WHAT IT IS. Before a session recorded its
    // transcript this joined to nothing and the open id was classified `unknown`, which this gate
    // refuses on — so seeding an open tool here would have made the migration below impossible. The
    // provenance record names a real file, the file says the tool is a `Read`, and a `Read` is
    // `safe_to_kill`. That is `world.transcripts` deciding the outcome of a mounted operation.
    const harnessHome = join(home, 'harness');
    const transcriptFile = join(harnessHome, 'projects', 'seeded', 'session.jsonl');
    await mkdir(join(harnessHome, 'projects', 'seeded'), { recursive: true });
    await writeFile(
      transcriptFile,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'record-open-tool',
        timestamp: '2026-07-31T23:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-open-1', name: 'Read', input: { file_path: '/work/open.ts' } }],
        },
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      configFile,
      JSON.stringify({
        ...(await storedConfig()),
        transcript: {
          v: 1,
          home: harnessHome,
          harnessSessionId: 'seeded-harness-session',
          identity: 'minted',
          file: transcriptFile,
          resolvedAt: '2026-07-31T22:00:00.000Z',
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      stateFile,
      JSON.stringify({ ...(JSON.parse(await readFile(stateFile, 'utf8')) as object), openTools: ['tool-open-1'] }),
      { mode: 0o600 },
    );
    const moved = await migrate({ agent: TARGET_WRAPPER, allowContextDowngrade: true }, 'req-migrate-ask-4');
    const movedRaw: unknown = await moved.json();
    // Same reason: a refused migration must fail with the refusal it answered, not with a schema
    // complaint about an error envelope.
    if (moved.status !== 200) throw new Error(`the cleared migration was refused: ${JSON.stringify(movedRaw)}`);
    const movedBody = SessionViewSchema.parse(movedRaw);
    const afterMove = await storedConfig();
    const seededTranscript = await readFile(transcriptFile, 'utf8');
    const carriedTranscript = await readFile(
      String((afterMove.transcript as { file?: string } | undefined)?.file),
      'utf8',
    );
    const report = await readFile(reportFile, 'utf8');
    const turnTwo = await readFile(join(home, 'state', 'sessions', id, 'turns', 'turn-002.md'), 'utf8');
    // The replacement runs out of quota too. Seeded the same way and for the same reason: a migrated
    // session comes back `running`, and an agent mid-turn is not one this gate interrupts. The open
    // tool goes with it: the pane was REPLACED, so the previous harness's tool ids are stale.
    await writeFile(
      stateFile,
      JSON.stringify({
        ...(JSON.parse(await readFile(stateFile, 'utf8')) as object),
        status: 'rate_limited',
        openTools: [],
      }),
      { mode: 0o600 },
    );
    // Straight back again, which is the case that used to destroy work: the turn a revive hands over
    // is recorded on the STATE document, and reading the configuration's frozen copy first made every
    // second relaunch write `turn-002.md` a second time — over an assignment the agent may not have
    // read yet.
    const movedBack = await migrate({ agent: WRAPPER }, 'req-migrate-back');
    const turnsAfterSecond = (await readdir(join(home, 'state', 'sessions', id, 'turns'))).sort();
    const secondReport = await readFile(reportFile, 'utf8');
    // RESTART ANYWAY. The session is back on its original account and rate-limited again, and a
    // process the gate cannot classify is in the pane. Without the flag the refusal says so as data;
    // with it, a person who confirmed gets the move — journalled, and marked FORCED in the report.
    await writeFile(
      stateFile,
      JSON.stringify({ ...(JSON.parse(await readFile(stateFile, 'utf8')) as object), status: 'rate_limited' }),
      { mode: 0o600 },
    );
    inventory.observation = {
      kind: 'observed',
      processes: [
        { pid: 5151, argv: 'some-vendor-tool --watch', startedSecondsAgo: 86_400, verdict: 'unknown' },
        {
          pid: 5152,
          argv: 'fy mcp serve',
          startedSecondsAgo: 86_400,
          verdict: 'safe_to_kill',
          known: { kind: 'ferretry-tools', label: 'The Ferretry tools server' },
        },
      ],
    };
    const unforced = await migrate({ agent: TARGET_WRAPPER, allowContextDowngrade: true }, 'req-migrate-anyway-1');
    const unforcedBody: unknown = await unforced.json();
    const forced = await migrate(
      { agent: TARGET_WRAPPER, allowContextDowngrade: true, forceInflight: true },
      'req-migrate-anyway-2',
    );
    const forcedRaw: unknown = await forced.json();
    const forcedReport = await readFile(reportFile, 'utf8');
    const forcedJournal = await readFile(join(home, 'state', 'sessions', id, 'events.jsonl'), 'utf8');
    // RESTART IS NEVER A DOWNGRADE (the owner's second refusal). The session is on the 200k target and its
    // harness reports a million-token window — the shape a stale or incomplete catalog produces. Restart asks
    // for no new model on the same account, so it relaunches into the window it already has instead of being
    // refused as a downgrade it cannot accept.
    await writeFile(
      stateFile,
      JSON.stringify({
        ...(JSON.parse(await readFile(stateFile, 'utf8')) as object),
        status: 'rate_limited',
        contextWindow: 1_000_000,
      }),
      { mode: 0o600 },
    );
    inventory.observation = { kind: 'observed', processes: [] };
    const restartInPlace = await migrate({ agent: TARGET_WRAPPER }, 'req-restart-in-place');
    const restartInPlaceRaw: unknown = await restartInPlace.json();
    // THE OTHER DIRECTION, which is a different session rather than a different request: a codex
    // session asked to move onto a claude account. Both crossings were permitted before, and they fail
    // differently — a claude transcript is unreadable to codex and a codex rollout is unreadable to
    // claude — so neither is proved by the other.
    const codexStart = await fetch(sessions, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-migrate-codex-start' },
      body: JSON.stringify({ agent: CROSS_FAMILY_WRAPPER, mode: 'auto', prompt: 'run on codex', cwd: home }),
    });
    const codexRaw: unknown = await codexStart.json();
    if (codexStart.status !== 201) throw new Error(`the codex fixture start failed: ${JSON.stringify(codexRaw)}`);
    const codexId = SessionViewSchema.parse(codexRaw).config.id;
    const codexToClaude = await fetch(`${sessions}/${codexId}/migrate`, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-migrate-cross-2' },
      body: JSON.stringify({ agent: TARGET_WRAPPER, allowContextDowngrade: true }),
    });
    const codexToClaudeBody = (await codexToClaude.json()) as { error: string; code: string };
    const codexConfigAfter = JSON.parse(
      await readFile(join(home, 'state', 'sessions', codexId, 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    const unknownAgent = await migrate(
      { agent: 'claude-auto-nowhere', allowContextDowngrade: true },
      'req-migrate-unknown',
    );
    const absent = await fetch(`${sessions}/no-such-session/migrate`, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-migrate-absent' },
      body: JSON.stringify({ agent: TARGET_WRAPPER }),
    });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // A CROSS-FAMILY TARGET IS REFUSED, and the refusal says which families it is refusing between so
    // the operator knows what to name instead.
    should(crossFamily.status).equal(409);
    should(crossFamilyBody.code).equal('harness_mismatch');
    should(crossFamilyBody.error).containEql('runs the claude harness');
    should(crossFamilyBody.error).containEql(`${CROSS_FAMILY_WRAPPER} is a codex account`);
    // AND IT IS REFUSED BEFORE ANYTHING DESTRUCTIVE, which these four facts are the whole of: the
    // pane was never walked, no report was written, the pane was neither snapshotted nor replaced, and
    // the configuration document still names the account the session started on. Every destructive step
    // of a migration is behind at least one of those.
    should(collectionsAfterCrossFamily).equal(0);
    should(reportAfterCrossFamily).be.undefined();
    should([relaunchesAfterCrossFamily, snapshotsAfterCrossFamily]).deepEqual([0, 0]);
    should(afterCrossFamily).have.property('agent', WRAPPER);
    should(afterCrossFamily).not.have.property('migration');
    // The same request id, corrected to a same-family account, is EVALUATED AGAIN rather than answered
    // from the ledger: it reaches the preflight and is refused on the session's condition instead.
    should(correctedUnderSameId.status).equal(409);
    should(correctedBody.code).equal('migration_refused');
    // The reverse crossing is refused on its own terms, and that session is untouched too.
    should(codexToClaude.status).equal(409);
    should(codexToClaudeBody.code).equal('harness_mismatch');
    should(codexToClaudeBody.error).containEql('runs the codex harness');
    should(codexToClaudeBody.error).containEql(`${TARGET_WRAPPER} is a claude account`);
    should(codexConfigAfter).have.property('agent', CROSS_FAMILY_WRAPPER);
    should(codexConfigAfter).have.property('harness', 'codex');
    // An agent that is mid-turn is not migrated out from under itself, and the refusal names why:
    // the record claims work the inspection could not see, which is a blind spot, not an all-clear.
    should(midTurn.status).equal(409);
    should(midTurnBody.code).equal('migration_refused');
    should(midTurnBody.error).containEql('reports running work but nothing was observable');
    should(afterMidTurn).have.property('agent', WRAPPER);
    // A smaller window is refused BEFORE the pane is even looked at, and nothing moved.
    should(downgrade.status).equal(409);
    const downgradeRefusal = ContextDowngradeRefusedBodySchema.parse(await downgrade.json());
    should(downgradeRefusal.code).equal('context_downgrade_refused');
    should(downgradeRefusal.downgrade).deepEqual({
      model: 'claude-sonnet-5',
      targetWindow: 200_000,
      currentWindow: 1_000_000,
    });
    should(downgradeRefusal.error).not.containEql('allowContextDowngrade');
    should(downgradeRefusal.error).containEql('part of this conversation would be cut off');
    should(afterDowngrade).have.property('agent', WRAPPER);
    // The refusal carries the inventory that produced it: a bare 409 would leave the operator with
    // no way to tell "a push is running" from "we could not look".
    should(refused.status).equal(409);
    should(refusedBody.code).equal('migration_refused');
    should(refusedBody.error).containEql('git push origin main');
    should(refusedBody.error).containEql('DESTRUCTIVE');
    // NOTHING was written by the refusal — not the document, and not even the report.
    should(afterRefusal).have.property('agent', WRAPPER);
    should(reportAfterRefusal).be.undefined();
    // The clean migration moved the session: same id, same directory, new account.
    should(moved.status).equal(200);
    should(movedBody.config.id).equal(id);
    should(movedBody.config.agent).equal(TARGET_WRAPPER);
    // The family did NOT change, because that is the only migration there is.
    should(movedBody.config.harness).equal('claude');
    // The argv the NEXT relaunch will run is the target's executable, not the account it left.
    should((afterMove.command as readonly string[])[0]).equal(join(home, 'bin', TARGET_WRAPPER));
    // THE CONVERSATION WENT WITH THE SESSION: the same harness session, copied into the target login's
    // home at the path Claude resumes it from — never a freshly minted, empty one.
    const carriedFile = join(
      home,
      'homes',
      'target',
      'projects',
      home.replaceAll(/[^a-zA-Z0-9]/gu, '-'),
      'seeded-harness-session.jsonl',
    );
    should(afterMove.transcript).match({
      home: join(home, 'homes', 'target'),
      harnessSessionId: 'seeded-harness-session',
      file: carriedFile,
    });
    should(carriedTranscript).equal(seededTranscript);
    // The stamp analytics reads to call a session migrated, with both ends of the move in it.
    should(afterMove.migration).have.properties({ from: WRAPPER, to: TARGET_WRAPPER });
    // A new incarnation, because a different program is answering the next turn.
    should(afterMove).have.property('runtimeGeneration', 2);
    should(afterMove).have.property('incarnation', `${id}-2`);
    // THE LIVE PANE WAS REPLACED, not typed into — for ALL FOUR moves (the clean one, the way back, the forced restart and
    // the in-place restart). Without that the old account would still be serving the session while its own
    // record named the new one.
    should(reviver.snapshots).deepEqual([id, id, id, id]);
    should(reviver.relaunched).deepEqual([id, id, id, id]);
    // This session was idle, so the replacement is told only that nothing was interrupted — as a Ferretry
    // notice through the same turn document a revive writes, never the old "You were migrated mid-turn" message.
    // The report is still written; the notice only points at it when work was interrupted.
    should(reviver.delivered[0]).containEql('turns/turn-002.md');
    should(turnTwo).containEql('[ferretry] Restarted — nothing was interrupted.');
    should(turnTwo).not.containEql('migrated mid-turn');
    // Both halves of the report: the inventory written before the pane died, and the outcome that is
    // the only part allowed to claim the move happened.
    should(report).containEql('# Migration in-flight report');
    // The open tool was NAMED, from the session's own transcript. Without provenance this line reads
    // `? … (command not found in chat tail)` and the migration above is refused instead of run.
    should(report).containEql('Read');
    should(report).containEql('/work/open.ts');
    should(report).not.containEql('command not found in chat tail');
    should(report).containEql('## Outcome — MIGRATION SUCCEEDED');
    should(report).containEql(`onto \`${TARGET_WRAPPER}\``);
    // The way back needs no downgrade flag — the origin's window is the larger one — and it writes a
    // THIRD turn document beside the other two rather than overwriting the second.
    should(movedBack.status).equal(200);
    should(turnsAfterSecond).deepEqual(['turn-001.md', 'turn-002.md', 'turn-003.md']);
    // ONE report per session, replaced rather than appended to: the handoff message can only name one
    // file, and this one describes the move that just happened.
    should(secondReport.split('# Migration in-flight report')).have.length(2);
    should(secondReport).containEql(`onto \`${WRAPPER}\``);
    // The unforced refusal carries the inventory as data: the unknown program is the one blocker, and
    // the agent's own tools server is counted as restarting with the CLI rather than listed.
    should(unforced.status).equal(409);
    const unforcedRefusal = MigrationRefusedBodySchema.parse(unforcedBody);
    should(unforcedRefusal.inflight).match({ blockedBy: 'unknown', restartsWithCli: 1 });
    should(unforcedRefusal.inflight?.items.map(item => [item.title, item.detail])).deepEqual([
      ['A program Ferretry doesn’t recognise is running', 'some-vendor-tool --watch'],
    ]);
    should(unforcedRefusal.error).not.containEql('in-flight work is unknown');
    // Forced, the same request goes through, says so in the report, and leaves a journal entry that
    // names what it went past.
    if (forced.status !== 200) throw new Error(`the forced restart was refused: ${JSON.stringify(forcedRaw)}`);
    should(SessionViewSchema.parse(forcedRaw).config.agent).equal(TARGET_WRAPPER);
    should(forcedReport).containEql('FORCED past a destructive/unknown refusal');
    should(forcedJournal).containEql('"session.migrate_forced"');
    should(forcedJournal).containEql('some-vendor-tool --watch');
    should(forcedJournal).not.containEql('fy mcp serve');
    if (restartInPlace.status !== 200)
      throw new Error(`the same-account restart was refused: ${JSON.stringify(restartInPlaceRaw)}`);
    should(SessionViewSchema.parse(restartInPlaceRaw).config.agent).equal(TARGET_WRAPPER);
    // An agent the fleet does not publish is a fact about the agent, not about the session.
    should(unknownAgent.status).equal(404);
    should((await unknownAgent.json()) as { code: string }).have.property('code', 'unknown_agent');
    should(absent.status).equal(404);
    should((await absent.json()) as { code: string }).have.property('code', 'not-found');
  });

  /**
   * A RELAUNCH RUNS ON CURRENT SETTINGS, whichever way it happens.
   *
   * The defect: a revive replayed the argv its start recorded, and a Restart CLI (a migration onto the
   * same account) planned the account's default model. So a session switched to another model came
   * back on the default, and a session started before the hand-off `Read(...)` rules existed never
   * got them however often it was revived. Both now build the argv the way a start does, from the
   * session's documents and the fleet as it is NOW, and Info › Runtime can ask whether the running
   * process is behind that.
   *
   * The session is made OLD by hand — its recorded argv has no rules, as a pre-#554 start's did — and
   * the owner's `/model` switch is seeded as the harness's own report, which is how the daemon learns
   * of one. The permission mode then changes by regenerating the wrapper, as `fy fleet apply` does.
   */
  it('should revive and restart a session on current settings, keeping the model it is on', async () => {
    // Arrange
    const home = await tempDirectory('fyd-relaunch-settings');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    const reviver = new RecordingResumeLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
      createResumeLauncher: (
        _storage: unknown,
        relaunch: (id: SessionId) => Promise<readonly string[] | undefined>,
      ) => {
        reviver.argvFor = relaunch;
        return reviver;
      },
    };
    const wrapper = await seedFleet(home);
    const harness = join(home, 'harness');
    const permissionMode = async (mode: string): Promise<void> =>
      await writeFile(
        wrapper,
        `#!/bin/sh\nexport CLAUDE_CONFIG_DIR="${harness}"\nexec claude --permission-mode ${mode} "$@"\n`,
        { mode: 0o755 },
      );
    await permissionMode('auto');
    // Two models, so keeping the one the session is on is distinguishable from planning the default.
    await publishManifest(home, [
      {
        id: BOOT_ACCOUNT,
        kind: 'claude',
        mode: 'auto',
        wrapper,
        home: harness,
        displayName: 'Boot',
        defaultModel: 'claude-opus-5',
        models: [
          { id: 'claude-opus-5', available: true },
          { id: 'claude-sonnet-5', available: true },
        ],
        available: true,
        unavailableReason: null,
      },
    ]);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const cli = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startResponse = await fetch(sessions, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-relaunch-start' },
      body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'keep the settings current', cwd: home }),
    });
    const startedRaw: unknown = await startResponse.json();
    if (startResponse.status !== 201) throw new Error(`the fixture start failed: ${JSON.stringify(startedRaw)}`);
    const id = SessionViewSchema.parse(startedRaw).config.id;
    const configFile = join(home, 'state', 'sessions', id, 'config.json');
    const stateFile = join(home, 'state', 'sessions', id, 'state.json');
    const document = async (file: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const patch = async (file: string, fields: Record<string, unknown>): Promise<void> =>
      await writeFile(file, JSON.stringify({ ...(await document(file)), ...fields }), { mode: 0o600 });
    const settings = async (): Promise<unknown> =>
      await (await fetch(`${sessions}/${id}/relaunch-settings`, { headers: cli })).json();
    const startArgv = launcher.launched[0]?.command ?? [];
    const readRules = startArgv.filter(token => token.startsWith('--allowedTools=Read('));

    // Act
    const fresh = await settings();
    // Made OLD: the argv a start recorded before the Read rules existed.
    const harnessSession = startArgv[startArgv.indexOf('--session-id') + 1] ?? '';
    await patch(configFile, { command: [wrapper, '--session-id', harnessSession, '--model', 'claude-opus-5'] });
    // The owner typed `/model` in the pane; the harness reported it after the start decided.
    await patch(stateFile, {
      observedModel: 'claude-sonnet-5',
      observedModelAt: '2099-01-01T00:00:00.000Z',
      observedReasoningEffort: 'high',
    });
    // The machine's agent permissions changed: the fleet regenerated the wrapper.
    await permissionMode('default');
    const stale = await settings();
    // The pane died (as after `fy daemon restart`); the session is revived.
    await fetch(`${sessions}/${id}/stop`, {
      method: 'POST',
      headers: cli,
      body: JSON.stringify({ reason: 'pane died' }),
    });
    reviver.pane = { alive: false, dead: false, promptReady: false };
    const revived = await fetch(`${sessions}/${id}/resume`, {
      method: 'POST',
      headers: cli,
      body: JSON.stringify({ message: 'pick it back up' }),
    });
    const afterRevive = await settings();
    const revivedConfig = await document(configFile);
    // The profile changes too, and the owner presses Restart CLI: a migration onto the same account
    // that names no model. A session answering at its prompt is one the gate lets through.
    await permissionMode('acceptEdits');
    const beforeRestart = await settings();
    // The revived CLI has talked since: its transcript is on disk, so there IS a conversation, and a
    // Restart must continue it rather than open a new one (the owner's "no memory after Restart").
    const boundFile = String((revivedConfig.transcript as { file?: string } | undefined)?.file);
    await mkdir(dirname(boundFile), { recursive: true });
    await writeFile(boundFile, `${JSON.stringify({ type: 'user', sessionId: harnessSession })}\n`, { mode: 0o600 });
    await patch(stateFile, { status: 'rate_limited' });
    reviver.pane = { alive: true, dead: false, promptReady: true };
    const restarted = await fetch(`${sessions}/${id}/migrate`, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-relaunch-restart' },
      body: JSON.stringify({ agent: WRAPPER }),
    });
    const restartedRaw: unknown = await restarted.json();
    const restartedConfig = await document(configFile);
    const afterRestart = await settings();
    const absent = await fetch(`${sessions}/no-such-session/relaunch-settings`, { headers: cli });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // The start carried the rules and recorded what it launched under, so it is current.
    should(readRules.length).be.above(0);
    should(fresh).deepEqual({ current: true, reasons: [] });
    // Behind on both counts: rules it predates, and a permission mode changed under it.
    should(stale).deepEqual({ current: false, reasons: ['arguments', 'settings'] });
    // THE REVIVE: rebuilt, not replayed — the rules are back, on the model and effort it is ON, with
    // the same conversation (the transcript was never written here, so it is created, not resumed).
    should(revived.status).equal(200);
    const revivedArgv = reviver.argv[0] ?? [];
    should(revivedArgv).containDeep(readRules);
    should(revivedArgv.slice(revivedArgv.indexOf('--model'), revivedArgv.indexOf('--model') + 2)).deepEqual([
      '--model',
      'claude-sonnet-5',
    ]);
    should(revivedArgv).containDeep(['--effort', 'high']);
    should(revivedArgv).containDeep(['--session-id', harnessSession]);
    should(revivedConfig.model).equal('claude-sonnet-5');
    should(afterRevive).deepEqual({ current: true, reasons: [] });
    // THE RESTART: the profile change is seen, and the restart keeps Sonnet rather than the default.
    should(beforeRestart).deepEqual({ current: false, reasons: ['settings'] });
    if (restarted.status !== 200) throw new Error(`the restart was refused: ${JSON.stringify(restartedRaw)}`);
    should(SessionViewSchema.parse(restartedRaw).config.model).equal('claude-sonnet-5');
    const restartArgv = reviver.argv[1] ?? [];
    should(restartArgv).containDeep(readRules);
    should(restartArgv).containDeep(['--model', 'claude-sonnet-5']);
    should(restartArgv).not.containEql('claude-opus-5');
    // THE SAME CONVERSATION: resumed by the id it was bound to, and the record still names it.
    should(restartArgv).containDeep(['--resume', harnessSession]);
    should(restartArgv).not.containEql('--session-id');
    should(restartedConfig.transcript).match({ harnessSessionId: harnessSession, file: boundFile });
    should(afterRestart).deepEqual({ current: true, reasons: [] });
    should(absent.status).equal(404);
  });

  /**
   * RESTART CONTINUES THE CONVERSATION — the owner's "as if nothing changed except the process restarted".
   *
   * The defect: a migration re-captured the target's transcript the way a start does, and for Claude a
   * capture mints a NEW harness session id. So Restart CLI (a migration onto the same login) relaunched
   * with `--session-id <new id>` and the agent came back with no memory, while the conversation it had
   * sat on disk with nothing pointing at it. The same happened moving between two logins of one harness.
   *
   * Driven through the production composition root; only the pane is recorded, and what each relaunch
   * WOULD have run comes from the production rebuild. The order is the argument:
   *
   *   * THE BROKEN STATE, as an earlier Restart left it: bound to a new conversation, with the real one
   *     older beside it in the same folder. Restart keeps the binding; the repair (`previous`) rebinds
   *     to the real one and resumes it.
   *   * ANOTHER LOGIN of the same harness: the transcript is copied into its home and resumed by the
   *     same id.
   *   * NOTHING TO RESUME: refused, nothing written — and Start fresh is the person's explicit choice.
   *   * CODEX: a thread proven by correlation is resumed with `resume <thread>`, not reopened empty.
   */
  it('should resume the bound conversation on Restart and migrate, and repair one a Restart lost', async () => {
    // Arrange
    const home = await tempDirectory('fyd-restart-resume');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    const reviver = new RecordingResumeLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
      createResumeLauncher: (
        _storage: unknown,
        relaunch: (id: SessionId) => Promise<readonly string[] | undefined>,
      ) => {
        reviver.argvFor = relaunch;
        return reviver;
      },
    };
    const binary = join(home, 'bin');
    await mkdir(binary, { recursive: true });
    const login = (name: string): string => join(home, 'homes', name);
    const wrappers = [
      {
        wrapper: WRAPPER,
        kind: 'claude' as const,
        id: ORIGIN_ACCOUNT,
        variable: 'CLAUDE_CONFIG_DIR',
        model: 'claude-opus-5',
      },
      {
        wrapper: TARGET_WRAPPER,
        kind: 'claude' as const,
        id: TARGET_ACCOUNT,
        variable: 'CLAUDE_CONFIG_DIR',
        model: 'claude-opus-5',
      },
      {
        wrapper: CROSS_FAMILY_WRAPPER,
        kind: 'codex' as const,
        id: CROSS_FAMILY_ACCOUNT,
        variable: 'CODEX_HOME',
        model: 'gpt-5.6-terra',
      },
    ];
    for (const entry of wrappers)
      await writeFile(
        join(binary, entry.wrapper),
        `#!/bin/sh\nexport ${entry.variable}="${login(entry.wrapper)}"\nexit 0\n`,
        {
          mode: 0o755,
        },
      );
    await publishManifest(
      home,
      wrappers.map(entry => ({
        id: entry.id,
        kind: entry.kind,
        mode: 'auto' as const,
        wrapper: join(binary, entry.wrapper),
        home: login(entry.wrapper),
        displayName: entry.wrapper,
        defaultModel: entry.model,
        models: [{ id: entry.model, available: true }],
        available: true,
        unavailableReason: null,
      })),
    );
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const cli = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startSession = async (agent: string, requestId: string): Promise<SessionId> => {
      const response = await fetch(sessions, {
        method: 'POST',
        headers: { ...cli, 'x-fy-request-id': requestId },
        body: JSON.stringify({ agent, mode: 'auto', prompt: 'remember this', cwd: home }),
      });
      const raw: unknown = await response.json();
      if (response.status !== 201) throw new Error(`the fixture start failed: ${JSON.stringify(raw)}`);
      return parseSessionId(SessionViewSchema.parse(raw).config.id);
    };
    const documentOf = async (id: SessionId, name: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(join(home, 'state', 'sessions', id, name), 'utf8')) as Record<string, unknown>;
    const patch = async (id: SessionId, name: string, fields: Record<string, unknown>): Promise<void> =>
      await writeFile(
        join(home, 'state', 'sessions', id, name),
        JSON.stringify({ ...(await documentOf(id, name)), ...fields }),
        { mode: 0o600 },
      );
    let asked = 0;
    // Each move is asked of a session at its prompt, with nothing in flight, so only the conversation decides.
    const migrate = async (id: SessionId, body: Record<string, unknown>): Promise<Response> => {
      await patch(id, 'state.json', { status: 'rate_limited', openTools: [] });
      reviver.pane = { alive: true, dead: false, promptReady: true };
      asked += 1;
      return await fetch(`${sessions}/${id}/migrate`, {
        method: 'POST',
        headers: { ...cli, 'x-fy-request-id': `req-restart-resume-${asked}` },
        body: JSON.stringify({ allowContextDowngrade: true, ...body }),
      });
    };
    const transcriptOf = async (id: SessionId): Promise<Record<string, unknown>> =>
      (await documentOf(id, 'config.json')).transcript as Record<string, unknown>;
    const lastArgv = (): readonly string[] => reviver.argv.at(-1) ?? [];
    const writeTranscript = async (file: string, body: string, modifiedSeconds: number): Promise<void> => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body, { mode: 0o600 });
      await utimes(file, modifiedSeconds, modifiedSeconds);
    };

    // Act
    // THE BROKEN STATE. The start bound conversation REAL; an earlier Restart then minted NEW and
    // rebound the session to it. Both name the session's directory, because every turn file does.
    const claudeId = await startSession(WRAPPER, 'req-restart-resume-start');
    const sessionDirectory = join(home, 'state', 'sessions', claudeId);
    const started = await transcriptOf(claudeId);
    const realId = String(started.harnessSessionId);
    const realFile = String(started.file);
    const realBody = `${JSON.stringify({ type: 'user', message: { content: `read ${sessionDirectory}/turns/turn-001.md` } })}\n`;
    await writeTranscript(realFile, realBody, 1_800_000_000);
    const newId = '62c20739-0000-4000-8000-000000000001';
    const newFile = join(dirname(realFile), `${newId}.jsonl`);
    await writeTranscript(
      newFile,
      `${JSON.stringify({ type: 'user', message: { content: `${sessionDirectory}/state.json` } })}\n`,
      1_800_000_600,
    );
    // An unrelated conversation in the same folder, newer still, that never names this session.
    await writeTranscript(join(dirname(realFile), 'ffffffff-0000-4000-8000-000000000009.jsonl'), '{}\n', 1_800_001_200);
    await patch(claudeId, 'config.json', {
      transcript: { ...started, harnessSessionId: newId, file: newFile, identity: 'minted' },
    });
    const restartBroken = await migrate(claudeId, { agent: WRAPPER });
    const restartBrokenArgv = lastArgv();
    const repaired = await migrate(claudeId, { agent: WRAPPER, conversation: 'previous' });
    const repairedRaw: unknown = await repaired.json();
    const repairedArgv = lastArgv();
    const afterRepair = await transcriptOf(claudeId);
    // ANOTHER LOGIN of the same harness.
    const moved = await migrate(claudeId, { agent: TARGET_WRAPPER });
    const movedArgv = lastArgv();
    const afterMove = await transcriptOf(claudeId);
    const carried = await readFile(String(afterMove.file), 'utf8');
    // NOTHING RECORDS A CONVERSATION: refused and untouched, until the person chooses a fresh one.
    const { transcript: _dropped, ...unbound } = await documentOf(claudeId, 'config.json');
    await writeFile(join(sessionDirectory, 'config.json'), JSON.stringify(unbound), { mode: 0o600 });
    const relaunchesBeforeRefusal = reviver.relaunched.length;
    const refused = await migrate(claudeId, { agent: TARGET_WRAPPER });
    const refusedBody = ConversationUnresumableBodySchema.parse(await refused.json());
    const afterRefusal = await documentOf(claudeId, 'config.json');
    const relaunchesAfterRefusal = reviver.relaunched.length;
    const fresh = await migrate(claudeId, { agent: TARGET_WRAPPER, conversation: 'fresh' });
    const freshArgv = lastArgv();
    // CODEX, with a thread the daemon proved by correlation.
    const codexId = await startSession(CROSS_FAMILY_WRAPPER, 'req-restart-resume-codex');
    const codexStarted = await transcriptOf(codexId);
    const thread = '019a0000-0000-7000-8000-00000000c0de';
    const rollout = join(
      login(CROSS_FAMILY_WRAPPER),
      'sessions',
      '2026',
      '10',
      '20',
      `rollout-2026-10-20T06-00-00-${thread}.jsonl`,
    );
    await writeTranscript(
      rollout,
      `${JSON.stringify({ type: 'session_meta', payload: { id: thread } })}\n`,
      1_800_000_000,
    );
    await patch(codexId, 'config.json', {
      transcript: {
        ...codexStarted,
        harnessSessionId: thread,
        identity: 'correlated',
        file: rollout,
        resolvedAt: '2026-10-20T06:00:00.000Z',
      },
    });
    const codexRestart = await migrate(codexId, { agent: CROSS_FAMILY_WRAPPER });
    const codexArgv = lastArgv();
    const journal = await readFile(join(sessionDirectory, 'events.jsonl'), 'utf8');
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // Restart on the broken state keeps the binding it has — the conversation that is there now.
    should(restartBroken.status).equal(200);
    should(restartBrokenArgv).containDeep(['--resume', newId]);
    // The repair goes back to the REAL conversation: the newest OTHER one that names this session,
    // never the newer stranger, and resumes it.
    if (repaired.status !== 200) throw new Error(`the repair was refused: ${JSON.stringify(repairedRaw)}`);
    should(repairedArgv).containDeep(['--resume', realId]);
    should(repairedArgv).not.containEql('--session-id');
    should(afterRepair).match({ harnessSessionId: realId, file: realFile });
    // Onto another login: the same conversation, copied into its home and resumed by the same id.
    should(moved.status).equal(200);
    should(movedArgv[0]).equal(join(binary, TARGET_WRAPPER));
    should(movedArgv).containDeep(['--resume', realId]);
    should(afterMove).match({ home: login(TARGET_WRAPPER), harnessSessionId: realId });
    should(String(afterMove.file).startsWith(login(TARGET_WRAPPER))).be.true();
    should(carried).equal(realBody);
    // Nothing to resume: a plain refusal naming the way past, and nothing restarted or rewritten.
    should(refused.status).equal(409);
    should(refusedBody.error).containEql('no recorded conversation');
    should(refusedBody.error).containEql('Start fresh');
    should(relaunchesAfterRefusal).equal(relaunchesBeforeRefusal);
    should(afterRefusal).not.have.property('transcript');
    should(afterRefusal).have.property('runtimeGeneration', unbound.runtimeGeneration);
    // Start fresh is honoured when it is asked for — a new conversation, said so in the journal.
    should(fresh.status).equal(200);
    should(freshArgv).containEql('--session-id');
    should(freshArgv).not.containEql(realId);
    should(journal).containEql('"conversation":"fresh"');
    should(journal).containEql('"conversation":"resumed"');
    // Codex resumes its proven thread rather than opening a new rollout.
    should(codexRestart.status).equal(200);
    should(codexArgv.slice(1, 3)).deepEqual(['resume', thread]);
  });

  /**
   * A cross-harness move that CONVERTS the conversation, driven through the production composition root.
   *
   * Everything real except the two harness CLIs, which are stand-ins declared through `harness.paths`
   * exactly as an operator would: each answers `--version`, and on resume opens the converted file where
   * its harness would look and sends the loopback model the history it found — so the validation run the
   * move gates on is the production one, against a CLI that genuinely reads the file. The real CLIs are
   * measured against the same files in the harness contract suite.
   */
  it('should convert a Claude conversation onto Codex and back, refusing a target that rejects it', async () => {
    // Arrange
    const home = await tempDirectory('fyd-convert');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    const reviver = new RecordingResumeLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
      createResumeLauncher: (
        _storage: unknown,
        relaunch: (id: SessionId) => Promise<readonly string[] | undefined>,
      ) => {
        reviver.argvFor = relaunch;
        return reviver;
      },
    };
    const binary = join(home, 'bin');
    const harnessBin = join(home, 'harness-bin');
    await mkdir(binary, { recursive: true });
    await mkdir(harnessBin, { recursive: true });
    const login = (name: string): string => join(home, 'homes', name);
    const wrappers = [
      {
        wrapper: WRAPPER,
        kind: 'claude' as const,
        id: ORIGIN_ACCOUNT,
        variable: 'CLAUDE_CONFIG_DIR',
        model: 'claude-opus-5',
      },
      {
        wrapper: CROSS_FAMILY_WRAPPER,
        kind: 'codex' as const,
        id: CROSS_FAMILY_ACCOUNT,
        variable: 'CODEX_HOME',
        model: 'gpt-5.6-terra',
      },
    ];
    for (const entry of wrappers)
      await writeFile(
        join(binary, entry.wrapper),
        `#!/bin/sh\nexport ${entry.variable}="${login(entry.wrapper)}"\nexit 0\n`,
        {
          mode: 0o755,
        },
      );
    await publishManifest(
      home,
      wrappers.map(entry => ({
        id: entry.id,
        kind: entry.kind,
        mode: 'auto' as const,
        wrapper: join(binary, entry.wrapper),
        home: login(entry.wrapper),
        displayName: entry.wrapper,
        defaultModel: entry.model,
        models: [{ id: entry.model, available: true }],
        available: true,
        unavailableReason: null,
      })),
    );
    // The stand-in CLIs. Control files beside each say which version it reports and whether it rejects.
    for (const kind of ['claude', 'codex'] as const)
      await writeFile(join(harnessBin, kind), fakeHarnessCli(kind), { mode: 0o755 });
    await writeFile(join(harnessBin, 'claude.version'), '2.1.304 (Claude Code)\n');
    await writeFile(join(harnessBin, 'codex.version'), 'codex-cli 0.163.0\n');
    const configFile = join(home, 'config', 'daemon.json');
    await writeFile(
      configFile,
      JSON.stringify({
        ...(JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>),
        harness: { paths: { claude: join(harnessBin, 'claude'), codex: join(harnessBin, 'codex') } },
      }),
      { mode: 0o600 },
    );
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const cli = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const created = await fetch(sessions, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-convert-start' },
      body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'remember the launch code is 4471', cwd: home }),
    });
    const id = parseSessionId(SessionViewSchema.parse(await created.json()).config.id);
    const sessionDirectory = join(home, 'state', 'sessions', id);
    const documentOf = async (name: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(join(sessionDirectory, name), 'utf8')) as Record<string, unknown>;
    const patch = async (name: string, fields: Record<string, unknown>): Promise<void> =>
      await writeFile(join(sessionDirectory, name), JSON.stringify({ ...(await documentOf(name)), ...fields }), {
        mode: 0o600,
      });
    let asked = 0;
    const migrate = async (body: Record<string, unknown>): Promise<Response> => {
      await patch('state.json', { status: 'rate_limited', openTools: [] });
      reviver.pane = { alive: true, dead: false, promptReady: true };
      asked += 1;
      return await fetch(`${sessions}/${id}/migrate`, {
        method: 'POST',
        headers: { ...cli, 'x-fy-request-id': `req-convert-${asked}` },
        body: JSON.stringify(body),
      });
    };
    const preview = async (agent: string): Promise<ConversionPreview> => {
      const response = await fetch(`${sessions}/${id}/conversion-preview`, {
        method: 'POST',
        headers: cli,
        body: JSON.stringify({ agent }),
      });
      return ConversionPreviewSchema.parse(await response.json());
    };
    // The conversation Claude had: a real recorded transcript, opened by the turn-one pointer the start sent.
    const started = (await documentOf('config.json')).transcript as Record<string, unknown>;
    const claudeId = String(started.harnessSessionId);
    const claudeFile = String(started.file);
    const pointer = {
      type: 'user',
      sessionId: claudeId,
      version: '2.1.281',
      timestamp: '2026-10-20T06:00:00.000Z',
      message: {
        role: 'user',
        content: `Read the file ${sessionDirectory}/turns/turn-001.md now, then carefully follow every instruction inside it. This is your complete task for this turn.`,
      },
    };
    const recorded = await Bun.file(
      new URL('../../fixtures/transcript/convert/claude-2.1.281.jsonl', import.meta.url),
    ).text();
    const lines = recorded.split('\n');
    const claudeBody = [
      JSON.stringify(pointer),
      ...lines.slice(
        0,
        lines.findIndex(line => line.includes('"compact_boundary"')),
      ),
    ].join('\n');
    await mkdir(dirname(claudeFile), { recursive: true });
    await writeFile(claudeFile, claudeBody, { mode: 0o600 });

    // Act
    const ready = await preview(CROSS_FAMILY_WRAPPER);
    const sameFamily = await preview(WRAPPER);
    // A target that cannot open it: refused in plain words, and nothing moved.
    await writeFile(join(harnessBin, 'codex.reject'), '');
    const relaunchesBefore = reviver.relaunched.length;
    const rejected = await migrate({ agent: CROSS_FAMILY_WRAPPER, conversation: 'convert' });
    const rejectedBody = ConversationUnresumableBodySchema.parse(await rejected.json());
    const afterRejection = await documentOf('config.json');
    const relaunchesAfterRejection = reviver.relaunched.length;
    await rm(join(harnessBin, 'codex.reject'));
    // Untested Codex: the preview says so before anything is attempted.
    await writeFile(join(harnessBin, 'codex.version'), 'codex-cli 0.150.0\n');
    const untested = await preview(CROSS_FAMILY_WRAPPER);
    await writeFile(join(harnessBin, 'codex.version'), 'codex-cli 0.163.0\n');
    // The move itself.
    const converted = await migrate({ agent: CROSS_FAMILY_WRAPPER, conversation: 'convert' });
    const convertedRaw: unknown = await converted.json();
    const convertedArgv = reviver.argv.at(-1) ?? [];
    const onCodex = await documentOf('config.json');
    const codexTranscript = onCodex.transcript as Record<string, unknown>;
    const rollout = await readFile(String(codexTranscript.file), 'utf8');
    // Restart afterwards resumes the converted conversation.
    const restarted = await migrate({ agent: CROSS_FAMILY_WRAPPER });
    const restartedArgv = reviver.argv.at(-1) ?? [];
    const afterRestart = await documentOf('config.json');
    // And back onto Claude — whose CLI, this time, declares no shell tool for the model, so the shell
    // commands go back as text after the native rendering is refused.
    await writeFile(join(harnessBin, 'claude.notools'), '');
    const back = await migrate({ agent: WRAPPER, conversation: 'convert' });
    const backRaw: unknown = await back.json();
    const backArgv = reviver.argv.at(-1) ?? [];
    const onClaude = await documentOf('config.json');
    const journal = await readFile(join(sessionDirectory, 'events.jsonl'), 'utf8');
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    if (ready.kind !== 'ready') throw new Error(`the preview refused: ${ready.reason}`);
    should(ready.summary).match({
      sourceHarness: 'claude',
      sourceVersion: '2.1.281',
      targetHarness: 'codex',
      targetVersion: '0.163.0',
      omittedTurns: 0,
      nativeToolCalls: 1,
      toolCallsAsText: 2,
      attachments: 1,
    });
    should(sameFamily).match({ kind: 'refused', targetAgent: WRAPPER });
    should(rejected.status).equal(409);
    should(rejectedBody.error).equal(
      'Codex refused to open the converted conversation. It said: Error: thread/resume failed Nothing was changed.',
    );
    should(relaunchesAfterRejection).equal(relaunchesBefore);
    should(afterRejection).match({ harness: 'claude', agent: WRAPPER, transcript: started });
    should(untested.kind === 'refused' ? untested.reason : '').containEql('This machine runs Codex 0.150.0');
    // Converted: the session is the same session, on Codex, bound to a fresh thread in the Codex home.
    if (converted.status !== 200) throw new Error(`the conversion was refused: ${JSON.stringify(convertedRaw)}`);
    should(onCodex).match({ id, harness: 'codex', agent: CROSS_FAMILY_WRAPPER, harnessFlags: [] });
    should(String(codexTranscript.file).startsWith(join(login(CROSS_FAMILY_WRAPPER), 'sessions'))).be.true();
    should(codexTranscript).match({ identity: 'adopted', correlationToken: sessionDirectory });
    const thread = String(codexTranscript.harnessSessionId);
    should(convertedArgv.slice(1, 3)).deepEqual(['resume', thread]);
    should(rollout).containEql('[Ferretry moved this conversation here from Claude Code');
    // The turn pointer became the message it pointed at.
    should(rollout).containEql('remember the launch code is 4471');
    should(rollout).not.containEql('/turns/turn-001.md now');
    should(onCodex.conversion).match({
      v: 1,
      converter: 1,
      fromHarness: 'claude',
      fromConversation: claudeId,
      fromFile: claudeFile,
      toHarness: 'codex',
      toConversation: thread,
      omittedTurns: 0,
    });
    // The Claude conversation is untouched on disk, and the saved attachment is in the session's folder.
    should(await readFile(claudeFile, 'utf8')).equal(claudeBody);
    should(await readdir(join(sessionDirectory, 'conversions', thread))).deepEqual(['attachment-1.png']);
    should(journal).containEql('"conversation":"converted"');
    should(journal).containEql(`"convertedFrom":{"harness":"claude","conversation":"${claudeId}"`);
    // Restart keeps the converted conversation and its lineage.
    should(restarted.status).equal(200);
    should(restartedArgv.slice(1, 3)).deepEqual(['resume', thread]);
    should(afterRestart.conversion).deepEqual(onCodex.conversion);
    // Back onto Claude: another fresh conversation, resumed by Claude's own id.
    if (back.status !== 200) throw new Error(`the conversion back was refused: ${JSON.stringify(backRaw)}`);
    const claudeAgain = onClaude.transcript as Record<string, unknown>;
    should(onClaude).match({
      harness: 'claude',
      agent: WRAPPER,
      conversion: { fromHarness: 'codex', fromConversation: thread },
    });
    should(claudeAgain.harnessSessionId).not.equal(claudeId);
    should(backArgv).containDeep(['--resume', String(claudeAgain.harnessSessionId)]);
    const claudeText = await readFile(String(claudeAgain.file), 'utf8');
    should(claudeText).containEql('remember the launch code is 4471');
    should(claudeText).not.containEql('"tool_use"');
    should(claudeText).containEql('[ran shell: echo fixture-output]');
    should(journal).containEql('"nativeToolCalls":0');
  });

  /**
   * The cross-harness handover, driven through the production composition root over a real socket.
   *
   * WHAT THIS TIER ADDS, and why the handover's own integration file does not already cover it. That
   * file builds the route table, the receipt store and the reconcile loop by hand and proves they agree
   * with each other. It cannot prove the thing this migration keeps losing: that `buildWorld` actually
   * CONSTRUCTS the handover service and hands its routes to the dispatcher a booted daemon serves. A
   * subsystem built, tested and never mounted answers 404 to every caller while every unit test stays
   * green, so the only honest proof is a request that leaves the socket.
   *
   * The refusals are the assertions on purpose. A begin that succeeded would create a real replacement
   * session and change board membership, which is not a thing a boot test may do; a refusal that comes
   * from the DOMAIN — `harness_same`, decided after the real fleet manifest resolved a real account
   * against a real session's harness — proves the route reached a working service rather than a stub,
   * and proves it without performing the destruction.
   */
  it('should serve, refuse and read a cross-harness handover through the mounted composition root', async () => {
    // Arrange
    const home = await tempDirectory('fyd-session-handover');
    const cleanups: Array<() => void | Promise<void>> = [];
    const launcher = new RecordingSessionLauncher();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: launcher,
    };
    await seedMigrationFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const cli = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ferretry-client': 'cli' };
    const sessions = `http://127.0.0.1:${port}/v1/sessions`;
    const startResponse = await fetch(sessions, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-handover-start' },
      body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'wire the handover', cwd: home }),
    });
    const startedRaw: unknown = await startResponse.json();
    if (startResponse.status !== 201) throw new Error(`the fixture start failed: ${JSON.stringify(startedRaw)}`);
    const id = SessionViewSchema.parse(startedRaw).config.id;
    const handover = `${sessions}/${id}/handover`;

    // Act
    // Nothing has been handed over, so the durable receipt does not exist. This is the read half of the
    // surface reaching the real `FileHandoverReceiptStore` this boot opened over its own state home.
    const noReceipt = await fetch(handover, { headers: cli });
    const noReceiptBody = (await noReceipt.json()) as { code: string };
    // A begin with no request id never reaches the service: a retried POST that could not be recognised
    // would create a second replacement.
    const unidentified = await fetch(handover, {
      method: 'POST',
      headers: cli,
      body: JSON.stringify({ agent: CROSS_FAMILY_WRAPPER, coordinator: null, reason: 'no id' }),
    });
    const unidentifiedBody = (await unidentified.json()) as { code: string };
    // A claude session handed to another CLAUDE account. The account is published, available and
    // runnable — it is refused for the one thing a handover exists to do, which the operator's remedy
    // (`fy migrate`) does without throwing the conversation away.
    const sameFamily = await fetch(handover, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-handover-same' },
      body: JSON.stringify({ agent: TARGET_WRAPPER, coordinator: null, reason: 'wrong tool for the job' }),
    });
    const sameFamilyBody = (await sameFamily.json()) as { error: string; code: string };
    // The cancel half is mounted too, and its empty-body contract is enforced before the service is
    // reached — so a caller cannot come to believe `force` overrides the no-force gate.
    const forcedCancel = await fetch(`${handover}/cancel`, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-handover-force' },
      body: JSON.stringify({ force: true }),
    });
    const forcedCancelBody = (await forcedCancel.json()) as { code: string };
    // ...and an honest cancel of a session that has no handover is answered by the service, not by the
    // route: there is no receipt to cancel.
    const nothingToCancel = await fetch(`${handover}/cancel`, {
      method: 'POST',
      headers: { ...cli, 'x-fy-request-id': 'req-handover-cancel' },
      body: '{}',
    });
    const nothingToCancelBody = (await nothingToCancel.json()) as { code: string };
    // The GET is `authenticated` rather than operator-scoped, but it is still governed: an unauthenticated
    // reader gets nothing at all.
    const unauthenticated = await fetch(handover);
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // THE ROUTES ARE MOUNTED. Every status below is a handover answer rather than the 404 an unmounted
    // subsystem serves, and `not-found` here is the receipt's absence rather than the route's.
    should(noReceipt.status).equal(404);
    should(noReceiptBody.code).equal('not-found');
    should(unauthenticated.status).equal(401);
    should(unidentified.status).equal(400);
    should(unidentifiedBody.code).equal('missing_request_id');
    // THE SERVICE IS REAL. This refusal is only reachable after the boot's own fleet manifest resolved
    // `claude-auto-target` into an account and the domain compared its family with the live session's,
    // so it cannot be produced by a route table wired to a stub.
    should(sameFamily.status).equal(409);
    should(sameFamilyBody.code).equal('harness_same');
    should(forcedCancel.status).equal(400);
    should(forcedCancelBody.code).equal('invalid_body');
    should(nothingToCancel.status).equal(404);
    should(nothingToCancelBody.code).equal('not-found');
    // NOTHING WAS HANDED OVER. Every call above was a refusal, so the daemon launched exactly the one
    // session this case started and no replacement beside it.
    should(launcher.launched).have.length(1);
  });

  /**
   * The recommender, driven through the production composition root over a real socket.
   *
   * It proves the mount DOES ITS JOB rather than merely existing: the fleet comes from the manifest
   * file a provisioner publishes into the state home, the doctrine comes from the operator's routing
   * catalog, and the team that comes back names an account from that manifest with a model that
   * catalog declares. Unlike every other mount here it needs no session at all, which is why it is
   * the one capability this daemon gains that works on a fresh install.
   *
   * The two halves are one case on purpose: the catalog is written BETWEEN the two requests, so the
   * refusal proves the daemon does not invent a doctrine and the answer proves the read is live
   * rather than cached at boot.
   */
  it('should recommend a team from the fleet manifest and the routing catalog', async () => {
    // Arrange
    const home = await tempDirectory('fyd-recommend');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await publishManifest(home, [
      {
        id: PRIMARY_ACCOUNT,
        kind: 'claude',
        mode: 'auto',
        wrapper: join(home, 'bin', 'agent-primary'),
        home: join(home, 'homes', 'primary'),
        displayName: 'Primary',
        defaultModel: 'apex',
        models: [{ id: 'apex', available: true }],
        available: true,
        unavailableReason: null,
      },
    ]);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const body = JSON.stringify({ task: 'port the remaining command groups and their tests', usage: false });
    const call = async (): Promise<Response> =>
      await fetch(`http://127.0.0.1:${port}/v1/recommend`, { method: 'POST', headers, body });

    // Act
    const unconfigured = await call();
    // The operator's doctrine, written while the daemon is already serving.
    await writeFile(
      join(home, 'config', 'routing.json'),
      JSON.stringify({
        models: [
          {
            id: 'apex',
            label: 'Apex',
            family: 'claude',
            tier: 'generalist',
            speed: 'medium',
            cost: 'high',
            power: 90,
            roleScore: { planner: 90, researcher: 85, reviewer: 80 },
            implementerFit: { mechanical: 70, mid: 85, hard: 80 },
            note: 'dependable across generic work',
          },
        ],
        accounts: [{ accountId: PRIMARY_ACCOUNT, options: [{ model: 'apex' }] }],
        floors: { planner: 50, reviewer: 50, hardAndDemanding: 60, hardOrCritical: 55, mid: 40, qualityFirst: 60 },
        costPenalty: { balanced: { high: 4 } },
      }),
      { mode: 0o600 },
    );
    const recommended = await call();
    const recommendedBody = (await recommended.json()) as {
      task: string;
      classification: string;
      roles: { role: string; primary: { accountId: string; model: string } }[];
      exclusions: unknown[];
      warnings: unknown[];
    };
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // No catalog is the operator's gap, named as one, not a 500 and not an invented doctrine.
    should(unconfigured.status).equal(503);
    should((await unconfigured.json()) as { code: string }).have.property('code', 'recommender_unconfigured');
    should(recommended.status).equal(200);
    // The pick came from the manifest file and the model from the catalog file — nothing hardcoded.
    should(recommendedBody.roles.length).be.above(0);
    should(recommendedBody.roles.map(role => [role.primary.accountId, role.primary.model])).matchEvery(
      (pair: readonly string[]) => should(pair).deepEqual([PRIMARY_ACCOUNT, 'apex']),
    );
    // The domain's own one-liner, so the guide states what it read and the words that produced it.
    should(recommendedBody.classification).match(/^Read as /u);
    should(recommendedBody.task).equal('port the remaining command groups and their tests');
  });

  /**
   * The analytics read, driven through the production composition root over a real socket.
   *
   * It proves the mount DOES ITS JOB rather than merely existing: the boot ingestion pass reads the real
   * session documents in the state home and materialises rows in the daemon's own SQLite store, a
   * session that has not finished is left out of it, the real query parser answers the CLI's own `?q=`,
   * and the durations reported are the ones the seeded instants imply.
   *
   * The pass is armed after the bind — a fleet's worth of transcript folds must not stand between a
   * restart and the socket — so this case WAITS FOR THE INDEX TO SETTLE rather than assuming it has.
   * That wait is itself the assertion that `refreshing` means something: an index still being built and
   * one with nothing to say are the same empty answer to a caller that cannot tell them apart.
   */
  it('should ingest and query analytics from the real session documents', async () => {
    // Arrange
    const home = await tempDirectory('fyd-analytics');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await seedSession(home, '2026-07-30T09:00:00.000Z', 'wire-done', {
      status: 'completed',
      turn: 6,
      startedAt: '2026-07-30T09:00:00.000Z',
      finishedAt: '2026-07-30T09:45:00.000Z',
    });
    // Still running: no finish instant, so it must not be measured as a run of some length.
    await seedSession(home, '2026-07-31T09:00:00.000Z', 'wire-live');
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const analytics = `http://127.0.0.1:${port}/v1/analytics`;

    // Act
    let settled = false;
    for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
      const settling = AnalyticsResponseSchema.parse(
        await fetch(analytics, { headers }).then(async response => await response.json()),
      );
      settled = settling.index.sessions === 1 && !settling.index.refreshing;
      if (!settled) await Bun.sleep(50);
    }
    should(settled).be.true();
    const grouped = await fetch(`${analytics}?q=${encodeURIComponent('sum by (id)')}`, { headers });
    const raw = await fetch(`${analytics}?q=${encodeURIComponent('{status=completed}')}`, { headers });
    const refused = await fetch(`${analytics}?q=${encodeURIComponent('sum by (nonsense)')}`, { headers });
    const groupedBody = AnalyticsResponseSchema.parse(await grouped.json());
    const rawBody = AnalyticsResponseSchema.parse(await raw.json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(grouped.status).equal(200);
    // One of the two seeded sessions has finished, so exactly one is indexed.
    should(groupedBody.index.sessions).equal(1);
    should(groupedBody.scope).deepEqual({ allSessions: true, indexed: 1, matched: 1 });
    should(groupedBody.kind === 'aggregate' ? groupedBody.results.map(row => row.labels.id) : []).deepEqual([
      'wire-done',
    ]);
    // 09:00 to 09:45 in the seeded state, measured by the daemon rather than asserted by the client.
    should(groupedBody.kind === 'aggregate' ? groupedBody.results.map(row => row.durationMs.value) : []).deepEqual([
      45 * 60_000,
    ]);
    should(groupedBody.kind === 'aggregate' ? groupedBody.results.map(row => row.turns.value) : []).deepEqual([6]);
    // No token evidence is indexed, so the cost is honestly unknown rather than zero.
    should(groupedBody.index.tokenSessions).equal(0);
    should(
      groupedBody.kind === 'aggregate' ? groupedBody.results.map(row => row.equivalentApiCostUsdMicros.value) : [],
    ).deepEqual([null]);
    should(rawBody.kind).equal('raw');
    should(rawBody.kind === 'raw' ? rawBody.results.map(row => [row.id, row.cwd]) : []).deepEqual([
      ['wire-done', home],
    ]);
    // The rows came out of a real materialisation in this daemon's own state home, not a per-request
    // derivation: the file the boot pass wrote is on disk under the index directory.
    should(await Bun.file(join(home, 'state', 'index', 'analytics.sqlite')).exists()).be.true();
    should(groupedBody.index.schemaVersion).equal(4);
    // A malformed query is the caller's mistake, not a 500 from the daemon.
    should(refused.status).equal(400);
    should((await refused.json()) as { code: string }).have.property('code', 'invalid_query');
    // Longer than the suite default because this case waits for a background pass rather than for a
    // request: it boots a real daemon, lets the ingestion sweep catch up, and only then asks.
  }, 30_000);

  /**
   * Pricing configuration stays live for the lifetime of one daemon.
   *
   * This journey starts with a finished session whose real Claude transcript proves token usage but
   * whose daemon has no applicable rate. It then PATCHes the mounted pricing route and asks the exact
   * ingestion instance that boot mounted to sweep again. The same stored row becoming priced proves
   * that a pass reads the current configuration document rather than a catalog captured at startup.
   */
  it('should apply a pricing PATCH to a later analytics ingest without restarting', async () => {
    // Arrange
    const home = await tempDirectory('fyd-analytics-live-pricing');
    const cleanups: Array<() => void | Promise<void>> = [];
    const sessionId = 'wire-priced-later';
    let release = (): void => {};
    let mounted: ReturnType<DaemonWorld['createSubsystems']> | undefined;
    const baseWorld = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    const createSubsystems = baseWorld.createSubsystems;
    const world: DaemonWorld = {
      ...baseWorld,
      createSubsystems: (...args: Parameters<DaemonWorld['createSubsystems']>) => {
        const subsystems = createSubsystems(...args);
        mounted = subsystems;
        return subsystems;
      },
    };
    await seedSession(home, '2026-07-30T09:00:00.000Z', sessionId, {
      status: 'completed',
      turn: 1,
      startedAt: '2026-07-30T09:00:00.000Z',
      finishedAt: '2026-07-30T09:01:00.000Z',
    });
    const harnessHome = join(home, 'harness');
    const transcriptDirectory = join(harnessHome, 'projects', 'analytics-pricing');
    const transcriptFile = join(transcriptDirectory, 'session.jsonl');
    await mkdir(transcriptDirectory, { recursive: true });
    await writeFile(
      transcriptFile,
      `${JSON.stringify({
        type: 'assistant',
        sessionId: '11111111-1111-4111-8111-111111111111',
        uuid: 'pricing-usage-1',
        timestamp: '2026-07-30T09:00:30.000Z',
        message: {
          id: 'pricing-message-1',
          role: 'assistant',
          model: 'claude-opus-5',
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: 'text', text: 'priced after configuration changes' }],
        },
      })}\n`,
      { mode: 0o600 },
    );
    const configFile = join(home, 'state', 'sessions', sessionId, 'config.json');
    await writeFile(
      configFile,
      JSON.stringify({
        ...(JSON.parse(await readFile(configFile, 'utf8')) as object),
        transcript: {
          v: 1,
          home: harnessHome,
          harnessSessionId: '11111111-1111-4111-8111-111111111111',
          identity: 'minted',
          file: transcriptFile,
          resolvedAt: '2026-07-30T09:00:05.000Z',
        },
      }),
      { mode: 0o600 },
    );
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    const base = `http://127.0.0.1:${String(port)}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`${base}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const analytics = `${base}/v1/analytics?q=${encodeURIComponent('sum by (id)')}`;
    const settledAnalytics = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = AnalyticsResponseSchema.parse(
          await fetch(analytics, { headers }).then(async response => await response.json()),
        );
        if (current.index.sessions === 1 && !current.index.refreshing) return current;
        await Bun.sleep(50);
      }
      throw new Error('the analytics index did not settle on the finished transcript');
    };

    // Act
    const before = await settledAnalytics();
    const pricingResponse = await fetch(`${base}/v1/analytics/pricing`, { headers });
    const pricing = AnalyticsPricingViewSchema.parse(await pricingResponse.json());
    const patchResponse = await fetch(`${base}/v1/analytics/pricing`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedCatalogFingerprint: pricing.catalogFingerprint,
        operations: [
          {
            op: 'upsert',
            rate: {
              pricingKey: 'manual:claude-opus-5:2026-07',
              modelId: 'claude-opus-5',
              aliases: [],
              provider: 'anthropic',
              currency: 'USD',
              rates: {
                input: 1_000_000,
                output: 2_000_000,
                cachedInput: 100_000,
                cacheWrite: null,
                cacheWrite5m: null,
                cacheWrite1h: null,
                reasoning: null,
                image: null,
                tool: null,
              },
              source: { kind: 'manual' },
              validFrom: '2026-07-01T00:00:00.000Z',
              validThrough: null,
              verifiedAt: '2026-08-06T00:00:00.000Z',
              lastSyncedAt: null,
            },
          },
        ],
      }),
    });
    const patched = AnalyticsPricingViewSchema.parse(await patchResponse.json());
    if (mounted === undefined) throw new Error('boot did not construct the mounted subsystems');
    const sweep = await mounted.analyticsIngest.ingest();
    const after = AnalyticsResponseSchema.parse(
      await fetch(analytics, { headers }).then(async response => await response.json()),
    );
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(pricingResponse.status).equal(200);
    should(pricing.catalog).be.empty();
    should(before.index.tokenSessions).equal(1);
    should(
      before.kind === 'aggregate' ? before.results.map(row => row.equivalentApiCostUsdMicros.value) : [],
    ).deepEqual([null]);
    should(patchResponse.status).equal(200);
    should(patched.catalog.map(rate => rate.pricingKey)).deepEqual(['manual:claude-opus-5:2026-07']);
    should(sweep.ingested).equal(1);
    should(after.index.tokenSessions).equal(1);
    // 100 input tokens at $1/M plus 10 output tokens at $2/M = 120 USD micros.
    should(after.kind === 'aggregate' ? after.results.map(row => row.equivalentApiCostUsdMicros.value) : []).deepEqual([
      120,
    ]);
  }, 30_000);

  /**
   * The terminal lifecycle, driven through the production composition root over a real socket.
   *
   * Only the tmux runtime is substituted, at the seam `DaemonWorld` already exposes for exactly this:
   * spawning shells on a test machine is not something a suite may do, and the tmux adapter has its
   * own integration coverage. Everything above it is production — the lifecycle service, the error
   * translation, the routes, and the session resolver reading the real config document — so the cwd
   * a terminal opens in is the one the state home actually records for that session.
   */
  it('should open, retitle, list and close a terminal through the mounted lifecycle', async () => {
    // Arrange
    const home = await tempDirectory('fyd-terminals');
    const cleanups: Array<() => void | Promise<void>> = [];
    const runtime = new RecordingTerminalRuntime();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      terminalRuntime: runtime,
    };
    await seedSession(home, '2026-07-31T09:00:00.000Z');
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const base = `http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/terminals`;

    // Act
    const created = await fetch(base, { method: 'POST', headers });
    const opened = TerminalViewSchema.parse(await created.json());
    const renamed = await fetch(`${base}/${opened.id}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Deploy log' }),
    });
    const listed = await fetch(base, { headers });
    const listedBody = TerminalListViewSchema.parse(await listed.json());
    const absent = await fetch(`http://127.0.0.1:${port}/v1/sessions/nope/terminals`, { headers });
    const closed = await fetch(`${base}/${opened.id}`, { method: 'DELETE', headers });
    const afterClose = TerminalListViewSchema.parse(await (await fetch(base, { headers })).json());
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(created.status).equal(201);
    // The terminal opened in the SESSION's working directory, read from its real config document.
    should(runtime.opened.map(record => [record.ownerId, record.root])).deepEqual([[SESSION_ID, home]]);
    should(renamed.status).equal(200);
    should(TerminalViewSchema.parse(await renamed.json()).title).equal('Deploy log');
    // The retitle reached the runtime, so it survives a process that re-reads tmux rather than a map.
    should(listedBody.terminals.map(row => [row.id, row.title])).deepEqual([[opened.id, 'Deploy log']]);
    // A session the index does not hold cannot have a terminal opened against it.
    should(absent.status).equal(404);
    should(closed.status).equal(200);
    should(await closed.json()).deepEqual({ closed: true, id: opened.id });
    should(afterClose.terminals).be.empty();
    should(runtime.killed).deepEqual([opened.id]);
  });

  /**
   * The terminal STREAM, driven through the production composition root over a real WebSocket.
   *
   * This is the case the unit tier cannot be. Everything between the client and tmux is production:
   * the bound host switches the protocol, `ApiSocketDispatcher` authenticates the upgrade off the
   * loopback query-parameter token a browser is limited to, the mount proves the terminal exists
   * BEFORE the switch, and `TerminalStreamBridge` polls the pane and writes the viewer's keystrokes
   * through the SAME lifecycle service the HTTP routes use. Only the tmux pane is substituted.
   */
  it('should carry pane bytes out and keystrokes in over a real terminal socket', async () => {
    // Arrange
    const home = await tempDirectory('fyd-terminal-stream');
    const cleanups: Array<() => void | Promise<void>> = [];
    const runtime = new RecordingTerminalRuntime();
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      terminalRuntime: runtime,
    };
    await seedSession(home, '2026-07-31T09:00:00.000Z');
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const base = `http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/terminals`;
    const opened = TerminalViewSchema.parse(
      await (
        await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' } })
      ).json(),
    );

    // Act
    // A socket aimed at a terminal nobody opened is refused on the HANDSHAKE, so the client sees a
    // failed upgrade rather than a socket that dies for reasons it cannot name.
    const absent = await fetch(`${base}/0123456789ab/stream?token=${token}`, {
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      },
    }).catch(() => undefined);
    const viewer = new WebSocket(
      `ws://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/terminals/${opened.id}/stream?token=${token}`,
    );
    viewer.binaryType = 'arraybuffer';
    const frames: string[] = [];
    const closes: number[] = [];
    viewer.addEventListener('message', event => {
      frames.push(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
    });
    viewer.addEventListener('close', event => closes.push(event.code));
    await new Promise<void>((resolve, reject) => {
      viewer.addEventListener('open', () => resolve());
      viewer.addEventListener('error', () => reject(new Error('the terminal socket never opened')));
    });
    for (let attempt = 0; attempt < 200 && frames.length === 0; attempt += 1) await Bun.sleep(10);
    viewer.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    viewer.send(new TextEncoder().encode('echo hi\r'));
    for (let attempt = 0; attempt < 200 && runtime.written.length === 0; attempt += 1) await Bun.sleep(10);
    const resized = TerminalViewSchema.parse(
      await (
        await fetch(`${base}/${opened.id}`, {
          headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
        })
      ).json(),
    );
    release();
    const code = await exit;
    await runCleanups(cleanups);
    for (let attempt = 0; attempt < 200 && closes.length === 0; attempt += 1) await Bun.sleep(10);

    // Assert
    should(code).equal(0);
    // The upgrade was authenticated by the query-parameter token alone, which is all a browser
    // `WebSocket` can carry, and the first frame is the pane as tmux would draw it: a complete redraw,
    // because nothing has been sent before it to be a delta against.
    should(frames[0]).equal('\u001b[3J\u001b[2J\u001b[Hready $ \u001b[1;9H');
    // The keystrokes reached the real pane through the lifecycle service.
    should(runtime.written).deepEqual(['echo hi\r']);
    // The resize control frame was parsed with the protocol's own schema and applied to the pane, so
    // a later HTTP read of the same terminal reports the new geometry.
    should([resized.cols, resized.rows]).deepEqual([100, 30]);
    // A stream aimed at a terminal that does not exist never becomes a socket.
    should(absent?.status).equal(404);
    // Shutdown ended the stream rather than leaving a redraw timer firing at a dead socket.
    should(closes).deepEqual([1000]);
  });

  /**
   * The live event feed, driven through the production composition root over a real WebSocket.
   *
   * This is the case no unit test can be. Everything between the client and the journal is
   * production: the bound host switches the protocol, `ApiSocketDispatcher` authenticates the upgrade
   * off the loopback query-parameter token a browser is limited to, the mount settles the scope
   * BEFORE the switch, and the events come out of the real durable journal through the real SQLite
   * index — including the append the daemon itself makes while the socket is already open.
   *
   * The live half is the reason the whole feed exists. A socket that served only a backlog is a
   * slower `GET /v1/sessions/:id/events`, and every reader would have to keep polling anyway.
   */
  it('should carry backlog and then live journal events over a real event socket', async () => {
    // Arrange
    const home = await tempDirectory('fyd-event-stream');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = {
      ...(await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      })),
      sessionLauncher: new RecordingSessionLauncher(),
    };
    // A quiet session with real durable history and no lifecycle record: it never starts, never
    // stops, and exists so the fleet form can be told apart from the per-session one.
    await seedSession(home, '2026-07-30T09:00:00.000Z', 'wire-quiet');
    await seedEvents(home, 'wire-quiet', ['session.created']);
    await seedFleet(home);
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    // A real started session, so the live half has a lifecycle the daemon can actually transition.
    const started = SessionViewSchema.parse(
      await (
        await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', 'x-fy-request-id': 'req-events-1' },
          body: JSON.stringify({ agent: WRAPPER, mode: 'auto', prompt: 'stream my events', cwd: home }),
        })
      ).json(),
    );
    const live = started.config.id;

    /** Opens one real socket and records every frame the protocol accepts from it. */
    const follow = async (query: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events?token=${token}${query}`);
      const frames: FyEventStreamFrame[] = [];
      const closes: number[] = [];
      socket.addEventListener('message', event => {
        frames.push(FyEventStreamFrameSchema.parse(JSON.parse(String(event.data))));
      });
      socket.addEventListener('close', event => closes.push(event.code));
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', () => reject(new Error('the event socket never opened')));
      });
      return { frames, closes };
    };
    /** The events one socket was given, as `sessionId/sequence`. */
    const delivered = (frames: readonly FyEventStreamFrame[]): string[] =>
      frames.filter(frame => frame.kind === 'event').map(frame => `${frame.event.sessionId}/${frame.event.sequence}`);

    // Act
    // Every refusal a client can be told with a STATUS is settled on the handshake, so a failed
    // upgrade is legible instead of a socket that dies for reasons it cannot name.
    const handshake = async (query: string): Promise<number | undefined> =>
      (
        await fetch(`http://127.0.0.1:${port}/v1/events${query}`, {
          headers: {
            upgrade: 'websocket',
            connection: 'upgrade',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
          },
        }).catch(() => undefined)
      )?.status;
    const anonymous = await handshake('');
    const unknownSession = await handshake(`?token=${token}&sessionId=nobody`);
    const fleetCursor = await handshake(`?token=${token}&after=5`);

    const fleet = await follow('');
    const follower = await follow(`&sessionId=${live}`);
    for (let attempt = 0; attempt < 200 && fleet.frames.length < 2; attempt += 1) await Bun.sleep(10);
    const fleetBacklog = delivered(fleet.frames);
    const followerBacklog = delivered(follower.frames);
    // A journal append the DAEMON makes, with both sockets already open.
    const stopped = await fetch(`http://127.0.0.1:${port}/v1/sessions/${live}/stop`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'the stream has what it needs' }),
    });
    for (let attempt = 0; attempt < 200 && delivered(fleet.frames).length <= fleetBacklog.length; attempt += 1)
      await Bun.sleep(10);
    for (let attempt = 0; attempt < 200 && delivered(follower.frames).length <= followerBacklog.length; attempt += 1)
      await Bun.sleep(10);
    const fleetFinal = delivered(fleet.frames);
    const followerFinal = delivered(follower.frames);
    release();
    const code = await exit;
    await runCleanups(cleanups);
    for (let attempt = 0; attempt < 200 && (fleet.closes.length === 0 || follower.closes.length === 0); attempt += 1)
      await Bun.sleep(10);

    // Assert
    should(code).equal(0);
    should(stopped.status).equal(200);
    // The handshake refusals: no token at all, a session the index does not hold, and a fleet cursor
    // there is no global sequence domain for.
    should(anonymous).equal(401);
    should(unknownSession).equal(404);
    should(fleetCursor).equal(400);
    // The fleet backlog is real durable history from MORE THAN ONE session, which is the capability
    // the per-session replay route cannot provide at all.
    should(fleetBacklog).containEql('wire-quiet/1');
    should(new Set(fleetBacklog.map(entry => entry.split('/')[0])).size).be.above(1);
    // The per-session socket carries that session and nothing else, from the same one feed.
    should(followerBacklog.every(entry => entry.startsWith(`${live}/`))).be.true();
    should(followerBacklog).not.containEql('wire-quiet/1');
    // The live half. An append the daemon made after both sockets opened reached both of them —
    // without it this feed would just be a slower `GET /v1/sessions/:id/events`.
    should(fleetFinal.length).be.above(fleetBacklog.length);
    should(followerFinal.length).be.above(followerBacklog.length);
    should(followerFinal.every(entry => entry.startsWith(`${live}/`))).be.true();
    // Nothing arrived twice and nothing went backwards on either socket.
    for (const entries of [fleetFinal, followerFinal]) should(new Set(entries).size).equal(entries.length);
    // Shutdown ended both feeds rather than leaving journal listeners attached to dead sockets.
    should([fleet.closes, follower.closes]).deepEqual([[1000], [1000]]);
  });

  /**
   * The configuration stream, driven through the production composition root over a real WebSocket.
   *
   * The bug this exists for: an open app showed the logins and runtimes it read once, and a change made
   * anywhere else — a hand edit, `fy`, another device — never reached it until the whole app was
   * reloaded. So both halves are real here: the watcher finding a YAML file a person saved by hand, and
   * another client's edit through the editor route, each reaching an already-open socket as one frame
   * naming what moved, and the runtime read afterwards answering the new runtime.
   */
  it('should tell an open config stream about a hand-edited runtime and another client edit', async () => {
    // Arrange
    const home = await tempDirectory('fyd-config-stream');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    // READY, not merely serving: the hand edits below must land after the configuration watcher's first
    // load, or a load that runs between two of the writes splits one edit across two frames.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const liveness = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
      const body = (await liveness?.json().catch(() => undefined)) as { boot?: { phase?: string } } | undefined;
      if (body?.boot?.phase === 'ready') break;
      await Bun.sleep(25);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events?token=${token}&topic=config`);
    const frames: ConfigChangeFrame[] = [];
    const closes: number[] = [];
    socket.addEventListener('message', event => {
      frames.push(ConfigChangeFrameSchema.parse(JSON.parse(String(event.data))));
    });
    socket.addEventListener('close', event => closes.push(event.code));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('the config socket never opened')));
    });
    for (let attempt = 0; attempt < 200 && frames.length === 0; attempt += 1) await Bun.sleep(10);
    type Change = Extract<ConfigChangeFrame, { readonly kind: 'config' }>;
    /** Wait for a change frame naming `kind`, past the watcher's one-second fingerprint and its debounce. */
    const changeNaming = async (kind: ConfigChangeKind): Promise<Change | undefined> => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const found = frames.find((frame): frame is Change => frame.kind === 'config' && frame.kinds.includes(kind));
        if (found !== undefined) return found;
        await Bun.sleep(10);
      }
      return undefined;
    };

    // Act — a person saves three files by hand, the way `fy` or an editor would write them.
    const config = join(home, 'config');
    await mkdir(join(config, 'logins'), { recursive: true });
    await mkdir(join(config, 'profiles'), { recursive: true });
    await mkdir(join(config, 'runtimes'), { recursive: true });
    await writeFile(join(config, 'logins', 'you.yaml'), 'harness: claude\nstore: host\n', { mode: 0o600 });
    await writeFile(join(config, 'profiles', 'default.yaml'), 'contents: []\n', { mode: 0o600 });
    await writeFile(join(config, 'runtimes', 'hand-made.yaml'), 'credential: you\nprofile: default\nagent: true\n', {
      mode: 0o600,
    });
    const handEdit = await changeNaming('runtimes');
    const runtimes = await (await fetch(`http://127.0.0.1:${port}/v1/fleet/runtimes`, { headers })).json();
    // Another client edits `voice.yaml` through the editor route, as a second device would.
    const edited = await fetch(`http://127.0.0.1:${port}/v1/config/file`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json', 'if-match': 'absent' },
      body: JSON.stringify({ path: 'voice.yaml', text: 'defaultEngine: browser\n' }),
    });
    const editorChange = await changeNaming('voice');
    release();
    const code = await exit;
    await runCleanups(cleanups);
    for (let attempt = 0; attempt < 200 && closes.length === 0; attempt += 1) await Bun.sleep(10);

    // Assert
    should(code).equal(0);
    // The first frame is where the revision stood when the socket opened, naming nothing.
    should(frames[0]).match({ kind: 'config', revision: 0, kinds: [] });
    should(handEdit).match({ kind: 'config' });
    should(handEdit?.kinds).containDeep(['files', 'credentials', 'profiles', 'runtimes']);
    should(handEdit?.kinds).not.containEql('voice');
    should(JSON.stringify(runtimes)).containEql('hand-made');
    should(edited.status).equal(200);
    should(editorChange?.kinds).containDeep(['files', 'voice']);
    should(editorChange?.kinds).not.containEql('runtimes');
    // One boot, one counter that only moves forward.
    should(new Set(frames.map(frame => frame.epoch)).size).equal(1);
    const revisions = frames.map(frame => frame.revision);
    should(revisions).deepEqual([...revisions].sort((left, right) => left - right));
    should(closes).deepEqual([1000]);
  });

  /**
   * The attach proof, driven through the production composition root over a real socket.
   *
   * No tmux is involved and none may be: the daemon holds no pane registration for a seeded session,
   * so the refusal is decided from the durable registry before anything is observed. That is exactly
   * what makes this a reachability case — the route answered `unknown_route` before it was mounted,
   * and a refusal proves the mount, its loopback rule and its scope are all really there.
   */
  it('should refuse an attach for a session with no proven pane, over the mounted route', async () => {
    // Arrange
    const home = await tempDirectory('fyd-attach');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    await seedSession(home, '2026-07-31T09:00:00.000Z');
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const attach = `http://127.0.0.1:${port}/v1/sessions`;

    // Act
    const unproven = await fetch(`${attach}/${SESSION_ID}/attach`, { headers });
    const unprovenBody = (await unproven.json()) as { code: string };
    const absent = await fetch(`${attach}/nobody/attach`, { headers });
    const unauthenticated = await fetch(`${attach}/${SESSION_ID}/attach`);
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // Mounted and reached: an unmounted route answers `unknown_route`, never a named attach refusal.
    should(unproven.status).equal(409);
    should(unprovenBody.code).equal('attach_registration_missing');
    should(unproven.headers.get('cache-control')).equal('no-store');
    // The session's existence is still settled before any pane evidence is gathered.
    should(absent.status).equal(404);
    should(unauthenticated.status).equal(401);
  });

  /**
   * Callsign suggestions, driven through the production composition root over a real socket.
   *
   * The claim set is not a fixture: it is derived from the `teammate` recorded in a real session's
   * configuration document, which is what makes "this name is taken" a fact rather than a guess.
   */
  it('should never suggest a callsign a live session already answers to', async () => {
    // Arrange
    const home = await tempDirectory('fyd-names');
    const cleanups: Array<() => void | Promise<void>> = [];
    // `/healthz` only proves the socket is live. It can answer before boot reaches `untilShutdown`,
    // so install the shutdown latch before starting instead of racing a late `release` assignment.
    const shutdown = Promise.withResolvers<void>();
    const world = await worldAt(home, OS_CHOSEN_PORT, () => shutdown.promise);
    await seedSession(home, new Date().toISOString());
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };

    // Act
    const answered = await fetch(`http://127.0.0.1:${port}/v1/names?count=8`, { headers });
    const names = NameSuggestionsSchema.parse(await answered.json());
    const refused = await fetch(`http://127.0.0.1:${port}/v1/names?count=0`, { headers });
    shutdown.resolve();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(answered.status).equal(200);
    should(names).have.length(8);
    should(new Set(names).size).equal(8);
    // The seeded session took this callsign minutes ago, so the pool must not offer it back.
    should(names).not.containEql(SEEDED_CALLSIGN);
    // Every suggestion is a real pool entry, not something the route invented.
    should(names.every(name => DEFAULT_CALLSIGN_POOL.includes(name))).be.true();
    should(refused.status).equal(400);
  });

  /**
   * The learning review board, driven through the production composition root over a real socket.
   *
   * Nothing is faked but the shutdown signal. The evidence is written into the state home in the
   * exact on-disk shape `FileLearningStore` owns — a JSONL append log and a JSON board — which is the
   * contract the daemon shares with whoever produces it, and then every answer comes back through the
   * real store, the real policy and the real routes.
   *
   * It proves the mount DOES ITS JOB rather than merely existing: the counters are recomputed from
   * the evidence on disk, a verdict rewrites the board durably, the rejection writes the tombstone
   * that stops the rule coming back, and the accepted patch lands inside the state home rather than
   * anywhere near the operator's own guidance file.
   */
  it('should serve, judge and durably record learning proposals through the mounted board', async () => {
    // Arrange
    const home = await tempDirectory('fyd-learning');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    const learningHome = join(home, 'state', 'learning');
    await mkdir(learningHome, { recursive: true, mode: 0o700 });
    const evidence = (id: string, sessionId: string, repo: string, quote: string): string =>
      JSON.stringify({
        id,
        sessionId,
        mode: 'auto',
        cwd: home,
        repo,
        at: '2026-07-30T09:00:00.000Z',
        kind: 'correction',
        gist: 'run the repo task surface',
        quote,
        source: 'human',
        verified: true,
        runId: 'run-1',
      });
    await writeFile(
      join(learningHome, 'observations.jsonl'),
      `${evidence('obs_1', 'wire-1', 'ferretry', 'use task test')}\n${evidence('obs_2', 'wire-2', 'kteam', 'not bun test')}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(learningHome, 'proposals.json'),
      JSON.stringify([
        {
          id: 'proposal_a',
          category: 'global',
          state: 'pending',
          title: 'Always run the repo task surface',
          ruleText: 'Run `task test` rather than invoking the test runner directly.',
          target: { kind: 'global-agent-guidance', path: 'guidance.md', anchor: '## Agent rules' },
          // Claims three observations; only two exist, so the counters must come down.
          observationIds: ['obs_1', 'obs_2', 'obs_gone'],
          occurrences: 9,
          crossRepoCount: 7,
          firstSeen: '2026-07-30T09:00:00.000Z',
          lastSeen: '2026-07-30T09:00:00.000Z',
          identity: 'always-run-the-repo-task-surface',
          history: [{ at: '2026-07-30T09:00:00.000Z', event: 'proposed:run-1', by: 'miner' }],
        },
        {
          id: 'proposal_b',
          category: 'global',
          state: 'pending',
          title: 'Never bypass the commit hooks',
          ruleText: 'Do not pass --no-verify.',
          target: { kind: 'automation-guidance', path: 'automation.md' },
          observationIds: ['obs_2'],
          occurrences: 1,
          crossRepoCount: 1,
          firstSeen: '2026-07-30T09:00:00.000Z',
          lastSeen: '2026-07-30T09:00:00.000Z',
          identity: 'never-bypass-the-commit-hooks',
          history: [{ at: '2026-07-30T09:00:00.000Z', event: 'proposed:run-1', by: 'miner' }],
        },
      ]),
      { mode: 0o600 },
    );
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const learning = `http://127.0.0.1:${port}/v1/learning`;
    const judge = async (id: string, body: unknown): Promise<Response> =>
      await fetch(`${learning}/proposals/${id}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Act
    const status = LearningStatusSchema.parse(await (await fetch(`${learning}/status`, { headers })).json());
    const config = LearningConfigSchema.parse(await (await fetch(`${learning}/config`, { headers })).json());
    const listed = z.array(ProposalViewSchema).parse(await (await fetch(`${learning}/proposals`, { headers })).json());
    const accepted = ProposalViewSchema.parse(await (await judge('proposal_a', { action: 'accept' })).json());
    const rejected = ProposalViewSchema.parse(
      await (await judge('proposal_b', { action: 'reject', note: 'covered by the hook' })).json(),
    );
    const patch = LearningPatchResponseSchema.parse(
      await (await fetch(`${learning}/proposals/proposal_a/patch`, { headers })).json(),
    );
    const run = await fetch(`${learning}/run`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ spawn: false }),
    });
    const pendingAfter = z
      .array(ProposalViewSchema)
      .parse(await (await fetch(`${learning}/proposals?state=pending`, { headers })).json());
    // Read back off disk, which is the only thing that proves the verdicts are durable.
    const board = JSON.parse(await readFile(join(learningHome, 'proposals.json'), 'utf8')) as {
      id: string;
      state: string;
    }[];
    const tombstones = JSON.parse(await readFile(join(learningHome, 'tombstones.json'), 'utf8')) as {
      identity: string;
    }[];
    const patchFiles = await readdir(join(learningHome, 'patches'));
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // Mining is mounted; an ingest-only request still leaves no run manifest when no miner has
    // produced output, which is distinct from reporting the subsystem unavailable.
    should(config.enabled).be.true();
    should(status.enabled).be.true();
    should(status.running).be.false();
    should(status.lastRun).be.undefined();
    should(status.totals).deepEqual({ observations: 2, proposals: 2, tombstones: 0 });
    should(status.pending).deepEqual({ total: 2, strong: 0, weak: 2 });
    // The counters came down to the evidence that actually exists on disk.
    should(listed.map(view => [view.id, view.occurrences, view.crossRepoCount])).deepEqual([
      ['proposal_a', 2, 2],
      ['proposal_b', 1, 1],
    ]);
    should(listed[0]?.evidence.map(entry => entry.quote)).deepEqual(['use task test', 'not bun test']);
    should(accepted.state).equal('accepted');
    should(rejected.state).equal('rejected');
    // Both verdicts survived into the file, which a response alone would not prove.
    should(board.map(entry => [entry.id, entry.state])).deepEqual([
      ['proposal_a', 'accepted'],
      ['proposal_b', 'rejected'],
    ]);
    should(tombstones.map(entry => entry.identity)).deepEqual(['never-bypass-the-commit-hooks']);
    should(pendingAfter).be.empty();
    // The patch is the rule as a document aimed at the operator's file — not that file rewritten.
    should(patch.path).equal('guidance.md');
    should(patch.contents).containEql('Run `task test`');
    // What the human agreed to was recorded INSIDE the state home and nowhere else.
    should(patchFiles.some(file => file.startsWith('always-run-the-repo-task-surface-'))).be.true();
    // An ingest-only run is mounted: with no miner output it reports an explicit empty manifest.
    should(run.status).equal(200);
    should(RunManifestSchema.parse(await run.json()).message).equal('ingest-only run (no spawn requested)');
  });

  /**
   * The daemon's own health, driven through the production composition root over a real socket.
   *
   * This is the mount that turns a BROKEN surface into a working one, so the proof is the CLI's own
   * probe: `ProtocolDaemonHealth` parses `/v1/health` against `HealthViewSchema` and treats a parse
   * failure as "the daemon did not answer". Against the previous three-field liveness body it always
   * failed, so `fy daemon status` reported a serving daemon as unreachable and `DirectSupervisor` had
   * no pid to signal. Parsing the response with that same schema here is the whole assertion.
   *
   * Nothing is faked but the shutdown signal. The counts come from the real session index, the ledger
   * from the self-check `start` actually ran before it bound the port, and the version from the
   * daemon's own package.
   */
  /**
   * The human browser-login window, driven through the production composition root over a real socket.
   *
   * The read half runs against the PRODUCTION window — the one `buildWorld` builds, over the real
   * `BrowserProfileStore` in the real state home — because asking a closed window for its status
   * spawns nothing. That alone is what `fy browser login` and the PWA's banner have been unable to do
   * since they were ported: the route answered `unknown_route`.
   *
   * The write half swaps the runtime beneath the same production window, because a `start` genuinely
   * launches an X server, a Chrome and a VNC listener, and a test suite must never put those on the
   * host. Everything else stays real, so what this proves is the job rather than the construction:
   * the profile is leased inside the state home, the argv Chrome would have been launched with is the
   * domain's own, and the human's "I signed in" is written to a primed marker a LATER read reports.
   */
  it('should serve, open and prime the human login window through the mounted subsystem', async () => {
    // Arrange
    const home = await tempDirectory('fyd-browser-login');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const base = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    // The production status read, before anything is substituted: proof the route the boot mounts is
    // answered by the real profile store over this home.
    const production = await base.browserLogin.window.status();
    const runtime = new RecordingLoginRuntime();
    const world = {
      ...base,
      browserLogin: {
        window: new BrowserLoginWindowService({ profile: new BrowserProfileStore(home), runtime }),
        close: async () => undefined,
      },
    };
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const json = { ...headers, 'content-type': 'application/json' };
    const url = `http://127.0.0.1:${port}/v1/browser/login`;
    const act = (body: unknown) => fetch(url, { method: 'POST', headers: json, body: JSON.stringify(body) });

    // Act
    const closed = await fetch(url, { headers });
    const closedBody = BrowserLoginStatusSchema.parse(await closed.json());
    const opened = await act({ action: 'start', minutes: 20 });
    const openedBody = BrowserLoginStatusSchema.parse(await opened.json());
    const whileOpen = BrowserLoginStatusSchema.parse(await (await fetch(url, { headers })).json());
    const tooLong = await act({ action: 'start', minutes: 600 });
    const stopped = await act({ action: 'stop', primed: true });
    const stoppedBody = BrowserLoginStatusSchema.parse(await stopped.json());
    const afterPrime = BrowserLoginStatusSchema.parse(await (await fetch(url, { headers })).json());
    const confirmWithNoWindow = await act({ action: 'confirm' });
    // The per-session browser surface is now mounted. This home has no such session, so the real
    // runtime names the absent session rather than reviving the old unmounted-runtime 501.
    const automation = await fetch(`http://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/browser`, { headers });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // The production window, over the real profile store: nothing has ever been signed in here.
    should(production).deepEqual({ state: 'closed', profilePrimed: false });
    should(closed.status).equal(200);
    should(closedBody).deepEqual({ state: 'closed', profilePrimed: false });
    // A window a person can actually connect to: loopback only, with the tunnel they must open.
    should(opened.status).equal(200);
    should(openedBody.state).equal('open');
    should(openedBody.state === 'open' ? openedBody.connection : undefined).deepEqual({
      host: '127.0.0.1',
      port: 5_912,
      password: openedBody.state === 'open' ? openedBody.connection.password : '',
      sshTunnel: 'ssh -N -L 5912:127.0.0.1:5912 operator@boot-host',
    });
    // The minutes the caller asked for are the minutes the window expires after.
    should(openedBody.state === 'open' ? Date.parse(openedBody.expiresAt) - Date.parse(openedBody.openedAt) : 0).equal(
      20 * 60_000,
    );
    // A second read sees the SAME window rather than opening another: the subsystem is one instance
    // the boot constructed, not one per request.
    should(whileOpen).deepEqual(openedBody);
    // Chrome was launched into the daemon's own private profile, on the display the runtime owns, with
    // the sign-in page the domain names.
    should(runtime.spawned[0]?.[0]).equal('/usr/bin/google-chrome');
    should(runtime.spawned[0]).containEql(`--user-data-dir=${join(home, 'browser', 'profile')}`);
    should(runtime.spawned[0]).containEql('https://accounts.google.com/');
    // The VNC server is supervised by `timeout` for exactly the window's own duration.
    should(runtime.spawned[1]?.slice(0, 4)).deepEqual(['/usr/bin/timeout', '--signal=TERM', '--kill-after=10', '1200']);
    // A duration the contract refuses never reaches the host.
    should(tooLong.status).equal(400);
    should(stopped.status).equal(200);
    should(stoppedBody).deepEqual({ state: 'closed', profilePrimed: true });
    // The human's verdict is DURABLE, not in memory: a later read over the real state home reports it,
    // and the marker is a file inside the daemon's own browser directory.
    should(afterPrime).deepEqual({ state: 'closed', profilePrimed: true });
    should(await readdir(join(home, 'browser'))).containEql('profile.primed.json');
    // Both processes were released when the window closed, VNC before Chrome.
    should(runtime.terminated).deepEqual(['vnc', 'chrome']);
    // Confirming a window that is not open is a statement about the WINDOW, not about the request, so
    // it travels as the domain classified it: this daemon has no window to confirm.
    should(confirmWithNoWindow.status).equal(503);
    should((await confirmWithNoWindow.json()) as { error: string }).have.property(
      'error',
      'the human browser login window is not open',
    );
    should(automation.status).equal(404);
  });

  it('should report its own health, measured by the self-check the boot ran', async () => {
    // Arrange
    const home = await tempDirectory('fyd-health');
    const cleanups: Array<() => void | Promise<void>> = [];
    // Register the shutdown latch before boot starts. The server binds before the monitor and warden
    // loops finish arming, so `/healthz` can answer before `start` reaches `untilShutdown`; assigning a
    // release callback inside that late call races the request below and intermittently leaves `exit`
    // waiting forever.
    const shutdown = Promise.withResolvers<void>();
    const world = await worldAt(home, OS_CHOSEN_PORT, () => shutdown.promise);
    await seedSession(home, '2026-07-31T09:00:00.000Z', 'wire-live');
    await seedSession(home, '2026-07-30T09:00:00.000Z', 'wire-done', {
      status: 'completed',
      finishedAt: '2026-07-30T09:45:00.000Z',
    });
    const exit = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();

    // Act
    const liveness = await fetch(`http://127.0.0.1:${port}/healthz`);
    // No token, because the daemon commands must answer "is it up" before one exists — the state a
    // fresh `fy daemon install` leaves a host in.
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/health`);
    let answered = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
    });
    // Parsed exactly as `ProtocolDaemonHealth` parses it; a body this schema refuses is a daemon the
    // CLI reports as unreachable.
    let view = HealthViewSchema.parse(await answered.json());
    // `/healthz` proves the socket is live, not that every post-bind loop is armed. Wait for the
    // supervision fact this journey asserts so the request cannot race the final boot step.
    for (let attempt = 0; attempt < 100 && !view.wardenTimerArmed; attempt += 1) {
      await Bun.sleep(10);
      answered = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
      });
      view = HealthViewSchema.parse(await answered.json());
    }
    shutdown.resolve();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(answered.status).equal(200);
    // The fleet came from the real session index: two known, one still able to run.
    should([view.sessions, view.running]).deepEqual([2, 1]);
    // This process is the one serving, which is the fact the supervisor reads instead of a pid file.
    should(view.pid).equal(process.pid);
    should(view.ok).be.true();
    should(view.bootstrapState).equal('complete');
    // The boot ran a self-check BEFORE binding, so the very first answer is a measurement rather than
    // an empty ledger.
    should(view.lastSelfCheckAt).not.be.null();
    // The warden sweep timer IS armed now, and the report says so rather than making a running
    // supervisor look absent — the distinction this flag exists to draw.
    should(view.wardenTimerArmed).be.true();
    // Not asserted precisely: arming fires a boot sweep that is deliberately NOT awaited, so whether
    // it has completed by the time this request lands is a race. Either answer is correct — `null`
    // means "no sweep has finished yet", a number means one has — and the assertion is that it is one
    // of exactly those two rather than a fabricated zero.
    should(view.wardenLastSweepSeconds === null || view.wardenLastSweepSeconds >= 0).be.true();
    // Scratch GC IS mounted now. Enabled means the collector runs, not that it deletes: the policy
    // refuses anything that is not a daemon-owned entry, not terminal, or under the TTL, and refuses
    // outright when there is no finishedAt and no mtime to age from.
    should(view.scratchGcEnabled).be.true();
    // Liveness stays public and unchanged, so nothing that probes for it needs a token.
    should(liveness.status).equal(200);
    should((await liveness.json()) as { status: string }).have.property('status', 'ok');
    // The report answers a caller holding no credential and reports the SAME daemon, which is what
    // lets `fy daemon status` work on a host where no token has been minted yet.
    should(anonymous.status).equal(200);
    should(HealthViewSchema.parse(await anonymous.json()).pid).equal(view.pid);
  });

  /**
   * Dictation enhancement, driven through the production composition root over a real socket.
   *
   * ONE ROUTE IS LEFT. Recognition moved into the browser, so `/v1/stt/status`, `/v1/stt/models`,
   * `/v1/stt/transcribe` and the model installs are gone from the daemon along with the byte-shaped
   * table they needed. What survives is the exchange a public bundle cannot perform: repairing a
   * transcript with a hosted chat model, which takes a provider credential only this daemon holds.
   *
   * The ENHANCER is substituted and everything else is real — the boot, the credentials, the route
   * table, the dispatcher and the transport. It has to be: the production one spends the operator's
   * provider account on a call to a third party, which a test suite must never make. What is proved
   * here is the wiring the fake cannot fake — that the request reaches the enhancer with its body
   * intact, that the token is demanded, and that the deleted routes are genuinely gone rather than
   * answering something.
   */
  it('should reach the dictation enhancer and answer unknown_route for the deleted surface', async () => {
    // Arrange
    const home = await tempDirectory('fyd-stt');
    const cleanups: Array<() => void | Promise<void>> = [];
    let release = (): void => {};
    const base = await worldAt(home, OS_CHOSEN_PORT, async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    const enhancer = new RecordingSttEnhancer();
    const exit = start({ ...base, sttEnhancement: enhancer }, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(50);
    }
    const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' };
    const body = JSON.stringify({ text: 'ship the protocall package', provider: 'groq' });

    // Act
    const enhanced = await fetch(`http://127.0.0.1:${port}/v1/stt/enhance`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    });
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/stt/enhance`, { method: 'POST', body });
    // Recognition is the browser's now. Every path it used must be genuinely absent rather than
    // answering a stale surface, which is what a client reads as version skew instead of as a move.
    const removed = await Promise.all(
      ['/v1/stt/status', '/v1/stt/models', '/v1/stt/models/base.en', '/stt-models/base.en/model.bin'].map(
        async path => await fetch(`http://127.0.0.1:${port}${path}`, { headers }),
      ),
    );
    const transcribe = await fetch(`http://127.0.0.1:${port}/v1/stt/transcribe`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'audio/L16; rate=16000; channels=1' },
      body: new Uint8Array([0x00, 0xff, 0x10, 0x00]),
    });
    release();
    const code = await exit;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    // Reached: an unmounted route answers `unknown_route`, not the enhancer's own result.
    should(enhanced.status).equal(200);
    should((await enhanced.json()) as { text: string }).have.property('text', 'Ship the protocol package.');
    // The body arrived as the client sent it, and the daemon version travels like on every response.
    should(enhancer.seen).deepEqual([{ text: 'ship the protocall package', provider: 'groq' }]);
    should(enhanced.headers.get('x-fy-version')).equal(daemonVersion);
    // `admin`, over the same authorization boundary as the rest of the surface: one call spends the
    // operator's provider account.
    should(anonymous.status).equal(401);
    should([...removed, transcribe].map(response => response.status)).deepEqual([404, 404, 404, 404, 404]);
    should(((await transcribe.json()) as { code: string }).code).equal('unknown_route');
  });

  it('should release the home lock so a second boot of the same home succeeds', async () => {
    // Arrange
    const home = await tempDirectory('fyd-relock');
    const boot = async (): Promise<number> => {
      const cleanups: Array<() => void | Promise<void>> = [];
      process.env.FY_HOME = home;
      const code = await start({ ...buildIntegrationWorld(), untilShutdown: async () => {} }, cleanups);
      await runCleanups(cleanups);
      return code;
    };
    await seedHome(home, OS_CHOSEN_PORT);

    // Act
    const first = await boot();
    const second = await boot();

    // Assert
    should(first).equal(0);
    should(second).equal(0);
  });

  it('should report already-running when another owner holds the home lock, and say so', async () => {
    // Arrange
    const home = await tempDirectory('fyd-locked');
    await seedHome(home, OS_CHOSEN_PORT);
    const incumbent = await buildIntegrationWorld().storage.open();
    const cleanups: Array<() => void | Promise<void>> = [];
    const said = recordingNotices();

    // Act
    const code = await start(
      { ...buildIntegrationWorld(), notices: said.port, untilShutdown: async () => {} },
      cleanups,
    );
    await incumbent.storage.close();

    // Assert
    should(code).equal(EXIT_ALREADY_RUNNING);
    // The open failed, so the only acquisitions are the loop's heartbeat and watchdog — armed before the
    // home is opened, because opening it is a step that can stall too — and the tmux client's release.
    should(cleanups).have.length(2);
    // THE MESSAGE, not just the code: this branch used to return 78 and write nothing, so the
    // launcher pointed the operator at a log file that was empty.
    should(said.stated).have.length(1);
    should(said.stated[0]).match(/state home/u);
    should(said.stated[0]).match(/daemon\.lock/u);
  });

  it('should refuse a recorded address held by another of these daemons, and name it', async () => {
    // Arrange: an incumbent that serves this product's own health report, which is the only evidence
    // that identifies one. Nothing weaker may be believed.
    const home = await tempDirectory('fyd-incumbent');
    const incumbent = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json(healthViewFixture({ version: '9.9.9', pid: 4_242 })),
    });
    const cleanups: Array<() => void | Promise<void>> = [];
    const said = recordingNotices();
    const world = { ...(await worldAt(home, boundPort(incumbent), async () => {})), notices: said.port };

    // Act
    const code = await start(world, cleanups);
    await runCleanups(cleanups);
    await incumbent.stop(true);

    // Assert
    should(code).equal(EXIT_ALREADY_RUNNING);
    // The heartbeat, the tmux client's release, then the home — opened before the address was probed —
    // are the registered steps.
    should(cleanups).have.length(3);
    should(said.stated).have.length(1);
    should(said.stated[0]).match(/9\.9\.9/u);
    should(said.stated[0]).match(/pid 4242/u);
    should(said.stated[0]).match(/daemon stop/u);
  });

  it('should report a stranger on a recorded address as a conflict rather than as itself', async () => {
    // Arrange: exactly the reported failure — a different fleet's supervisor answering 401 on the
    // address this daemon was configured for. It answered, so the boot used to call it an incumbent
    // and exit 78 in silence.
    const home = await tempDirectory('fyd-stranger');
    const stranger = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
    });
    const cleanups: Array<() => void | Promise<void>> = [];
    const said = recordingNotices();
    // Read BEFORE the stop below: a stopped server reports port 0, and the assertions name the port.
    const strangerPort = boundPort(stranger);
    const world = { ...(await worldAt(home, strangerPort, async () => {})), notices: said.port };

    // Act
    const code = await start(world, cleanups);
    await runCleanups(cleanups);
    await stranger.stop(true);

    // Assert — a DIFFERENT non-zero code, because the remedy is different.
    should(code).not.equal(0);
    should(code).not.equal(EXIT_ALREADY_RUNNING);
    should(code).equal(EXIT_ADDRESS_CONFLICT);
    // NON-EMPTY OUTPUT is the point of this whole test: the defect was an exit code with no message.
    should(said.stated).have.length(1);
    should(said.stated[0]).match(/HTTP 401/u);
    should(said.stated[0]).match(new RegExp(`127\\.0\\.0\\.1:${String(strangerPort)}`, 'u'));
    // It names the edit that fixes it, in the file that holds it.
    should(said.stated[0]).match(/"port" in .*config\/daemon\.json/u);
  });

  it('should fail closed when the address is held by something that never answers', async () => {
    // Arrange: a listener that accepts the connection and says nothing, so identification cannot
    // complete. Booting over a live daemon because the probe was inconclusive is unrecoverable —
    // both would own state neither can see the other writing.
    const home = await tempDirectory('fyd-silent');
    const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
    const cleanups: Array<() => void | Promise<void>> = [];
    const said = recordingNotices();
    const world = { ...(await worldAt(home, silent.port, async () => {})), notices: said.port };

    // Act
    const code = await start(world, cleanups);
    await runCleanups(cleanups);
    silent.stop(true);

    // Assert
    should(code).equal(EXIT_ADDRESS_CONFLICT);
    should(said.stated).have.length(1);
    should(said.stated[0]).match(/did not answer/u);
  });

  it('should take the next free address when no port is recorded, and write the choice down', async () => {
    // Arrange: a state home that has never started a daemon, with something already on the address
    // this boot prefers. A first run has to succeed on a machine like that.
    const home = await tempDirectory('fyd-fallback');
    const { stranger: occupied, preferredPort } = await strangerBesideAFreePort(() =>
      Response.json({ error: 'unauthorized' }, { status: 401 }),
    );
    await seedHomeWithoutPort(home);
    const cleanups: Array<() => void | Promise<void>> = [];
    const said = recordingNotices();
    let release = (): void => {};
    const stopped = new Promise<void>(resolve => {
      release = resolve;
    });
    const world = buildIntegrationWorld();
    const booting = start(
      {
        ...world,
        boot: { ...world.boot, preferredPort },
        notices: said.port,
        untilShutdown: async () => await stopped,
      },
      cleanups,
    );

    // Act — the daemon answers on the address it took, which is not the one it preferred.
    let health: Response | undefined;
    for (let attempt = 0; attempt < 200 && health === undefined; attempt += 1) {
      health = await fetch(`http://127.0.0.1:${String(preferredPort + 1)}/healthz`)
        .then(answer => (answer.ok ? answer : undefined))
        .catch(() => undefined);
      if (health === undefined) await Bun.sleep(25);
    }
    const recorded = JSON.parse(await readFile(join(home, 'config', 'daemon.json'), 'utf8')) as Record<string, unknown>;
    release();
    const code = await booting;
    await runCleanups(cleanups);
    await occupied.stop(true);

    // Assert
    should(code).equal(0);
    should(health?.status).equal(200);
    // RECORDED, so it is the same address next time: a daemon whose address moves on its own is
    // worse than one that fails, and every client that learned where it lived would be wrong.
    should(recorded).have.property('port', preferredPort + 1);
    // Still nothing derived in the document, so the recorded port cannot freeze an advertisement.
    should(recorded).not.have.property('publicUrl');
    // And it said which address it skipped and why, in the log the operator is already reading.
    should(said.steps.join('\n')).match(/address in use/u);
    should(said.steps.join('\n')).match(new RegExp(`address chosen.*${String(preferredPort + 1)}`, 'u'));
  });

  it('should warn at startup when no agent harness is ready, and start anyway', async () => {
    // Arrange: a state home with no fleet manifest, which is what a fresh install looks like before
    // anyone has installed Claude Code or Codex.
    const home = await tempDirectory('fyd-no-harness');
    const cleanups: Array<() => void | Promise<void>> = [];
    const said = recordingNotices();
    let release = (): void => {};
    const stopped = new Promise<void>(resolve => {
      release = resolve;
    });
    const world = { ...(await worldAt(home, OS_CHOSEN_PORT, async () => await stopped)), notices: said.port };

    // Act
    const booting = start(world, cleanups);
    const port = await recordedPort(home);
    let health: Response | undefined;
    for (let attempt = 0; attempt < 200 && health === undefined; attempt += 1) {
      health = await fetch(`http://127.0.0.1:${String(port)}/healthz`)
        .then(answer => (answer.ok ? answer : undefined))
        .catch(() => undefined);
      if (health === undefined) await Bun.sleep(25);
    }
    release();
    const code = await booting;
    await runCleanups(cleanups);

    // Assert — IT STARTS. Someone may install a harness minutes after the daemon comes up, and a
    // daemon that refused until they had would be strictly worse than one that says what is missing.
    should(code).equal(0);
    should(health?.status).equal(200);
    // But it says so at startup rather than leaving a person to discover it as a confusing failure
    // the first time they try to launch an agent.
    should(said.steps.join('\n')).match(/harnesses checked — claude: none; codex: none/u);
    const warning = said.stated.find(message => message.includes('no agent harness is ready'));
    should(warning).be.a.String();
    // A diagnosis without a remedy leaves the reader where they were.
    should(warning).match(/run `fy daemon setup` to import it/u);
    // And it never overclaims in the other direction either.
    should(warning).match(/can serve its API but cannot start a session/u);
  });

  it('should report a harness it can launch without claiming it is signed in', async () => {
    // Arrange: a published account whose wrapper this host really can run. A one-line script named
    // `sh` stands in for a harness, so the test proves the resolution rather than requiring Claude
    // Code on the runner — and it is resolved BY PATH, never found on `PATH`, which is the whole
    // point: a service-managed daemon has no `PATH` containing the fleet's bin directory.
    const home = await tempDirectory('fyd-harness');
    await seedHome(home, OS_CHOSEN_PORT);
    await mkdir(join(home, 'bin'), { recursive: true });
    await writeFile(join(home, 'bin', 'sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await publishManifest(home, [
      {
        id: STAND_IN_ACCOUNT,
        kind: 'claude',
        mode: 'auto',
        wrapper: join(home, 'bin', 'sh'),
        home: join(home, 'homes', 'stand-in'),
        displayName: 'stand-in',
        defaultModel: 'claude-opus-5',
        models: [{ id: 'claude-opus-5', available: true }],
        available: true,
        unavailableReason: null,
      },
    ]);
    const cleanups: Array<() => void | Promise<void>> = [];
    const said = recordingNotices();
    let release = (): void => {};
    const stopped = new Promise<void>(resolve => {
      release = resolve;
    });
    const world = { ...buildIntegrationWorld(), notices: said.port, untilShutdown: async () => await stopped };

    // Act
    const booting = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${String(port)}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(25);
    }
    release();
    const code = await booting;
    await runCleanups(cleanups);

    // Assert
    should(code).equal(0);
    should(said.steps.join('\n')).match(/harnesses checked — claude: sh; codex: none/u);
    // NOTHING IS WARNED, because one harness is the bar and Codex being absent is not a fault.
    should(said.stated.filter(message => message.includes('no agent harness is ready'))).be.empty();
  });

  /**
   * THE SERVICE-MANAGER CASE, END TO END.
   *
   * A daemon started by systemd or launchd at login inherits a minimal environment rather than the
   * operator's interactive shell, so `claude` works perfectly in their terminal and is invisible
   * here. This runs the REAL composition root: the declaration is read off `config/daemon.json` by
   * the same loader a boot uses, and the milestone it produces is the one an operator will read.
   *
   * A unit test cannot prove this. It proves the decision; only a boot proves the key an operator
   * writes actually reaches it.
   */
  it('should find a harness in a declared directory and say which rule found it', async () => {
    // Arrange: a directory nothing has put on this daemon's `PATH`, holding a file named exactly as
    // the harness command is — plus an override for the OTHER harness that names nothing.
    const home = await tempDirectory('fyd-harness-declared');
    await seedHome(home, OS_CHOSEN_PORT);
    const tools = join(home, 'tools');
    await mkdir(tools, { recursive: true });
    await writeFile(join(tools, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(
      join(home, 'config', 'daemon.json'),
      daemonDocument({
        host: '127.0.0.1',
        port: OS_CHOSEN_PORT,
        harness: { searchPaths: [tools], paths: { codex: join(tools, 'not-installed') } },
      }),
      { mode: 0o600 },
    );
    const cleanups: Array<() => void | Promise<void>> = [];
    const said = recordingNotices();
    let release = (): void => {};
    const stopped = new Promise<void>(resolve => {
      release = resolve;
    });
    const world = { ...buildIntegrationWorld(), notices: said.port, untilShutdown: async () => await stopped };

    // Act
    const booting = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${String(port)}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(25);
    }
    release();
    const code = await booting;
    await runCleanups(cleanups);

    // Assert — the declared directory wins over whatever this host happened to inherit, and the
    // milestone names the file AND the rule. An operator who has just written that line has no other
    // way to find out whether this daemon read it.
    should(code).equal(0);
    should(said.steps.join('\n')).match(
      new RegExp(
        `harness commands located — claude: ${tools.replaceAll('/', '\\/')}\\/claude {2}\\(extra search path — harness\\.searchPaths\\)`,
        'u',
      ),
    );
    // And the override that names nothing is STATED rather than quietly searched around, so a person
    // who configured something is never left believing it took.
    const failure = said.stated.find(message => message.includes('harness.paths.codex'));
    should(failure).be.a.String();
    should(failure).match(/nothing else was searched/u);
    should(failure).match(/no codex session can start on this host/u);
  });

  it('should trace every boot milestone so a stall names the step it stalled on', async () => {
    // Arrange
    const home = await tempDirectory('fyd-journal');
    const cleanups: Array<() => void | Promise<void>> = [];
    const said = recordingNotices();
    let release = (): void => {};
    const stopped = new Promise<void>(resolve => {
      release = resolve;
    });
    const world = { ...(await worldAt(home, OS_CHOSEN_PORT, async () => await stopped)), notices: said.port };

    // Act
    const booting = start(world, cleanups);
    const port = await recordedPort(home);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await fetch(`http://127.0.0.1:${String(port)}/healthz`).catch(() => undefined))?.ok === true) break;
      await Bun.sleep(25);
    }
    release();
    const code = await booting;
    await runCleanups(cleanups);

    // Assert — before this trail existed, a daemon that failed and a daemon that spent ninety
    // seconds initializing successfully produced the same zero bytes.
    should(code).equal(0);
    const trail = said.steps.map(step => step.split(' — ')[0]);
    should(trail).containDeepOrdered([
      'starting',
      'state home opened',
      'configuration loaded',
      'address is free',
      // The address is bound as soon as it is decided, so liveness answers while the rest boots.
      'listening',
      'harnesses checked',
      'subsystems mounted',
      'serving',
      'ready',
    ]);
    // The state home and the address it serves are named, not merely implied.
    should(said.steps.join('\n')).match(new RegExp(home.replaceAll('/', '\\/'), 'u'));
    should(said.steps.join('\n')).match(new RegExp(`ready.*127\\.0\\.0\\.1:${String(port)}`, 'u'));
  });

  /**
   * THE CARRIER A FRESH INSTALL ACTUALLY GETS.
   *
   * The defect: the daemon dialled a rendezvous only when `config/daemon.json` carried a `relay`
   * block, and nothing has ever written one. So `fyd` bound loopback, dialled nowhere, and printed
   * one clause about it — leaving a daemon that no device but this one could reach, which is
   * indistinguishable from the owner's side from pairing being broken.
   *
   * These run through the REAL composition root: the real `start`, the real carrier, the real
   * notices. Only the directory read is substituted, at the seam the world exposes for exactly that,
   * because it is the one collaborator that talks to a service off this machine.
   */
  describe('the relay carriers a boot resolves', () => {
    it('should keep two relay WebSockets open together and stop every carrier on shutdown', async () => {
      const home = await tempDirectory('fyd-relay-plural');
      const relays = [relaySocketProbe(), relaySocketProbe()] as const;
      const relayUrls = relays.map(relay => `http://127.0.0.1:${String(boundPort(relay.server))}`);
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();
      let release = (): void => {};
      const stopped = new Promise<void>(resolve => {
        release = resolve;
      });

      try {
        await seedHome(home, OS_CHOSEN_PORT);
        await writeFile(
          join(home, 'config', 'daemon.json'),
          daemonDocument({
            carriers: [
              { kind: 'bind', host: '127.0.0.1', port: OS_CHOSEN_PORT },
              ...relayUrls.map(url => ({ kind: 'relay', url, reconnectSeconds: 3_600 })),
              { kind: 'relay', url: 'https://off.example', enabled: false },
            ],
          }),
          { mode: 0o600 },
        );
        const world = {
          ...buildIntegrationWorld(),
          notices: said.port,
          untilShutdown: async () => await stopped,
          relayDirectory: {
            read: async (): Promise<RelayAdvertisement> => {
              throw new Error('two configured relays must not ask the directory');
            },
          },
        };

        const booting = start(world, cleanups);
        await waitUntil(() => relays.every(relay => relay.opened() === 1), 'both relay WebSockets to open');
        release();
        const code = await booting;
        await runCleanups(cleanups);
        await waitUntil(() => relays.every(relay => relay.closed() === 1), 'both relay WebSockets to close');

        should(code).equal(0);
        should(relays.map(relay => relay.opened())).deepEqual([1, 1]);
        should(relays.map(relay => relay.closed())).deepEqual([1, 1]);
        const dialled = said.steps.filter(step => step.startsWith('dialling the relay'));
        should(dialled).have.length(2);
        for (const relay of relays)
          should(dialled.join('\n')).containEql(`127.0.0.1:${String(boundPort(relay.server))}`);
        should(said.stated.join('\n')).match(/relay carrier inactive.*off\.example/u);
        should(said.stated.join('\n')).not.match(/no relay carrier|dials no relay|reachable only directly/u);
      } finally {
        release();
        for (const relay of relays) await relay.server.stop(true);
      }
    });

    it('should retain a carrier that throws on the way up, so nothing it took is left running', async () => {
      // A DIAL TAKES SOMETHING PARTWAY THROUGH `start`: the socket is opened and held before the link
      // over it is built, so a carrier that throws after that point is holding a socket. Registered
      // after starting, THAT is the one carrier nothing ever stops — every carrier before it is
      // released normally, which is what makes the leak invisible. Registered before, the same throw
      // releases everything this boot took.
      const home = await tempDirectory('fyd-relay-start-throws');
      await seedHome(home, OS_CHOSEN_PORT);
      const relayUrls = ['https://first.example', 'https://second.example'] as const;
      await writeFile(
        join(home, 'config', 'daemon.json'),
        daemonDocument({
          host: '127.0.0.1',
          port: OS_CHOSEN_PORT,
          carriers: relayUrls.map(url => ({ kind: 'relay', url, reconnectSeconds: 3_600 })),
        }),
        { mode: 0o600 },
      );
      /**
       * A carrier that records its own lifetime, standing in for one at the world seam.
       *
       * The cast is what a class-typed seam costs a double: `BunRelayCarrier` carries `#` fields, so
       * nothing structural satisfies it. What is under test is the boot's ORDER of two statements, and
       * a real carrier cannot be made to throw between them without a relay identity fixture that
       * would prove less than this does.
       */
      const carrierDouble = (url: string, throwOnStart: boolean) => {
        const record = { started: false, stopped: false };
        const carrier = {
          start: () => {
            record.started = true;
            if (throwOnStart) throw new Error(`the carrier for ${url} failed on the way up`);
          },
          stop: () => {
            record.stopped = true;
          },
          status: () => ({ phase: 'dialling' as const, relayUrl: url, sessions: 0 }),
        };
        return { record, carrier: carrier as unknown as BunRelayCarrier };
      };
      const doubles = relayUrls.map((url, index) => carrierDouble(url, index === 1));
      const cleanups: Array<() => void | Promise<void>> = [];
      const world = {
        ...buildIntegrationWorld(),
        notices: recordingNotices().port,
        untilShutdown: async () => undefined,
        createRelayCarriers: async (sources: readonly RelayCarrierSource[]) => ({
          carriers: sources.map((source, index) => ({ source, carrier: doubles[index]?.carrier as BunRelayCarrier })),
        }),
      };

      await should(start(world, cleanups)).be.rejectedWith(/failed on the way up/u);
      await runCleanups(cleanups);

      should(doubles.map(double => double.record.started)).deepEqual([true, true]);
      // BOTH, including the one that threw. Its own `stop` is the only thing that can release what it
      // had already taken, and it is registered exactly when it can still be reached.
      should(doubles.map(double => double.record.stopped)).deepEqual([true, true]);
    });

    it('should read discovery once and retain a configured relay beside the different advertised one', async () => {
      const home = await tempDirectory('fyd-relay-mixed');
      const configured = refusingRelay();
      const discovered = refusingRelay();
      const configuredUrl = configured.url;
      const discoveredUrl = discovered.url;
      await seedHome(home, OS_CHOSEN_PORT);
      await writeFile(
        join(home, 'config', 'daemon.json'),
        daemonDocument({
          host: '127.0.0.1',
          port: OS_CHOSEN_PORT,
          carriers: [
            { kind: 'relay', url: configuredUrl, reconnectSeconds: 3_600 },
            { kind: 'relay', source: 'discovery', reconnectSeconds: 3_600 },
          ],
        }),
        { mode: 0o600 },
      );
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();
      let reads = 0;
      const world = {
        ...buildIntegrationWorld(),
        notices: said.port,
        untilShutdown: async () => undefined,
        relayDirectory: {
          read: async (): Promise<RelayAdvertisement> => {
            reads += 1;
            return { kind: 'available', relayUrl: discoveredUrl };
          },
        },
      };

      const code = await start(world, cleanups);
      await runCleanups(cleanups);
      await configured.stop();
      await discovered.stop();

      should(code).equal(0);
      should(reads).equal(1);
      const dialled = said.steps.filter(step => step.startsWith('dialling the relay'));
      should(dialled).have.length(2);
      should(dialled.join('\n')).containEql(`127.0.0.1:${String(configured.port)}`);
      should(dialled.join('\n')).containEql(`127.0.0.1:${String(discovered.port)}`);
    });

    it('should refuse boot clearly when discovery resolves onto a configured rendezvous', async () => {
      const home = await tempDirectory('fyd-relay-duplicate');
      const relay = refusingRelay();
      const relayUrl = relay.url;
      await seedHome(home, OS_CHOSEN_PORT);
      await writeFile(
        join(home, 'config', 'daemon.json'),
        daemonDocument({
          host: '127.0.0.1',
          port: OS_CHOSEN_PORT,
          carriers: [
            { kind: 'relay', url: relayUrl },
            { kind: 'relay', source: 'discovery' },
          ],
        }),
        { mode: 0o600 },
      );
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();
      let reads = 0;
      const world = {
        ...buildIntegrationWorld(),
        notices: said.port,
        untilShutdown: async () => {
          throw new Error('a refused boot must not reach its shutdown wait');
        },
        relayDirectory: {
          read: async (): Promise<RelayAdvertisement> => {
            reads += 1;
            return { kind: 'available', relayUrl };
          },
        },
      };

      const code = await start(world, cleanups);
      await runCleanups(cleanups);
      await relay.stop();

      should(code).equal(1);
      should(reads).equal(1);
      should(said.steps.filter(step => step.startsWith('dialling the relay'))).be.empty();
      should(said.stated.join('\n')).match(/relay carrier configuration refused/u);
      should(said.stated.join('\n')).match(/two relay carriers resolved to the same rendezvous/u);
      should(said.stated.join('\n')).containEql(relayUrl);
    });

    it('should report every resolved carrier in --check and name a post-discovery refusal', async () => {
      const home = await tempDirectory('fyd-relay-check');
      const configuredUrl = 'https://mine.example';
      const discoveredUrl = 'https://hosted.example';
      await seedHome(home, OS_CHOSEN_PORT);
      const configFile = join(home, 'config', 'daemon.json');
      const document = {
        host: '127.0.0.1',
        port: OS_CHOSEN_PORT,
        carriers: [
          { kind: 'relay', url: configuredUrl },
          { kind: 'relay', source: 'discovery' },
          { kind: 'relay', url: 'https://off.example', enabled: false },
        ],
      };
      await writeFile(configFile, JSON.stringify(document), { mode: 0o600 });
      let advertised = discoveredUrl;
      let reads = 0;
      const world = {
        ...buildIntegrationWorld(),
        relayDirectory: {
          read: async (): Promise<RelayAdvertisement> => {
            reads += 1;
            return { kind: 'available', relayUrl: advertised };
          },
        },
      };
      const resolvedLines: string[] = [];

      await checkConfiguration(world, line => resolvedLines.push(line));
      should(reads).equal(1);
      const postures = resolvedLines.filter(line => line.startsWith('carrier'));
      should(postures).have.length(3);
      should(postures[0]).containEql(configuredUrl);
      should(postures[1]).containEql(discoveredUrl);
      should(postures[2]).containEql('off.example');
      should(resolvedLines.join('\n')).not.match(/dials no relay|NO other device|nothing off this host can reach/u);
      should(resolvedLines.join('\n')).match(/reachable off this host/u);
      // THE PAIRING LINE DOES NOT READ THE CARRIER ABOVE IT, and this asserts the declared gap rather
      // than a capability. This daemon binds loopback, so its advertisement is `local-only`, and it
      // dials a rendezvous of its own — which `docs/relay-protocol.md` §14 could carry a redemption
      // over, except that a fresh device cannot DISCOVER a self-hosted rendezvous: the one a browser
      // finds on its own is the hosted advertisement. So this line reports the address alone and names
      // no rendezvous, which is honest about reach and UNDER-reports for this document. §13 records it.
      const pairing = resolvedLines.filter(line => line.startsWith('pairing'));
      should(pairing).have.length(1);
      should(pairing[0]).not.containEql(configuredUrl);

      advertised = configuredUrl;
      const refusedLines: string[] = [];
      const refusedCode = await checkConfiguration(world, line => refusedLines.push(line));
      should(refusedCode).equal(1);
      should(reads).equal(2);
      should(refusedLines.filter(line => line.startsWith('carrier'))).have.length(1);
      should(refusedLines.join('\n')).match(/refused.*two relay carriers resolved to the same rendezvous/u);
      // A REFUSED SET MUST NOT BE REPORTED AS AN ABSENT ONE. The grant posture is derived from the
      // carrier this daemon would dial, and a refused set names none — so the derivation used to fall
      // through to the loopback answer and tell this operator they had NO relay, three lines under a
      // refusal saying they had declared two. The remedy that sentence points at is the opposite of
      // the real one, in the command a person runs when something is already wrong.
      should(refusedLines.join('\n')).not.match(/nothing off this host can reach this daemon/u);
      should(refusedLines.join('\n')).not.match(/no grant applies today/u);
      should(refusedLines.filter(line => line.startsWith('grants'))).have.length(1);
      should(refusedLines.join('\n')).match(/grants {2,}not reported — the carrier configuration above is refused/u);
      // And the honest posture is still reported for the very same document once it resolves, so the
      // line above is an undetermined answer rather than a grant surface quietly switched off.
      should(resolvedLines.join('\n')).match(/grants {2,}reachable off this host/u);
    });

    it('should omit a wildcard direct carrier while keeping relays reachable and say why', async () => {
      const home = await tempDirectory('fyd-carrier-wildcard');
      const relay = refusingRelay();
      const relayUrl = relay.url;
      await seedHome(home, OS_CHOSEN_PORT);
      await writeFile(
        join(home, 'config', 'daemon.json'),
        daemonDocument({
          carriers: [
            { kind: 'bind', host: '0.0.0.0', port: OS_CHOSEN_PORT },
            { kind: 'relay', url: relayUrl, reconnectSeconds: 3_600 },
          ],
        }),
        { mode: 0o600 },
      );
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();
      let release = (): void => {};
      const stopped = new Promise<void>(resolve => {
        release = resolve;
      });
      const world = { ...buildIntegrationWorld(), notices: said.port, untilShutdown: async () => await stopped };

      const booting = start(world, cleanups);
      const port = await recordedPort(home);
      const base = `http://127.0.0.1:${String(port)}`;
      await waitUntil(
        () => said.steps.some(step => step.startsWith('ready')),
        'the wildcard-bound daemon to become ready',
      );
      const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
      const response = await fetch(`${base}/v1/carriers`, {
        headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
      });
      const view = DaemonCarriersViewSchema.parse(await response.json());
      release();
      const code = await booting;
      await runCleanups(cleanups);
      await relay.stop();

      should(code).equal(0);
      should(response.status).equal(200);
      should(view.carriers).deepEqual([{ kind: 'relay', url: relayUrl }]);
      should(view.carriers.some(carrier => carrier.kind === 'direct')).be.false();
      // THE REASON IS THE PROTOCOL'S SENTENCE, NOT THIS BOOT'S PARAPHRASE OF IT. `refusalNotice` owns
      // one audience and one remedy per member of `ADVERTISEMENT_REFUSALS`, and `fy pair` already
      // renders those exact strings — so this asserts the daemon says the same words rather than a
      // second spelling that can drift, or that can name the wrong refusal once there is more than
      // one way to have no address to hand out.
      const wildcard = refusalNotice('wildcard-bind');
      const omission = said.stated.filter(message => message.startsWith('direct carrier omitted'));
      should(omission).have.length(1);
      should(omission[0]).containEql(wildcard.audience);
      should(omission[0]).containEql(wildcard.remedy);
      should(omission[0]).containEql('http://0.0.0.0:');
      // The raw document wrote neither legacy bind key. Schema defaults must never be reported as
      // stale lines the operator should remove from a file where they do not exist.
      should(said.stated.filter(message => message.includes('superseded'))).be.empty();
    });

    it('should omit a reverse-proxy path from the carrier wire while boot and --check stay healthy', async () => {
      const home = await tempDirectory('fyd-carrier-proxy-path');
      const relay = refusingRelay();
      const relayUrl = relay.url;
      const publicUrl = 'https://box.example/ferretry';
      await seedHome(home, OS_CHOSEN_PORT);
      await seedFleet(home);
      await writeFile(
        join(home, 'config', 'daemon.json'),
        daemonDocument({
          host: '127.0.0.1',
          port: OS_CHOSEN_PORT,
          publicUrl,
          carriers: [{ kind: 'relay', url: relayUrl, reconnectSeconds: 3_600 }],
        }),
        { mode: 0o600 },
      );
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();
      let release = (): void => {};
      const stopped = new Promise<void>(resolve => {
        release = resolve;
      });
      const world = { ...buildIntegrationWorld(), notices: said.port, untilShutdown: async () => await stopped };

      const booting = start(world, cleanups);
      const port = await recordedPort(home);
      const base = `http://127.0.0.1:${String(port)}`;
      await waitUntil(() => said.steps.some(step => step.startsWith('ready')), 'the proxy-path daemon to become ready');
      const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
      const response = await fetch(`${base}/v1/carriers`, {
        headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
      });
      const view = DaemonCarriersViewSchema.parse(await response.json());
      release();
      const bootCode = await booting;
      await runCleanups(cleanups);
      await relay.stop();
      const bootNotice = said.stated.find(message => message.startsWith('direct carrier omitted'));
      if (bootNotice === undefined) throw new Error('the boot did not explain why its direct carrier was omitted');

      const checkLines: string[] = [];
      const checkCode = await checkConfiguration(buildIntegrationWorld(), line => checkLines.push(line));

      should(bootCode).equal(0);
      should(response.status).equal(200);
      should(view.carriers).deepEqual([{ kind: 'relay', url: relayUrl }]);
      should(bootNotice).containEql(publicUrl);
      should(bootNotice).match(/origin without a path/u);
      should(bootNotice).match(/no direct entry is published.*only over its relays/u);
      should(bootNotice).match(/set "publicUrl" to an http or https origin/u);
      should(checkCode).equal(0);
      // ONE FACT, TWO SURFACES, AND `--check` PUTS IT IN ITS OWN TABLE. The label is this command's;
      // the sentence after it is the boot's, whole and unaltered, so a reader holding a log beside a
      // `--check` sees one fact rather than two renderings they have to reconcile. Asserting the
      // exact composition is what keeps a later "tidy-up" from rewording one of the two.
      const checkOmissions = checkLines.filter(line => line.includes('direct carrier omitted'));
      should(checkOmissions).deepEqual([`carrier      ${bootNotice}`]);
      // Every other line of this report is a labelled column; a bare sentence dropped between them
      // reads as output from something else.
      for (const line of checkOmissions) should(line).match(/^carrier {2,}\S/u);
    });

    it('should publish an operator-written wildcard publicUrl without reinterpreting its hostname', async () => {
      const home = await tempDirectory('fyd-carrier-operator-wildcard');
      // Written before the boot, so it cannot name the port the kernel is about to hand out. Nothing dials it.
      const publicUrl = 'http://0.0.0.0:7431';
      await seedHome(home, OS_CHOSEN_PORT);
      await writeFile(
        join(home, 'config', 'daemon.json'),
        daemonDocument({
          host: '127.0.0.1',
          port: OS_CHOSEN_PORT,
          publicUrl,
          carriers: [{ kind: 'relay', source: 'discovery', enabled: false }],
        }),
        { mode: 0o600 },
      );
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();
      let release = (): void => {};
      const stopped = new Promise<void>(resolve => {
        release = resolve;
      });
      const world = { ...buildIntegrationWorld(), notices: said.port, untilShutdown: async () => await stopped };

      const booting = start(world, cleanups);
      const port = await recordedPort(home);
      const base = `http://127.0.0.1:${String(port)}`;
      await waitUntil(
        () => said.steps.some(step => step.startsWith('ready')),
        'the operator-wildcard daemon to become ready',
      );
      const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
      const response = await fetch(`${base}/v1/carriers`, {
        headers: { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' },
      });
      const view = DaemonCarriersViewSchema.parse(await response.json());
      release();
      const code = await booting;
      await runCleanups(cleanups);

      should(code).equal(0);
      should(response.status).equal(200);
      should(view.carriers).deepEqual([{ kind: 'direct', url: publicUrl }]);
      should(said.stated.filter(message => message.startsWith('direct carrier omitted'))).be.empty();
    });

    it('should report only superseded legacy keys the raw document actually contains', async () => {
      const home = await tempDirectory('fyd-carrier-superseded');
      await seedHome(home, OS_CHOSEN_PORT);
      await writeFile(
        join(home, 'config', 'daemon.json'),
        daemonDocument({
          host: 'box.invalid',
          carriers: [
            { kind: 'bind', host: '127.0.0.1', port: OS_CHOSEN_PORT },
            { kind: 'relay', source: 'discovery', enabled: false },
          ],
        }),
        { mode: 0o600 },
      );
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();

      const code = await start(
        { ...buildIntegrationWorld(), notices: said.port, untilShutdown: async () => undefined },
        cleanups,
      );
      await runCleanups(cleanups);

      should(code).equal(0);
      const superseded = said.stated.filter(message => message.startsWith('the legacy'));
      should(superseded).have.length(1);
      should(superseded[0]).match(/legacy "host" key/u);
      should(superseded[0]).not.match(/"port"|"relay"/u);
    });

    it('should dial the carrier the directory advertises when this daemon configured none', async () => {
      // Arrange: a home with no `relay` block — which is every home, since nothing writes one — and
      // a directory advertising a rendezvous. The address is a port nothing is listening on: the
      // assertion is that the daemon DIALS it, and a real rendezvous is `bun-relay-carrier.test.ts`.
      const home = await tempDirectory('fyd-relay-discovered');
      const relay = refusingRelay();
      const relayUrl = relay.url;
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();
      let release = (): void => {};
      const stopped = new Promise<void>(resolve => {
        release = resolve;
      });
      const world = {
        ...(await worldAt(home, OS_CHOSEN_PORT, async () => await stopped)),
        notices: said.port,
        relayDirectory: { read: async (): Promise<RelayAdvertisement> => ({ kind: 'available', relayUrl }) },
      };

      // Act
      const booting = start(world, cleanups);
      const port = await recordedPort(home);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await fetch(`http://127.0.0.1:${String(port)}/healthz`).catch(() => undefined))?.ok === true) break;
        await Bun.sleep(25);
      }
      release();
      const code = await booting;
      await runCleanups(cleanups);
      await relay.stop();

      // Assert — the daemon dialled, at the advertised address, addressed by its own fingerprint.
      should(code).equal(0);
      should(said.steps.join('\n')).match(
        new RegExp(
          `dialling the relay — ws://127\\.0\\.0\\.1:${String(relay.port)}/v1/rendezvous/fy_daemon_[^/]+/daemon`,
          'u',
        ),
      );
      // AND SAID NOTHING ABOUT BEING DIRECT-ONLY, which is the sentence this whole change removes
      // from a fresh install's boot.
      should(said.stated.filter(message => message.startsWith('no relay carrier'))).be.empty();
    });

    it('should say the consequence and the remedy when it discovers nothing, not only the reason', async () => {
      // Arrange: a build with no directory to ask, which is a real deployment state.
      const home = await tempDirectory('fyd-relay-none');
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();
      let release = (): void => {};
      const stopped = new Promise<void>(resolve => {
        release = resolve;
      });
      const world = {
        ...(await worldAt(home, OS_CHOSEN_PORT, async () => await stopped)),
        notices: said.port,
        relayDirectory: { read: async (): Promise<RelayAdvertisement> => NO_RELAY_DIRECTORY },
      };

      // Act
      const booting = start(world, cleanups);
      const port = await recordedPort(home);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await fetch(`http://127.0.0.1:${String(port)}/healthz`).catch(() => undefined))?.ok === true) break;
        await Bun.sleep(25);
      }
      release();
      const code = await booting;
      await runCleanups(cleanups);

      // Assert — a daemon still starts perfectly without a carrier. What it may not do is know it is
      // unreachable and print one clause about it.
      should(code).equal(0);
      const notice = said.stated.filter(message => /relay|pair/u.test(message));
      should(notice).have.length(4);
      should(notice[0]).match(/^no relay carrier — no relay could be discovered/u);
      // A LOOPBACK BIND WITH NO CARRIER IS THE WORST CASE, and the notice says the whole of it: this
      // daemon cannot be paired with from another device at all — a remedy that named only the relay
      // would leave the reader exactly as stuck. The CONCLUSION is unchanged and its reason is not: it
      // used to be "pairing is always direct", which `docs/relay-protocol.md` §14 retired. What holds
      // is narrower — a device redeems over a rendezvous only through one THIS daemon holds, and this
      // one holds none, so there is no room the two could meet in either.
      should(notice[1]).match(/bound to 127\.0\.0\.1 and dials no relay/u);
      should(notice[1]).match(/nothing can pair with it either/u);
      should(notice[2]).match(/^to pair: set "host" in/u);
      should(notice[2]).containEql(join(home, 'config', 'daemon.json'));
      should(notice[2]).containEql(`"${WILDCARD_BIND_HOST}"`);
      should(notice[2]).containEql('"publicUrl"');
      should(notice[3]).match(/relay directory again/u);
    });

    it('should leave a relay the operator switched off switched off, whatever is advertised', async () => {
      // Arrange: an emergency stop somebody typed, and a directory that would happily override it.
      const home = await tempDirectory('fyd-relay-off');
      await seedHome(home, OS_CHOSEN_PORT);
      await writeFile(
        join(home, 'config', 'daemon.json'),
        daemonDocument({
          host: '127.0.0.1',
          port: OS_CHOSEN_PORT,
          relay: { url: 'https://mine.example', enabled: false },
        }),
        { mode: 0o600 },
      );
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();
      let release = (): void => {};
      const stopped = new Promise<void>(resolve => {
        release = resolve;
      });
      const asked: number[] = [];
      const world = {
        ...buildIntegrationWorld(),
        notices: said.port,
        untilShutdown: async () => await stopped,
        relayDirectory: {
          read: async (): Promise<RelayAdvertisement> => {
            asked.push(1);
            return { kind: 'available', relayUrl: 'https://hosted.example' };
          },
        },
      };

      // Act
      const booting = start(world, cleanups);
      const port = await recordedPort(home);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await fetch(`http://127.0.0.1:${String(port)}/healthz`).catch(() => undefined))?.ok === true) break;
        await Bun.sleep(25);
      }
      release();
      const code = await booting;
      await runCleanups(cleanups);

      // Assert — nothing was dialled, the directory was not even ASKED, and the sentence names the
      // operator's own address rather than the one that was advertised.
      should(code).equal(0);
      should(asked).be.empty();
      should(said.steps.filter(step => step.startsWith('dialling the relay'))).be.empty();
      const notice = said.stated.filter(message => /relay|pair/u.test(message));
      should(notice[0]).match(/^no relay carrier — the configured relay https:\/\/mine\.example is switched off/u);
      should(notice[3]).match(/correct it or remove it/u);
    });
  });

  /**
   * What starting a daemon does NOT do, through the REAL composition root: import this host's own
   * Claude Code or Codex setup. A fresh machine stays "not set up" until somebody chooses — in the app
   * or with `fy daemon setup` — so these cases give the boot a harness to find and prove it left it alone.
   */
  describe('the first run a start no longer performs', () => {
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    const previousCodexHome = process.env.CODEX_HOME;

    /**
     * The import reads `CLAUDE_CONFIG_DIR` and `CODEX_HOME` from the environment, so a suite run from
     * inside an agent session would otherwise import THAT session's harness home. Cleared, so every
     * harness home below is derived from the fixture's own user home.
     */
    beforeEach(() => {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
    });

    afterEach(() => {
      if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    });

    /**
     * A host whose harnesses are exactly the fake ones this case wrote, and no others.
     *
     * The world's own resolver is restored — `buildIntegrationWorld` hides `claude` and `codex` so the
     * developer's machine cannot decide what the rest of this file asserts — and `PATH` is REPLACED
     * rather than prepended, so a real Claude Code installation cannot leak into a case about a host
     * with exactly one harness.
     *
     * THE USER HOME IS REPLACED TOO, and that one is not cosmetic: the harness homes the import reads
     * are derived from it, so without this every case below would import whoever ran the suite.
     */
    async function harnessOnPath(home: string, kinds: readonly string[]): Promise<DaemonWorld> {
      const binary = join(home, 'harness-bin');
      await mkdir(binary, { recursive: true });
      for (const kind of kinds) {
        await writeFile(join(binary, kind), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }
      process.env.PATH = binary;
      const seams = { userHome: join(home, 'user-home') };
      const production = buildWorld({}, seams);
      return { ...buildIntegrationWorld(seams), harnesses: production.harnesses };
    }

    /** A first-run home: its layout, and a `daemon.json` holding exactly `extra` beside the address. */
    async function firstRunHome(name: string, extra: Record<string, unknown>): Promise<{ home: string }> {
      const home = await tempDirectory(name);
      await seedHome(home, OS_CHOSEN_PORT);
      await writeFile(
        join(home, 'config', 'daemon.json'),
        daemonDocument({ host: '127.0.0.1', port: OS_CHOSEN_PORT, ...extra }),
        {
          mode: 0o600,
        },
      );
      return { home };
    }

    /**
     * Boots `world` until it answers, runs `during` against the live daemon, then shuts it down.
     * Returns the exit code, what `during` answered and everything the boot said.
     */
    async function bootOnce<T>(
      world: DaemonWorld,
      home: string,
      during: (base: string, headers: Record<string, string>) => Promise<T>,
    ): Promise<{ readonly code: number; readonly answer: T; readonly said: ReturnType<typeof recordingNotices> }> {
      const cleanups: Array<() => void | Promise<void>> = [];
      const said = recordingNotices();
      let release = (): void => {};
      const stopped = new Promise<void>(resolve => {
        release = resolve;
      });
      const booting = start({ ...world, notices: said.port, untilShutdown: async () => await stopped }, cleanups);
      const port = await recordedPort(home);
      const base = `http://127.0.0.1:${String(port)}`;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if ((await fetch(`${base}/healthz`).catch(() => undefined))?.ok === true) break;
        await Bun.sleep(25);
      }
      let answer: T;
      try {
        const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
        answer = await during(base, { authorization: `Bearer ${token}`, 'x-ferretry-client': 'cli' });
      } finally {
        release();
      }
      const code = await booting;
      await runCleanups(cleanups);
      return { code, answer, said };
    }

    const nothing = async (): Promise<undefined> => undefined;

    /** What `GET /v1/fleet/machine` says about the live daemon, so a case can read "not set up". */
    const machineView = async (
      base: string,
      headers: Record<string, string>,
    ): Promise<{ status: number; body: { setUp?: boolean; runtimeCount?: number; code?: string; error?: string } }> => {
      const response = await fetch(`${base}/v1/fleet/machine`, { headers });
      return { status: response.status, body: (await response.json()) as never };
    };

    it('should import nothing from a host with a harness installed, and leave the machine not set up', async () => {
      // Arrange — exactly the host the retired boot-time import used to set up by itself.
      const { home } = await firstRunHome('fyd-first-run', {});
      const world = await harnessOnPath(home, ['claude']);

      // Act
      const { code, said, answer } = await bootOnce(world, home, machineView);

      // Assert — the boot completed, and wrote nothing into the fleet: somebody has to choose first.
      should(code).equal(0);
      should(await Bun.file(join(home, 'fleet', 'config.yaml')).exists()).be.false();
      should(await Bun.file(join(home, 'fleet', 'manifest.json')).exists()).be.false();
      should(said.stated.filter(message => message.startsWith('first run:'))).be.empty();
      // The machine says so, which is what the app and `fy daemon start` read to offer the first run.
      should(answer.status).equal(200);
      should(answer.body.setUp).be.false();
      should(answer.body.runtimeCount).equal(0);
    });

    it('should boot with the retired fleet.prepareDefaults key, say once that it is no longer read, and import nothing', async () => {
      // Arrange — the block every earlier boot wrote into a fresh state home, still saying "true".
      const { home } = await firstRunHome('fyd-retired-prepare-defaults', { fleet: { prepareDefaults: true } });
      const world = await harnessOnPath(home, ['claude']);

      // Act
      const { code, said } = await bootOnce(world, home, nothing);

      // Assert — tolerated rather than refused, said exactly once, and obeyed by nobody.
      should(code).equal(0);
      should(said.stated.filter(message => message === RETIRED_FLEET_BLOCK_NOTICE)).have.length(1);
      should(await Bun.file(join(home, 'fleet', 'config.yaml')).exists()).be.false();
    });

    /**
     * A `config.yaml` in the RETIRED account format: refused, never converted, never overwritten.
     *
     * The daemon still boots — a refused fleet must not take pairing, sessions and every other surface
     * down with it — but the machine view names the file and says what to do, and the file is left
     * byte for byte as the operator wrote it.
     */
    it('should boot, refuse and name a fleet configuration in the old account format, touching nothing', async () => {
      // Arrange
      const { home } = await firstRunHome('fyd-first-run-v1', {});
      const configPath = join(home, 'fleet', 'config.yaml');
      const retired = 'accounts: {}\n';
      await mkdir(join(home, 'fleet'), { recursive: true });
      await writeFile(configPath, retired, { mode: 0o600 });
      const world = await harnessOnPath(home, ['claude']);

      // Act
      const { code, answer } = await bootOnce(world, home, machineView);

      // Assert — it started anyway.
      should(code).equal(0);
      // The machine view refuses with the same file named and the remedy, rather than serving an empty machine.
      should(answer.status).equal(409);
      should(answer.body.code).equal('fleet_catalog_unreadable');
      should(answer.body.error).containEql(RETIRED_FLEET_CONFIG_SENTENCE(configPath));
      // And nothing was converted, written over or published.
      should(await readFile(configPath, 'utf8')).equal(retired);
      should(await Bun.file(join(home, 'fleet', 'manifest.json')).exists()).be.false();
    });

    it('should boot with the retired accountModel key and say once that it is no longer read', async () => {
      // Arrange — the switch the account model used to sit behind, left in an old document.
      const { home } = await firstRunHome('fyd-retired-switch', { accountModel: { enabled: true } });
      const world = await harnessOnPath(home, []);

      // Act
      const { code, said } = await bootOnce(world, home, nothing);

      // Assert — tolerated rather than refused, and said exactly once so the operator can delete it.
      should(code).equal(0);
      should(said.stated.filter(message => message === RETIRED_ACCOUNT_MODEL_NOTICE)).have.length(1);
      should(said.stated.filter(message => message === RETIRED_FLEET_BLOCK_NOTICE)).be.empty();
    });
  });

  /**
   * WHAT AN UNATTENDED PASS IS ALLOWED TO SPEND, proved against a recorder that a real host would
   * have had to run.
   *
   * A REAL SENTINEL MODEL PROMPT is what the v3.6 timer reached: the refresh pass launched each
   * published account WRAPPER with a prompt asking for an exact sentinel, on the fleet's own
   * `usage.interval` — a billable model call per account per tick, with nobody watching. That probe is
   * deleted, and this proves the deletion holds on a booted daemon: `spendWrapper` records every
   * launch and its full argv, because a flag can read `false` while a process still starts.
   *
   * ## THE TICK IS REAL, NOT A SHORTENED WAIT
   *
   * `advanced.usage.interval: 1` is the fleet's own declaration, and it drives the registered
   * `setInterval` AND the feed's freshness window. `advanced.usage.enabled: false` switches off the
   * daemon's own credential collector so the chain walks as far as the external endpoint below, and
   * `usageReads` counts requests the DAEMON made to it with nothing calling it — so a second read is a
   * second unattended pass. The elapsed clock is asserted against the interval too, so the evidence
   * cannot be the boot pass counted twice.
   *
   * ## AND THE RECORDER IS PROVED TO WORK
   *
   * An absent file is only evidence if the thing that writes it would have, so the fixture spawns the
   * wrapper itself afterwards. A control must depend on the fixture, never on the behaviour under
   * test — no path in the product launches a wrapper for health any more.
   */
  describe('what an unattended fleet pass may spend', () => {
    const SPEND_ACCOUNT = '00000000-0000-4000-8000-0000000005e4';
    const SPEND_WRAPPER = 'claude-auto-spend';
    /** The fleet's own declared cadence, in seconds. It is the timer period and the cache window. */
    const TICK_SECONDS = 1;

    it('should complete the boot pass and a real scheduled tick with no wrapper launch', async () => {
      // Arrange
      const home = await tempDirectory('fyd-unattended-spend');
      const cleanups: Array<() => void | Promise<void>> = [];
      let release = (): void => {};
      const world = await worldAt(home, OS_CHOSEN_PORT, async () => {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      });

      // The recorder. It is a real executable on a real host: the only way to prove nothing was
      // launched is to make a launch leave a trace.
      const binary = join(home, 'bin');
      await mkdir(binary, { recursive: true });
      const wrapperLog = join(home, 'wrapper-launches.log');
      const spendWrapper = join(binary, SPEND_WRAPPER);
      await writeFile(spendWrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${wrapperLog}\n`, { mode: 0o755 });
      await publishManifest(home, [
        {
          id: SPEND_ACCOUNT,
          kind: 'claude',
          mode: 'auto',
          wrapper: spendWrapper,
          home: join(home, 'harness'),
          displayName: 'Spend',
          defaultModel: 'claude-opus-5',
          models: [{ id: 'claude-opus-5', available: true }],
          available: true,
          unavailableReason: null,
        },
      ]);

      // The external collector, which is what witnesses each unattended pass. Every request it
      // counts is one the daemon made with nothing calling it.
      let usageReads = 0;
      const collector = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => {
          usageReads += 1;
          return Response.json({ accounts: [] });
        },
      });
      const collectorUrl = `http://127.0.0.1:${String(boundPort(collector))}/usage`;

      await mkdir(join(home, 'config'), { recursive: true });
      await writeFile(
        join(home, 'config', 'machine.yaml'),
        Bun.YAML.stringify({ advanced: { usage: { enabled: false, interval: TICK_SECONDS } } }),
        { mode: 0o600 },
      );
      await writeFile(
        join(home, 'config', 'daemon.json'),
        daemonDocument({ host: '127.0.0.1', port: OS_CHOSEN_PORT, usage: { url: collectorUrl } }),
        { mode: 0o600 },
      );

      // Act
      const bootAt = Date.now();
      const exit = start(world, cleanups);
      const port = await recordedPort(home);
      const base = `http://127.0.0.1:${String(port)}`;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if ((await fetch(`${base}/healthz`).catch(() => undefined))?.ok === true) break;
        await Bun.sleep(25);
      }
      // The boot pass and then a REGISTERED TICK. Nothing in this test reads usage, so every one of
      // these is the daemon collecting on its own schedule.
      await waitUntil(() => usageReads >= 2, 'a scheduled fleet refresh tick after the boot pass');
      const unattendedElapsedMs = Date.now() - bootAt;
      const unattendedReads = usageReads;
      const wrapperAfterUnattended = await Bun.file(wrapperLog).exists();

      // THE RECORDER'S OWN CREDIBILITY, proved by the FIXTURE rather than by the product.
      await Bun.spawn({ cmd: [spendWrapper, 'recorder-proof'], stdout: 'ignore', stderr: 'ignore' }).exited;
      const recorderProof = await readFile(wrapperLog, 'utf8');
      release();
      const code = await exit;
      await runCleanups(cleanups);
      await collector.stop(true);

      // Re-read what the daemon was actually configured with, so this cannot pass because the
      // fixture forgot to point it at the collector that witnesses each pass.
      const daemonConfig = JSON.parse(await readFile(join(home, 'config', 'daemon.json'), 'utf8')) as {
        usage: { url: string };
      };

      // Assert
      should(code).equal(0);
      // The unattended passes really happened, and the second one was a timer tick rather than the
      // boot pass counted twice.
      should(unattendedReads).be.aboveOrEqual(2);
      should(unattendedElapsedMs).be.aboveOrEqual(TICK_SECONDS * 1_000);
      should(daemonConfig.usage.url).equal(collectorUrl);

      // No account wrapper was launched by either unattended pass, so no sentinel model prompt was
      // sent and no model call was billed.
      should(wrapperAfterUnattended).be.false();

      // The recorder works, so the `false` above is evidence rather than an artefact.
      should(recorderProof).containEql('recorder-proof');
    });
  });
});

/**
 * A stand-in harness CLI for the conversion journey: a Bun script that reports the version in the
 * control file beside it, refuses when a `<kind>.reject` file is there, and otherwise resumes the
 * conversation id it was given the way its harness would — finding the file in its home, rebuilding the
 * history, and sending it to the model the environment points at.
 */
function fakeHarnessCli(kind: 'claude' | 'codex'): string {
  return `#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const kind = '${kind}';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write(readFileSync(join(import.meta.dir, kind + '.version'), 'utf8'));
  process.exit(0);
}
if (existsSync(join(import.meta.dir, kind + '.reject'))) {
  console.error('Error: thread/resume failed');
  process.exit(1);
}
const find = (dir, name) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const found = find(path, name);
      if (found) return found;
    } else if (entry.endsWith(name)) return path;
  }
  return undefined;
};
const tools = declared => (existsSync(join(import.meta.dir, kind + '.notools')) ? [] : declared);
const records = file => readFileSync(file, 'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line));
let url;
let body;
if (kind === 'claude') {
  const id = args[args.indexOf('--resume') + 1];
  const file = find(join(process.env.CLAUDE_CONFIG_DIR, 'projects'), id + '.jsonl');
  const messages = records(file)
    .filter(record => record.type === 'user' || record.type === 'assistant')
    .map(record => ({ role: record.message.role, content: record.message.content }));
  url = process.env.ANTHROPIC_BASE_URL + '/v1/messages';
  body = { tools: tools([{ name: 'Bash' }]), messages: [...messages, { role: 'user', content: args.at(-1) }] };
} else {
  const id = args[args.indexOf('resume') + 1];
  const home = process.env.CODEX_HOME;
  const file = find(join(home, 'sessions'), id + '.jsonl');
  const input = records(file).filter(record => record.type === 'response_item').map(record => record.payload);
  const base = /base_url = "([^"]+)"/.exec(readFileSync(join(home, 'config.toml'), 'utf8'))[1];
  url = base + '/responses';
  body = { tools: tools([{ name: 'exec_command' }]), input: [...input, { type: 'message', role: 'user', content: [{ type: 'input_text', text: args.at(-1) }] }] };
}
await (await fetch(url, { method: 'POST', body: JSON.stringify(body) })).text();
console.log('OK');
`;
}
