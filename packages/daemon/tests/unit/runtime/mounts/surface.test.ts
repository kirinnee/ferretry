import { describe, it } from 'bun:test';
import { ANALYTICS_PRICING_RATE_APPLICABILITY } from '@ferretry/protocol';
import should from 'should';
import { AUDITED_ROUTES, AUDITED_SOCKET_ROUTES } from '../../../../src/lib/audit/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { HandoverReconcileLoop } from '../../../../src/lib/handover/index.ts';
import { NO_PERFORMANCE_PROBE } from '../../../../src/lib/performance/recorder.ts';
import {
  createMountedDispatcher,
  createMountedSocketDispatcher,
  fixedCarrierView,
  type MountedSubsystems,
  mountedDaemonRoutes,
  mountedSocketRoutes,
  type PairingSubsystem,
  type ScratchGcSubsystem,
} from '../../../../src/lib/runtime/index.ts';
import { SecuritySettingsService } from '../../../../src/lib/security/index.ts';
import { SessionFilesystem } from '../../../../src/lib/session/filesystem/index.ts';
import { OperatorReadService } from '../../../../src/lib/session/reads/index.ts';
import { ChallengeLedger, StepUpRegistry, StepUpService } from '../../../../src/lib/step-up/index.ts';
import { agentToolWorld } from '../../agent-tools/support.ts';
import { MemoryTranscript } from '../../../support/transcript-images.ts';
import { fixedClock, request } from '../../api/support.ts';
import { NOT_AUDITED, NOT_AUDITED_SOCKETS } from '../../audit/not-audited.ts';
import { FakeRootPinner, FakeSessionGit } from '../../session/filesystem/support.ts';
import {
  analyticsSubsystem,
  attachSubsystem,
  attentionService,
  CREDENTIALS,
  configChangeSubsystem,
  consoleSubsystem,
  dialogSubsystem,
  emptyFeed,
  FakeBrowserLogin,
  FakeSessionControl,
  FakeSessionMigrate,
  FakeSessionResume,
  FakeSessionSend,
  FakeSessionSignal,
  FakeSpeedups,
  FakeSttEnhancer,
  FakeTaskBoards,
  FakeTerminals,
  FakeWarden,
  fleetEventSubsystem,
  grantSubsystem,
  healthSubsystem,
  human,
  learningSubsystem,
  NO_HELD_REPLIES,
  nameSubsystem,
  permissionSubsystem,
  pinService,
  recommendSubsystem,
  secretSubsystem,
  sessionDirectory,
  sessionView,
  taskSubsystem,
} from './support.ts';

/**
 * The complete surface the daemon process serves.
 *
 * This is the test that catches the migration's recurring defect: a subsystem built, tested and
 * never mounted. A route missing from this table is a capability the product does not have.
 */

const base = { credentials: CREDENTIALS, usage: emptyFeed, clock: fixedClock(1_700_000_000_000), startedAtMs: 0 };

const pairingSubsystem = (): PairingSubsystem => ({
  mint: () => {
    throw new Error('not exercised by the surface inventory');
  },
  status: () => undefined,
  revoke: () => undefined,
  devices: async () => [],
  revokeDevice: async () => false,
});

// A REAL step-up service over in-memory fakes, so the inventory mounts the very type production does.
const stepUpSubsystem = (): StepUpService =>
  new StepUpService({
    store: {
      list: async () => [],
      holder: async () => undefined,
      add: async () => {},
      updateSignCount: async () => false,
      forgetDevice: async () => {},
    },
    verifier: {
      verifyRegistration: async () => ({ ok: false, reason: 'not exercised by the surface inventory' }),
      verifyAssertion: async () => ({ ok: false, reason: 'not exercised by the surface inventory' }),
    },
    registry: new StepUpRegistry({ nowMs: () => 1_700_000_000_000 }),
    challenges: new ChallengeLedger(),
    random: { bytes: length => new Uint8Array(length) },
    clock: { nowMs: () => 1_700_000_000_000 },
    devices: { device: async () => undefined },
    allowedOrigins: () => [],
    relyingPartyName: 'Ferretry',
    machineName: 'studio',
    audit: { record: async () => undefined },
  });

const subsystems = (scratchGc?: ScratchGcSubsystem): MountedSubsystems => ({
  health: healthSubsystem(),
  performance: {
    profiles: {
      start: () => ({
        state: 'running',
        id: 'p1',
        startedAt: '2026-10-21T00:00:00.000Z',
        endsAt: '2026-10-21T00:00:30.000Z',
      }),
      view: () => undefined,
    },
    probe: NO_PERFORMANCE_PROBE,
    clock: { now: () => 0 },
  },
  doctor: {
    report: async () => ({
      checks: [],
      harnesses: [],
      ready: true,
      limitation: 'not exercised by the surface inventory',
    }),
  },
  pairing: pairingSubsystem(),
  push: {
    publicKey: async () => 'the-application-server-key',
    list: async () => [],
    listFor: async () => [],
    ownerOf: async () => undefined,
    register: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    revoke: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  stepUp: stepUpSubsystem(),
  // The published set's one view, which the pairing service reads too. Non-empty on purpose — an empty
  // one would let `PairingResponseSchema`'s default stand in for a carried-through set.
  carriers: fixedCarrierView([
    { kind: 'direct', url: 'https://workstation.example.test' },
    { kind: 'relay', url: 'wss://rendezvous.example.test/fy' },
  ]),
  tunnel: {
    view: () => {
      throw new Error('not exercised by the surface inventory');
    },
    change: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  webrtc: {
    offer: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  harnessLogin: {
    start: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    shutdown: async () => undefined,
    status: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    submit: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    cancel: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  mcpOAuth: {
    connections: async () => [],
    start: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    complete: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    cancel: flowId => ({ flowId, cancelled: false }),
    signOut: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  fleetCredentials: {
    list: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    check: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    test: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    presets: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  fleetCatalog: {
    machine: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    previewProfile: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    components: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    profiles: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    runtimes: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    propose: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    read: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    apply: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  agentControl: {
    allows: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  fleetSetup: {
    scan: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    installTools: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    exportBundle: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    executors: {
      setup: {
        describe: async () => {
          throw new Error('not exercised by the surface inventory');
        },
        execute: async () => {
          throw new Error('not exercised by the surface inventory');
        },
      },
      clone: {
        describe: async () => {
          throw new Error('not exercised by the surface inventory');
        },
        execute: async () => {
          throw new Error('not exercised by the surface inventory');
        },
      },
    },
  },
  cgroups: {
    config: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    updateConfig: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  configFiles: {
    service: {
      status: async () => {
        throw new Error('not exercised by the surface inventory');
      },
      file: async () => {
        throw new Error('not exercised by the surface inventory');
      },
      write: async () => {
        throw new Error('not exercised by the surface inventory');
      },
      validate: async () => {
        throw new Error('not exercised by the surface inventory');
      },
      confirm: async () => {
        throw new Error('not exercised by the surface inventory');
      },
    },
    agentControl: { allows: async () => false },
    identities: { resolve: async () => undefined },
    arm: async () => () => undefined,
  },
  // Like the monitor and quota-failover loops, this serves no route. Its presence proves the daemon
  // constructs the unattended evidence pass rather than leaving its timer as unreachable code.
  fleetRefresh: { run: async () => undefined, arm: async () => () => undefined },
  conversationImport: {
    list: async () => ({ conversations: [], matched: 0, skipped: 0 }),
    preview: async () => undefined,
    adopt: async () => ({ adopted: [], refused: [] }),
  },
  foreignHistory: {
    list: async () => ({
      conversations: [
        {
          id: 'imported-one',
          harness: 'claude' as const,
          title: 'Fixture imported transcript',
          source: '/fixture/claude/projects/project/one.jsonl',
          eventCount: 5,
          readOnly: true as const,
        },
      ],
      skipped: [
        {
          harness: 'codex' as const,
          source: '/fixture/codex/sessions/one.jsonl',
          reason: 'invalid-json',
        },
        {
          harness: 'codex' as const,
          source: '/fixture/codex/sessions/two.jsonl',
          reason: 'invalid-json',
        },
      ],
    }),
    get: async id =>
      id === 'imported-one'
        ? ({
            id,
            harness: 'claude',
            title: 'Fixture imported transcript',
            source: '/fixture/claude/projects/project/one.jsonl',
            eventCount: 5,
            readOnly: true,
            events: [
              { kind: 'message', role: 'user', text: 'record identifier', recordId: 'record' },
              { kind: 'message', role: 'assistant', text: 'item identifier', itemId: 'item' },
              { kind: 'message', role: 'system', text: 'message identifier', messageId: 'message' },
              { kind: 'message', role: 'tool', text: 'must not be exposed' },
              { kind: 'notice' },
            ],
          } as never)
        : undefined,
  },
  attention: attentionService(),
  attentionReplies: NO_HELD_REPLIES,
  notifications: {
    attentionDelivered: async () => 0,
    enrolledDevices: async () => 0,
  },
  pins: pinService([]),
  sessions: sessionDirectory([sessionView('s1')]),
  sessionAddresses: {
    has: id => id === 's1',
    candidates: async () => [{ id: 's1', name: 'aniya', status: 'running' }],
  },
  catalogs: {
    projects: async () => [],
    registerProject: async () => {
      throw new Error('not used by this surface fixture');
    },
    skills: async session => ({ harness: session.config.harness, skills: [] }),
    skillsInventory: async () => ({ homes: [], projects: [], truncated: false }),
    sessionSkillsInventory: async session => ({
      sessionId: session.config.id,
      harness: session.config.harness,
      skills: [],
      truncated: false,
    }),
    skillFile: async () => undefined,
  },
  worktrees: {
    list: async () => ({ worktrees: [] }),
    checkRemoval: async () => {
      throw new Error('not used by this surface fixture');
    },
    remove: async () => {
      throw new Error('not used by this surface fixture');
    },
    create: async () => {
      throw new Error('not used by this surface fixture');
    },
  },
  sessionControl: new FakeSessionControl(),
  sessionResume: new FakeSessionResume(),
  sessionSend: new FakeSessionSend(),
  sendTracking: { arm: () => () => {} },
  sessionAnswer: {
    answer: async id => sessionView(id),
  },
  sessionAttachments: {
    upload: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    download: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    unlock: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    lock: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  sessionSignal: new FakeSessionSignal(),
  sessionRename: {
    rename: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  sessionAgendaMode: {
    get: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    set: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  sessionHypermedia: {
    set: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  pack: {
    service: {
      view: async () => {
        throw new Error('not exercised by the surface inventory');
      },
      recommend: async () => {
        throw new Error('not exercised by the surface inventory');
      },
      newChild: async () => {
        throw new Error('not exercised by the surface inventory');
      },
      inventory: async () => {
        throw new Error('not exercised by the surface inventory');
      },
    },
    routing: {
      cleanUp: {
        status: async () => {
          throw new Error('not exercised by the surface inventory');
        },
        start: async () => {
          throw new Error('not exercised by the surface inventory');
        },
        job: async () => {
          throw new Error('not exercised by the surface inventory');
        },
      },
      file: {
        undoable: async () => {
          throw new Error('not exercised by the surface inventory');
        },
        accept: async () => {
          throw new Error('not exercised by the surface inventory');
        },
        undo: async () => {
          throw new Error('not exercised by the surface inventory');
        },
      },
    },
    result: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    setSwitch: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  mcpInventory: {
    inventory: {
      machine: async () => {
        throw new Error('not exercised by the surface inventory');
      },
      session: async () => {
        throw new Error('not exercised by the surface inventory');
      },
    },
    check: {
      check: async () => {
        throw new Error('not exercised by the surface inventory');
      },
    },
  },
  sessionMcp: {
    list: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    previewProject: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    addProject: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    previewLogin: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    addLogin: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  sessionRuntime: {
    models: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    control: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  // The declared-wait loop serves no route, so it contributes nothing to the table below. It is a
  // mounted subsystem because a background loop the daemon never constructs is the same absent
  // capability as an unserved route — see the field's own comment.
  monitor: { intervalMs: 15_000, arm: () => {}, run: async () => undefined, close: async () => {} },
  observer: {
    turns: { intervalMs: 2_000, run: async () => undefined },
    arm: () => undefined,
    project: async () => undefined,
    questions: async () => new Map(),
    liveness: async () => ({}),
    midTurn: async () => 0,
    pane: async () => undefined,
    sendEvidence: async () => ({ readable: false, inputs: [] }),
    close: async () => undefined,
  },
  sessionMigrate: new FakeSessionMigrate(),
  // The quota-failover loop serves no route either, and for the same reason the declared-wait loop
  // does not: a background tick is ended by a timer, not by a request.
  quotaFailover: {
    intervalMs: async () => 300_000,
    run: async () => ({
      at: '2026-01-01T00:00:00.000Z',
      halted: 'automatic quota failover is disabled (enabled=false)',
      warnings: [],
      considered: 0,
      moved: [],
      failed: [],
      stranded: [],
      skipped: [],
    }),
  },
  // The cross-family counterpart of the migration above. Its three routes ARE part of the surface, so
  // the inventory dials them; the state machine behind them has its own coverage.
  handover: {
    begin: () => {
      throw new Error('not exercised by the surface inventory');
    },
    receipt: () => {
      throw new Error('not exercised by the surface inventory');
    },
    cancel: () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  // The reconciler serves no route, for the reason the declared-wait and quota-failover loops do not:
  // a handover advances on a timer and on an inbound board verification, never on a request.
  handoverReconcile: new HandoverReconcileLoop(
    {
      advance: async () => {
        throw new Error('not exercised by the surface inventory');
      },
    },
    { pendingSourceSessionIds: async () => [], anyOpen: () => false, onOpened: () => () => {}, forget: () => {} },
    { every: () => () => {} },
  ),
  sessionFork: {
    fork: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  tasks: taskSubsystem(),
  taskBoards: new FakeTaskBoards(),
  analytics: analyticsSubsystem(),
  analyticsPricing: {
    view: async () => ({
      catalog: [],
      catalogFingerprint: 'catalog-empty',
      sources: [],
      sourcesFingerprint: 'sources-empty',
      rateApplicability: ANALYTICS_PRICING_RATE_APPLICABILITY,
    }),
    patch: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    preview: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    apply: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  // The ingestion loop serves no route, so the surface inventory never calls it. It is present because
  // `MountedSubsystems` is the list of what production constructs, and a loop absent from that list is
  // a store nothing writes to.
  analyticsIngest: {
    rebuildRequired: false,
    ingest: () => {
      throw new Error('not exercised by the surface inventory');
    },
    rebuild: () => {
      throw new Error('not exercised by the surface inventory');
    },
    arm: () => () => undefined,
  },
  terminals: new FakeTerminals(),
  browserLogin: new FakeBrowserLogin(),
  browser: {
    status: async sessionId => ({
      state: 'stopped',
      sessionId,
      viewport: { width: 1280, height: 800 },
      viewers: 0,
      persistentProfile: true,
      profileKind: 'shared',
      idleTimeoutSeconds: 0,
      pages: [],
      capacity: { running: 0, maximum: 3 },
    }),
    act: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    attachViewer: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    dispatchHumanInput: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    openPage: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    actOnPage: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    closePage: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    releaseSession: async () => undefined,
    closeAll: async () => undefined,
    stream: async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined }),
  },
  agentTools: (() => {
    const world = agentToolWorld();
    return { service: world.service, identities: world.identities };
  })(),
  names: nameSubsystem(),
  learning: learningSubsystem(),
  recommend: recommendSubsystem(),
  sttEnhancement: new FakeSttEnhancer(),
  speedups: new FakeSpeedups(),
  models: {
    view: async () => ({ published: { origin: 'https://ferretry.pages.dev', enabled: false }, catalogs: [] }),
    refresh: async () => ({ outcome: 'disabled' as const }),
    refreshLocal: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  daemonUpdate: {
    view: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    start: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    setAutoInstall: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    arm: () => () => undefined,
    activityChanged: () => undefined,
  },
  harnessUpdate: {
    view: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    start: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  sessionFilesystem: new SessionFilesystem(new FakeRootPinner(), new FakeSessionGit()),
  scratchGc: scratchGc ?? { plan: async () => [], sweep: async () => ({ sessions: 0, bytes: 0, failures: 0 }) },
  systemOpen: { open: async () => ({ opened: true, host: 'example.com' }) },
  secrets: secretSubsystem(),
  warden: new FakeWarden(),
  transcriptImages: new MemoryTranscript([]).reader(),
  sessionReads: new OperatorReadService(
    {
      replay: async () => [
        { sequence: 1, sessionId: 's1', time: '2026-01-01T00:00:00.000Z', type: 'session.created', data: {} },
      ],
    },
    { capture: async () => ({ alive: true, dead: false, text: 'screen' }) },
    { tail: async () => ({ kind: 'read', events: [] }) },
    // The addressable conversation, and its COMPLETED context: a resolved identity, because a page is
    // refused outright until the daemon has established which file this session's transcript is. What a
    // row and a cursor mean is proved in the read's own tests; this fixture exists so the route is real.
    {
      read: async () => ({
        kind: 'read',
        context: {
          sessionId: 's1',
          incarnation: 'one',
          provenance: {
            v: 1,
            home: '/harness/home',
            identity: 'minted',
            harnessSessionId: 'harness-one',
            file: '/harness/home/one.jsonl',
          },
        },
        rows: [],
      }),
    },
    { tag: async () => new Uint8Array(32), matches: async () => false },
  ),
  sessionAttach: attachSubsystem(),
  sessionConsole: consoleSubsystem(),
  sessionProcesses: {
    list: async sessionId => ({ sessionId, observedAt: '2026-10-29T00:00:00.000Z', available: true, processes: [] }),
    output: async () => {
      throw new Error('not exercised by the surface table');
    },
    stop: async () => {
      throw new Error('not exercised by the surface table');
    },
  },
  sessionPermission: permissionSubsystem(),
  sessionDialog: dialogSubsystem(),
  fleetEvents: fleetEventSubsystem(),
  configChanges: configChangeSubsystem(),
  grants: grantSubsystem(),
  audit: {
    log: { record: async () => undefined },
    recent: async () => ({ records: [], kept: [], keptTotal: 0, unreadable: 0 }),
    deviceName: async () => undefined,
    flush: async () => undefined,
    failures: { auditWriteFailed: () => undefined },
  },
  security: new SecuritySettingsService({
    document: { read: async () => undefined, write: async () => {} },
    audit: { record: async () => {}, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
    clock: { nowMs: () => 1_700_000_000_000 },
    widenCommand: 'fy daemon security set <field> <value>',
  }),
  deviceGrants: { mayWiden: () => DEFAULT_CAPABILITY_GRANTS, change: async () => 'not-found' as const },
});

describe('the mounted daemon surface', () => {
  it('should declare credential and privileged-arrival requirements independently', () => {
    const mounted = subsystems();
    const routes = [...mountedDaemonRoutes(base, mounted), ...mountedSocketRoutes(mounted)];
    const minima = routes.reduce<Record<string, number>>((counts, route) => {
      counts[route.minimum] = (counts[route.minimum] ?? 0) + 1;
      return counts;
    }, {});

    // `admin-token` is declared by exactly ONE route: the owner's re-opened passkey window (review L3),
    // so a paired device is refused at the boundary before the service's own at-the-machine check. The
    // fleet's old approval-code route used it once too, and is gone. The agent tools route is `none` and
    // privileged: it carries no host authority, only the session credential it checks itself.
    // Written as a LABELLED sum, one term per line, and that is the anti-merge device rather than
    // style: a bare `129 + 5 + 1 + 1` invited two changes to each append `+ 1` and produce the same
    // total, which git merges without a conflict — exactly how a route goes missing with this test
    // green. Two additions here both have to rewrite the line that carries the terminating `;`.
    const operatorRoutes =
      115 + // the session table and everything that is not the account model (six of them the send ledger: its read, one send, a retry under the same id, a cancel, an Enter for one typed and not sent, and the hand-off document behind a pointer; one the Enter or erase for a person's own draft in the composer) (three socket-ticket counters gone: a device opens streams inside its session; the operator password's set and unlock routes gone: the passkey step-up replaced them)
      4 + // the credential sign-in family: start, then read, answer or cancel one flow
      5 + // the MCP sign-in family: its status read, start, finish, cancel and sign out (docs/mcp-oauth.md)
      3 + // every MCP server a ferret sees, for the machine and for one ferret, and checking one (docs/mcp-scopes.md)
      2 + // the account model's credential list and its Check now
      3 + // copying secrets to another machine: open an import, seal for one, file one (docs/secrets.md)
      2 + // an environment login's Test, and the provider presets one is made from (docs/provider-presets.md)
      7 + // the account model's four catalogue reads and its three proposal routes
      1 + // the draft-profile preview, a read with a body
      3 + // the setup scan, tool install and the clone export
      1 + // the security log read
      5 + // the passkey step-up: this device's passkeys, registration and step-up, each with its options (the owner's re-opened window is admin-token)
      1 + // "Send now" for the answers a ferret's outbox holds (docs/attention.md § The loop)
      1 + // one device's own grants, changed (B5)
      2 + // the machine's security settings: the read and the change (zero-trust B6)
      1 + // switching the tunnel on or off (pairing.configure); its read is `authenticated`, like the carrier refresh
      2 + // the unlock: its options and the verified unlock (zero-trust B6)
      1 + // the Console's input: typing into a session's own pane, governed as `terminal.use`
      1 + // the permission prompt's answer: a digit or Escape into the same pane, governed the same way
      1 + // a harness dialog's answer (hooks review, an update, a sign-in): arrows then Enter into the same pane, governed the same way
      1 + // an agent's rename: a new first name or task title
      1 + // a ferret's hypermedia switch, from its next launch (docs/hypermedia.md)
      2 + // a ferret's agenda mode: its read and its switch, from its next launch (docs/notifications.md)
      5 + // Pack mode: its view, recommend, a sub-ferret start, a result and a ferret's switch (docs/pack-mode.md)
      5 + // the routing prompt's Clean up: the inventory, a clean-up start and its run, accept and undo
      5 + // adding an MCP server for one ferret: its listing, and a preview and an add for each of the project and the login
      6 + // a person's agent tools: terminal and browser tool calls, their control changes, and each kind's control read
      2 + // the speed-up keys: their status read and one provider's Test
      3 + // updating this daemon: the view, starting an update, and the automatic-install setting (docs/updating.md)
      2 + // updating the agent CLIs: their view (which is when npm is asked) and starting one update
      4 + // the configuration files: status, one file, an edit and a confirmation (the agent's door is `none`)
      1 + // an owner's request for a Warden investigation (the "who needs you" feed is `authenticated`, like the status)
      1 + // the owner leaving a ferret alone for longer than the Warden would
      1 + // a Restart's stale-settings read: would a relaunch change what this session runs on
      1 + // a cross-harness move's preview: what converting the conversation would carry (docs/migration-cross-harness.md)
      3 + // existing conversations kept as ferrets: the listing, one conversation's preview and the adoption
      3 + // the model catalogs: the list, a check for a newer published one, and a read of the models Ollama has installed (docs/model-catalog.md)
      9 + // lessons: the default's write, Apply's preview and write, the per-ferret switch and its list, and the scan's estimate, start, read and cancel (a ferret's own door is `none`)
      2 + // the performance profile: start one, and read it back by id (`fy daemon profile`)
      1 + // one transcript image by its handle: the log's `[fy-image …]` marker, governed exactly like `logs` (docs/grants.md)
      1 + // handing a web address to this computer's own browser (loopback caller only)
      3 + // the skills inventory: the machine listing, one session's listing, and the Open read of a listed SKILL.md
      3; // a ferret's processes: the list, one process's output, and Stop
    // `none` lost `POST /v1/pair`: redemption happens only inside a session now, so it is no route at all.
    // `authenticated` gained the Warden's "who needs you" feed, which a live warden reads like its status,
    // and the WebRTC offer: any paired device may ask for a shorter path to its own daemon (§16).
    // It gained the tunnel read too: whether a machine has a tunnel is not a secret (§15).
    should(minima).deepEqual({ none: 7, authenticated: 10, operator: operatorRoutes, 'admin-token': 1 });
    should(
      routes.filter(route => route.privilegedOnly === true).map(route => `${route.method} ${route.path}`),
    ).deepEqual([
      'POST /v1/agent/config',
      'POST /v1/system/open-url',
      'POST /v1/agent/tools',
      'POST /v1/agent/lessons',
      'GET /v1/sessions/:sessionId/attach',
    ]);
  });

  it('should serve the base feeds and every mounted subsystem from one table', () => {
    // Arrange / Act
    const routes = mountedDaemonRoutes(base, subsystems()).map(route => `${route.method} ${route.path}`);

    // Assert
    should(routes).deepEqual([
      'GET /healthz',
      'GET /usage',
      'GET /v1/usage',
      'GET /metrics',
      'POST /v1/pair/code',
      'GET /v1/pair/code/:pairingId',
      'DELETE /v1/pair/code/:pairingId',
      // Who may reach this machine, and one entry's removal. NOTE WHAT IS ABSENT: there is no route
      // that returns a device token or its digest — the list is a projection with no field for one.
      'GET /v1/pair/devices',
      'DELETE /v1/pair/devices/:deviceId',
      // One device's own grants (B5): widen at the machine, or from a device holding what it grants.
      'PATCH /v1/pair/devices/:deviceId/grants',
      // Which browsers this daemon may WAKE. NOTE WHAT IS ABSENT: no route returns a push endpoint or
      // its key halves — that triple is a bearer capability to buzz somebody's phone, and the enrolment
      // list is a projection with no field for one.
      'GET /v1/push/vapid',
      'GET /v1/push/subscriptions',
      'POST /v1/push/subscriptions',
      'DELETE /v1/push/subscriptions/:pushId',
      // The passkey step-up. NOTE WHAT IS ABSENT: no route returns a challenge after it is issued, a
      // public key or a held step-up — the daemon remembers the step-up, and the browser holds nothing.
      'GET /v1/passkeys',
      'POST /v1/passkeys/options',
      'POST /v1/passkeys',
      'POST /v1/step-up/options',
      'POST /v1/step-up',
      // A confirmation on opening (zero-trust B6).
      'POST /v1/unlock/options',
      'POST /v1/unlock',
      // The owner's recovery path: a browser is never at the machine (B4), so only `fy passkey window`
      // can re-open a device's passkey window. Without it a device past its first window is locked out.
      'POST /v1/passkeys/registration-window',
      // The machine's security settings the step-up and presence are tuned by (zero-trust B6).
      'GET /v1/security',
      'PATCH /v1/security',
      // The grant surface. NOTE WHAT IS ABSENT: there is no password to set and nothing to unlock — a
      // governed change is held behind the passkey step-up, so these three are the whole surface.
      'GET /v1/grants',
      'GET /v1/grants/audit',
      'PATCH /v1/grants',
      'GET /v1/audit',
      // The carrier refresh, beside the pairing exchange whose second half it is. NOTE WHAT IS ABSENT:
      // there is no POST, PUT or DELETE here — a device may read where this daemon can be reached and
      // can never re-point it, because that is a change to the operator's own document.
      'GET /v1/carriers',
      // The tunnel switch: whether this machine runs one, and on or off without a restart. NOTE WHAT IS
      // ABSENT: no address in either direction — a device may switch the tunnel, never re-point it.
      'GET /v1/tunnel',
      'PUT /v1/tunnel',
      // The peer-to-peer carrier's signalling, asked for inside a session that already reached the daemon.
      'POST /v1/webrtc/offer',
      'GET /v1/health',
      'GET /v1/doctor',
      'POST /v1/diagnostics/profile',
      'GET /v1/diagnostics/profile/:id',
      // The account model's credentials (docs/design/account-model.md §7). NOTE WHAT IS ABSENT: no
      // route returns a token, a refresh token or a digest — only status and usage — and there is no
      // sign-out or label route, because both are reviewed changes.
      'GET /v1/fleet/credentials',
      'POST /v1/fleet/credentials/:credentialId/check',
      // Environment logins: the preset catalogue a login is made from, and a login's Test, which spends
      // its key once through the outbound holder and answers a code — never the key, never the reply.
      'POST /v1/fleet/credentials/:credentialId/test',
      'GET /v1/fleet/presets',
      // The account model's catalogue and its reviewed changes. Every write is a staged change and its
      // explicit apply; there is no route that edits the configuration directly.
      'GET /v1/fleet/machine',
      'GET /v1/fleet/components',
      'GET /v1/fleet/profiles',
      'POST /v1/fleet/profiles/preview',
      'GET /v1/fleet/runtimes',
      'POST /v1/fleet/proposals',
      'GET /v1/fleet/proposals/:proposalId',
      'POST /v1/fleet/proposals/:proposalId/apply',
      // A machine's setup. The import and the clone are reviewed changes above; these are the scan they
      // start from, the export a clone carries, and the tool install.
      'GET /v1/fleet/setup/scan',
      'POST /v1/fleet/machine/tools/install',
      'GET /v1/fleet/export',
      // Driving a harness’s own sign-in. NOTE WHAT IS ABSENT: no route here accepts or returns a
      // provider token. Two values go out — a verification URL, and for Codex a device code — and one
      // short-lived authorization code comes in, straight to the harness child’s stdin. Every route here is
      // `fleet.configure`, because the risk is login substitution rather than disclosure.
      'POST /v1/fleet/login',
      'GET /v1/fleet/login/:flowId',
      'POST /v1/fleet/login/:flowId',
      'DELETE /v1/fleet/login/:flowId',
      // Signing in to a remote MCP server (docs/mcp-oauth.md). NOTE WHAT IS ABSENT: no route returns a
      // token. The daemon is the OAuth client and files them in the secret store; an authorization URL goes
      // out and one callback address comes in, in a body.
      'GET /v1/fleet/mcp-auth',
      'POST /v1/fleet/mcp-auth/:component',
      'DELETE /v1/fleet/mcp-auth/:component',
      'POST /v1/fleet/mcp-auth/flows/:flowId',
      'DELETE /v1/fleet/mcp-auth/flows/:flowId',
      'GET /v1/mcp',
      'POST /v1/mcp/check',
      'GET /v1/sessions/:sessionId/mcp/servers',
      // Resource limits, beside the fleet they bound. NOTE WHAT IS ABSENT: there is no POST and no
      // DELETE — an operator narrows or widens one saved document, and nothing here creates or
      // destroys a slice, because the units are transient and belong to the launches that made them.
      'GET /v1/cgroups/config',
      'PATCH /v1/cgroups/config',
      // The configuration files (docs/config-files.md): what is in effect, one file, an edit and the owner's
      // confirmation of one that loosens. NOTE WHAT IS ABSENT: no route deletes a file or edits the accepted
      // record, and an agent's own door is the privileged `POST /v1/agent/config` below.
      'GET /v1/config/status',
      'GET /v1/config/file',
      'PUT /v1/config/file',
      'POST /v1/config/confirm',
      'POST /v1/agent/config',
      // Imported harness history is deliberately not a session route: it can be read but has no
      // daemon journal, lifecycle, pane, or resume/send control.
      'GET /v1/imports/history',
      'GET /v1/imports/history/:importId',
      // Existing conversations kept as ferrets: listed and searched, then adopted into sessions that
      // RESUME them, with the last few exchanges of one on request. All are fleet.configure; none
      // returns a whole transcript or a file path.
      'GET /v1/imports/conversations',
      'GET /v1/imports/conversations/:harness/:conversationId/preview',
      'POST /v1/imports/conversations/adopt',
      'GET /v1/gc',
      'POST /v1/gc',
      // Handing a web address to the OS opener. Operator + privileged arrival: a remote caller is refused.
      'POST /v1/system/open-url',
      // The secret store. NOTE WHAT IS ABSENT: there is no `GET /v1/secrets/:name`, and this list is
      // the proof of it — no route returns a secret value. `use` is how a value is spent instead.
      'GET /v1/secrets',
      'POST /v1/secrets/use',
      'POST /v1/secrets',
      'DELETE /v1/secrets/:name',
      // Copying to another machine: an offer, ciphertext only the target opens, and the names filed.
      'POST /v1/secrets/imports',
      'POST /v1/secrets/imports/:importId',
      'POST /v1/secrets/exports/:importId',
      'GET /v1/sessions',
      'GET /v1/sessions/:sessionId',
      'GET /v1/projects',
      'POST /v1/projects',
      'GET /v1/sessions/:sessionId/skills',
      'GET /v1/sessions/:sessionId/skills/inventory',
      'GET /v1/skills',
      'GET /v1/skills/file',
      'GET /v1/worktrees/removal',
      'POST /v1/worktrees/remove',
      'GET /v1/worktrees',
      'POST /v1/worktrees',
      'POST /v1/sessions',
      'POST /v1/sessions/:sessionId/stop',
      'GET /v1/sessions/by-request/:requestId',
      'POST /v1/sessions/:sessionId/resume',
      'GET /v1/sessions/:sessionId/relaunch-settings',
      'POST /v1/sessions/:sessionId/conversion-preview',
      'POST /v1/sessions/:sessionId/migrate',
      'POST /v1/sessions/:sessionId/handover',
      'GET /v1/sessions/:sessionId/handover',
      'POST /v1/sessions/:sessionId/handover/cancel',
      'POST /v1/sessions/:sessionId/fork',
      'GET /v1/sessions/:sessionId/runtime-models',
      'POST /v1/sessions/:sessionId/runtime',
      'POST /v1/sessions/:sessionId/signal',
      'POST /v1/sessions/:sessionId/rename',
      'PATCH /v1/sessions/:sessionId/hypermedia',
      'GET /v1/sessions/:sessionId/agenda-mode',
      'PATCH /v1/sessions/:sessionId/agenda-mode',
      'GET /v1/pack',
      'GET /v1/pack/inventory',
      'POST /v1/pack/routing/clean-up',
      'GET /v1/pack/routing/jobs/:jobId',
      'POST /v1/pack/routing/accept',
      'POST /v1/pack/routing/undo',
      'POST /v1/pack/recommend',
      'POST /v1/pack/new',
      'GET /v1/sessions/:sessionId/result',
      'PATCH /v1/sessions/:sessionId/pack',
      'POST /v1/sessions/:sessionId/mcp/project/preview',
      'POST /v1/sessions/:sessionId/mcp/login/preview',
      'POST /v1/sessions/:sessionId/mcp/project',
      'POST /v1/sessions/:sessionId/mcp/login',
      'GET /v1/sessions/:sessionId/mcp',
      'POST /v1/sessions/:sessionId/send',
      'POST /v1/sessions/:sessionId/interrupt',
      'GET /v1/sessions/:sessionId/sends',
      'GET /v1/sessions/:sessionId/sends/:sendId',
      'GET /v1/sessions/:sessionId/handoffs/:name',
      'POST /v1/sessions/:sessionId/sends/:sendId/retry',
      'POST /v1/sessions/:sessionId/sends/:sendId/cancel',
      'POST /v1/sessions/:sessionId/sends/:sendId/enter',
      'POST /v1/sessions/:sessionId/composer',
      'POST /v1/sessions/:sessionId/answer',
      'POST /v1/sessions/:sessionId/attachments',
      'GET /v1/sessions/:sessionId/attachments/:attachmentId',
      'POST /v1/sessions/:sessionId/attachments/:attachmentId/unlock',
      'DELETE /v1/sessions/:sessionId/attachments/:attachmentId/unlock',
      'GET /v1/sessions/:sessionId/attention',
      'POST /v1/sessions/:sessionId/attention',
      'POST /v1/sessions/:sessionId/attention/replies',
      'POST /v1/sessions/:sessionId/notify',
      'GET /v1/sessions/:sessionId/pins',
      'POST /v1/sessions/:sessionId/pins',
      'GET /v1/tasks',
      'GET /v1/sessions/:sessionId/tasks',
      'POST /v1/sessions/:sessionId/tasks',
      'GET /v1/sessions/:sessionId/tasks/:taskId',
      'POST /v1/sessions/:sessionId/tasks/:taskId',
      // The board MEMBERSHIP surface. Two of the CLI's eleven board routes are absent on purpose:
      // `/mark-done` and `/grants/revoke` have no reducer in the domain at all. `/coordinator/replace`
      // was a third until the non-session `human_admin` principal was restored — its authority was
      // never undecided, only unported. See the mount's header; this list is the proof of exactly
      // which ten are real.
      'GET /v1/task-boards/membership',
      'POST /v1/task-boards/create',
      'POST /v1/task-boards/child-grants/request',
      'POST /v1/task-boards/child-grants/approve',
      'POST /v1/task-boards/invitations/request',
      'POST /v1/task-boards/invitations/approve',
      'POST /v1/task-boards/invitations/accept',
      'POST /v1/task-boards/invitations/verify',
      'POST /v1/task-boards/membership/relinquish',
      'POST /v1/task-boards/coordinator/replace',
      'GET /v1/analytics',
      'GET /v1/analytics/pricing',
      'PATCH /v1/analytics/pricing',
      'POST /v1/analytics/pricing/sync/preview',
      'POST /v1/analytics/pricing/sync/apply',
      // The agent tools. The agent's own route names no session: its session is the credential it
      // presents. A person's live under `…/surfaces`, where nothing else can shadow them.
      'POST /v1/agent/tools',
      'POST /v1/sessions/:sessionId/surfaces/terminals/tools',
      'POST /v1/sessions/:sessionId/surfaces/terminals/control',
      'GET /v1/sessions/:sessionId/surfaces/terminals/control',
      'POST /v1/sessions/:sessionId/surfaces/browser/tools',
      'POST /v1/sessions/:sessionId/surfaces/browser/control',
      'GET /v1/sessions/:sessionId/surfaces/browser/control',
      'GET /v1/sessions/:sessionId/terminals',
      'POST /v1/sessions/:sessionId/terminals',
      'GET /v1/sessions/:sessionId/terminals/:terminalId',
      'POST /v1/sessions/:sessionId/terminals/:terminalId',
      'DELETE /v1/sessions/:sessionId/terminals/:terminalId',
      // The human login window, and the per-session automation that is now genuinely served: the
      // browser session runtime composes the worker and its transport into a production
      // `BrowserViewerHost`, so the read and the action are real; its viewer opens inside a session.
      'GET /v1/browser/login',
      'POST /v1/browser/login',
      'GET /v1/sessions/:sessionId/browser',
      'POST /v1/sessions/:sessionId/browser',
      'GET /v1/names',
      'GET /v1/learning/status',
      'GET /v1/learning/config',
      'GET /v1/learning/proposals',
      'POST /v1/learning/proposals/:id',
      'GET /v1/learning/proposals/:id/patch',
      'POST /v1/learning/run',
      'PATCH /v1/learning/config',
      'GET /v1/learning/proposals/:id/apply-preview',
      'POST /v1/learning/proposals/:id/apply',
      'GET /v1/learning/sessions',
      'PATCH /v1/sessions/:sessionId/learning',
      'POST /v1/learning/scan/estimate',
      'POST /v1/learning/scan/cancel',
      'GET /v1/learning/scan',
      'POST /v1/learning/scan',
      'POST /v1/agent/lessons',
      'POST /v1/recommend',
      // Dictation enhancement: the daemon's one remaining speech-to-text route, and a fixed literal
      // under a prefix no other subsystem uses. Recognition happens in the browser.
      'POST /v1/stt/enhance',
      // Speed-up keys: which are set (by name), and a Test that spends one once. No key on either.
      'GET /v1/speedups',
      'POST /v1/speedups/:provider/test',
      // The model catalogs: the list, a check for a newer published catalog, and a read of the models Ollama
      // has installed on this machine. Fixed literals, no other user.
      'GET /v1/models',
      'POST /v1/models/refresh',
      'POST /v1/models/local/refresh',
      // Updating this daemon: the view, starting an update, and the automatic-install setting.
      'GET /v1/daemon/update',
      'POST /v1/daemon/update',
      'PATCH /v1/daemon/update/settings',
      // Updating the agent CLIs: the view, and starting one harness's update.
      'GET /v1/harnesses/update',
      'POST /v1/harnesses/update',
      // The working-tree read. Its four deeper paths come before the one-segment `fs`, which is what
      // keeps `fs/file` reachable at all: the router matches in registration order.
      'GET /v1/sessions/:sessionId/fs/file',
      'GET /v1/sessions/:sessionId/fs/index',
      'GET /v1/sessions/:sessionId/fs/changes',
      'GET /v1/sessions/:sessionId/fs/diff',
      'GET /v1/sessions/:sessionId/fs',
      // Fleet supervision. Every path is under `/v1/warden`, which no other subsystem uses, and the
      // subsystem also owns the sweep TIMER — a supervision loop with no route would be invisible to
      // the reachability gate, which is how a background subsystem ships unmounted.
      'GET /v1/warden/status',
      'GET /v1/warden/verdicts',
      'GET /v1/warden/report',
      'POST /v1/warden/run',
      'GET /v1/warden/attention',
      'POST /v1/warden/investigate',
      'POST /v1/warden/leave',
      'GET /v1/warden/config',
      'PATCH /v1/warden/config',
      // The operator reads: the history the daemon recorded, the screen the agent is looking at, and
      // the transcript it wrote. Every one of these answered `unknown_route` while the protocol
      // client carried a method for it — see the mount's own header.
      'GET /v1/sessions/:sessionId/events',
      'GET /v1/sessions/:sessionId/snapshot',
      'GET /v1/sessions/:sessionId/logs',
      'GET /v1/sessions/:sessionId/messages',
      'GET /v1/sessions/:sessionId/transcript-images/:handle',
      // The attach proof. It sits with the operator reads but authorizes a local process action
      // rather than answering a question, which is why it is its own mount and its own literal.
      'GET /v1/sessions/:sessionId/attach',
      'POST /v1/sessions/:sessionId/console/input',
      'GET /v1/sessions/:sessionId/processes',
      'GET /v1/sessions/:sessionId/processes/:processId/output',
      'POST /v1/sessions/:sessionId/processes/:processId/stop',
      'POST /v1/sessions/:sessionId/permission',
      'POST /v1/sessions/:sessionId/dialog',
    ]);
  });

  it('should never let a subsystem pattern shadow a base feed', () => {
    // The base feeds are fixed literal paths, so registration order cannot hide one behind a
    // parameterised subsystem route. Asserting it here means a future mount cannot break liveness.
    // Arrange
    const routes = mountedDaemonRoutes(base, subsystems());

    // Act
    const firstLiteral = routes.findIndex(route => route.path === '/healthz');
    const firstPattern = routes.findIndex(route => route.path.includes(':'));

    // Assert
    should(firstLiteral).be.below(firstPattern);
  });

  it('should dispatch a base feed and a subsystem route through the same dispatcher', async () => {
    // Arrange
    // REFRESHED FIRST, exactly as the composition root does before it binds an address. A service
    // that has never read its document enforces `undetermined` — denied — on every governed route,
    // which is the correct fail-closed reading and not the state a serving daemon is ever in.
    const mounted = subsystems();
    await mounted.grants.refresh();
    const dispatcher = createMountedDispatcher(base, mounted);

    // Act
    const health = await dispatcher.dispatch(request({ path: '/healthz' }));
    const report = await dispatcher.dispatch(request({ path: '/v1/health', headers: human }));
    const doctor = await dispatcher.dispatch(request({ path: '/v1/doctor', headers: human }));
    const gc = await dispatcher.dispatch(request({ path: '/v1/gc', headers: human }));
    const sessions = await dispatcher.dispatch(request({ path: '/v1/sessions', headers: human }));
    const session = await dispatcher.dispatch(request({ path: '/v1/sessions/s1', headers: human }));
    // The same session by its agent's NAME, in any case: the table resolves it before the read runs.
    const named = await dispatcher.dispatch(request({ path: '/v1/sessions/Aniya', headers: human }));
    const projects = await dispatcher.dispatch(request({ path: '/v1/projects', headers: human }));
    const skills = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/skills', headers: human }));
    const pins = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/pins', headers: human }));
    const attention = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/attention', headers: human }));
    const tasks = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human }));
    const fleet = await dispatcher.dispatch(request({ path: '/v1/tasks', headers: human }));
    const analytics = await dispatcher.dispatch(request({ path: '/v1/analytics', headers: human }));
    const importedHistory = await dispatcher.dispatch(request({ path: '/v1/imports/history', headers: human }));
    const importedConversation = await dispatcher.dispatch(
      request({ path: '/v1/imports/history/imported-one', headers: human }),
    );
    const missingImportedConversation = await dispatcher.dispatch(
      request({ path: '/v1/imports/history/not-found', headers: human }),
    );
    // A terminal is a USE that a caller off this host may make only behind a live passkey step-up, so
    // the listing is asked from the host and the remote form is asked as well, refused by the grant.
    const terminals = await dispatcher.dispatch(
      request({ path: '/v1/sessions/s1/terminals', headers: human, loopback: true }),
    );
    const remoteTerminals = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/terminals', headers: human }));
    const learning = await dispatcher.dispatch(request({ path: '/v1/learning/status', headers: human }));
    // The login window, over the same dispatcher: the route `fy browser login` and the PWA's banner
    // have both spoken since they were ported, against a daemon that answered `unknown_route`. It is a
    // browser USE, so it is asked from the host.
    const login = await dispatcher.dispatch(request({ path: '/v1/browser/login', headers: human, loopback: true }));
    // The write half of the session surface, over the same dispatcher: a stop of a session the
    // fixture holds, which an unmounted route would answer as `unknown_route`.
    const stopped = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/stop', headers: human, body: '{}' }),
    );
    // The revive, over the same dispatcher: the route the protocol client's `resume` speaks, which
    // answered `unknown_route` until the resume service was mounted behind it.
    const revived = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/resume', headers: human, body: '{}' }),
    );
    // The migration, over the same dispatcher: the route the protocol client's `migrate` speaks,
    // which answered `unknown_route` while the safety gate that guards it sat constructed and
    // uncalled in the world.
    const migrated = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/migrate',
        // A migration names its logical request id, so a retried POST is one migration rather than
        // several destructive relaunches; the route refuses one that carries none.
        headers: { ...human, 'x-fy-request-id': 'surface-migration' },
        body: JSON.stringify({ agent: 'claude-auto-other' }),
      }),
    );

    // The three operator reads, over the same dispatcher: every one of them answered `unknown_route`
    // while the protocol client carried a method that spoke to it.
    const events = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/events', headers: human }));
    const screen = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/snapshot', headers: human }));
    const transcript = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/logs', headers: human }));
    // The attach proof, over the same dispatcher and against the REAL attach service: a tmux address
    // is only meaningful on the daemon's own host, so the mount demands loopback on top of `admin`.
    const attach = await dispatcher.dispatch(
      request({ path: '/v1/sessions/s1/attach', headers: human, loopback: true }),
    );
    const remoteAttach = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/attach', headers: human }));
    const importedHistoryBody = importedHistory.body;
    const importedConversationBody = importedConversation.body;

    // Assert
    should(health.status).equal(200);
    // The liveness probe and the scoped report are two different answers under one subject, and both
    // are reached: the daemon's own health is a mounted subsystem now, not a hardcoded literal.
    should(report.status).equal(200);
    should(doctor.status).equal(200);
    should(gc.status).equal(200);
    should(sessions.status).equal(200);
    // The id pattern is reached rather than shadowed by the deeper per-session routes below it.
    should(session.status).equal(200);
    should(named.status).equal(200);
    should(named.body).equal(session.body);
    should(projects.status).equal(200);
    should(skills.status).equal(200);
    // The session is unknown to this fixture, which still proves the route is mounted and reached.
    should(pins.status).equal(404);
    should(attention.status).equal(200);
    should(tasks.status).equal(200);
    should(fleet.status).equal(200);
    should(analytics.status).equal(200);
    should(importedHistory.status).equal(200);
    should(importedConversation.status).equal(200);
    should(missingImportedConversation.status).equal(404);
    should(importedHistoryBody).containEql('"count":2');
    should(importedHistoryBody).not.containEql('/fixture/');
    should(importedConversationBody).containEql('record identifier');
    should(importedConversationBody).not.containEql('must not be exposed');
    should(terminals.status).equal(200);
    should(remoteTerminals.status).equal(403);
    should(remoteTerminals.body).containEql('grant_step_up_required');
    should(learning.status).equal(200);
    should(login.status).equal(200);
    should(stopped.status).equal(200);
    should(revived.status).equal(200);
    should(migrated.status).equal(200);
    should(events.status).equal(200);
    should(screen.status).equal(200);
    should(transcript.status).equal(200);
    should(attach.status).equal(200);
    should(remoteAttach.status).equal(403);
  });

  it('should validate the GC plan and force request before reaching the collector', async () => {
    // Arrange
    const limits: number[] = [];
    const forces: boolean[] = [];
    const dispatcher = createMountedDispatcher(
      base,
      subsystems({
        plan: async limit => {
          limits.push(limit);
          return [];
        },
        sweep: async force => {
          forces.push(force);
          return { sessions: 0, bytes: 0, failures: 0 };
        },
      }),
    );

    // Act
    const planned = await dispatcher.dispatch(request({ path: '/v1/gc', query: [['limit', '7']], headers: human }));
    const forced = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/gc', headers: human, body: JSON.stringify({ force: true }) }),
    );
    const invalid = await dispatcher.dispatch(request({ path: '/v1/gc', query: [['limit', '0']], headers: human }));
    const unknown = await dispatcher.dispatch(request({ path: '/v1/gc', query: [['other', '1']], headers: human }));

    // Assert
    should([planned.status, forced.status, invalid.status, unknown.status]).deepEqual([200, 200, 400, 400]);
    should(limits).deepEqual([7]);
    should(forces).deepEqual([true]);
  });

  it('should serve every protocol-switching route from one table too', () => {
    // The same "is it mounted" assertion as above, for the surface that answers with a socket rather
    // than a body. A stream missing from here is a capability the product does not have, however
    // completely `TerminalStreamBridge` is built and tested.
    // Arrange / Act
    const routes = mountedSocketRoutes(subsystems()).map(route => `${route.method} ${route.path}`);

    // Assert — the fixed literal is registered FIRST, which is what keeps the deeper terminal pattern
    // reachable: the router matches in registration order and neither path can shadow the other.
    should(routes).deepEqual([
      'GET /v1/events',
      'GET /v1/sessions/:sessionId/terminals/:terminalId/stream',
      'GET /v1/sessions/:sessionId/browser/stream',
    ]);
  });

  // THERE IS NO THIRD TABLE. A route that answered with the transport's own `Response` existed for
  // one subsystem only — the daemon's speech recognition, whose traffic was audio in and ranged model
  // files out. Recognition moved into the browser, and the seam went with it rather than staying as a
  // table with no members. The one surviving dictation route is JSON, and it is asserted above.

  it('should authorize a protocol switch over the same credentials as the HTTP surface', async () => {
    // Two dispatchers, one credential set. A socket dispatcher built from different credentials would
    // be a second, quieter authorization boundary, and the two would drift.
    // Arrange
    const mounted = subsystems();
    await mounted.grants.refresh();
    const dispatcher = createMountedSocketDispatcher(base, mounted);
    const path = '/v1/sessions/s1/terminals/0123456789ab/stream';

    // Act
    const anonymous = await dispatcher.upgrade(request({ path }));
    const authorized = await dispatcher.upgrade(request({ path, headers: human, loopback: true }));
    // A terminal socket from off this host is a terminal USE: held until the device steps up.
    const remote = await dispatcher.upgrade(request({ path, headers: human }));
    // The event feed, over the SAME socket dispatcher: an anonymous peer never holds it, and the
    // fleet form is accepted without naming a session at all.
    const anonymousEvents = await dispatcher.upgrade(request({ path: '/v1/events' }));
    const fleetEvents = await dispatcher.upgrade(request({ path: '/v1/events', headers: human }));

    // Assert
    should(anonymous.outcome === 'refused' ? anonymous.response.status : 0).equal(401);
    should(anonymousEvents.outcome === 'refused' ? anonymousEvents.response.status : 0).equal(401);
    should(fleetEvents.outcome).equal('accepted');
    // The terminal does not exist in this fixture, which still proves the route is mounted, reached,
    // and that existence is decided BEFORE any protocol switch.
    should(authorized.outcome === 'refused' ? authorized.response.status : 0).equal(404);
    should(remote.outcome === 'refused' ? remote.response.status : 0).equal(403);
  });

  it('should refuse a terminal SOCKET the operator has not granted', async () => {
    // THE HOLE THIS CLOSES. A socket table that skipped the grant check would have the daemon refuse
    // to CREATE a terminal an operator had denied and then hand a browser the socket that drives one.
    // Both tables go through the one authorization boundary, so there is one answer rather than two.
    // Arrange
    const mounted = {
      ...subsystems(),
      grants: grantSubsystem({ grants: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } } }),
    };
    await mounted.grants.refresh();
    const sockets = createMountedSocketDispatcher(base, mounted);
    const http = createMountedDispatcher(base, mounted);
    const path = '/v1/sessions/s1/terminals/0123456789ab/stream';

    // Act — a caller that did NOT arrive over loopback, which is the only caller grants govern.
    const upgrade = await sockets.upgrade(request({ path, headers: human, loopback: false }));
    const created = await http.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/terminals', headers: human, loopback: false }),
    );

    // Assert — the same refusal on both, and it names the next step rather than saying "forbidden".
    should(upgrade.outcome === 'refused' ? upgrade.response.status : 0).equal(403);
    should(created.status).equal(403);
    should(created.body).match(/has not granted the UI the use of session terminals/u);

    // And a LOOPBACK caller is unaffected: somebody at the machine already has the machine.
    const local = await sockets.upgrade(request({ path, headers: human, loopback: true }));
    should(local.outcome === 'refused' ? local.response.status : 0).equal(404);
  });
});

describe('the audited surface', () => {
  const routes = mountedDaemonRoutes(base, subsystems()).map(route => `${route.method} ${route.path}`);
  const sockets = mountedSocketRoutes(subsystems()).map(route => `${route.method} ${route.path}`);
  const audited = AUDITED_ROUTES.map(rule => `${rule.method} ${rule.path}`);
  const auditedSockets = AUDITED_SOCKET_ROUTES.map(rule => `GET ${rule.path}`);

  it('should record or explicitly excuse every route that changes something', () => {
    const unreviewed = routes
      .filter(route => !route.startsWith('GET '))
      .filter(route => !audited.includes(route) && NOT_AUDITED[route] === undefined);
    should(unreviewed).eql([]);
  });

  it('should record or explicitly excuse every socket', () => {
    should(sockets.filter(route => !auditedSockets.includes(route) && NOT_AUDITED_SOCKETS[route] === undefined)).eql(
      [],
    );
  });

  it('should keep no stale rule and no stale excuse', () => {
    // A rule for a route that is not mounted records nothing, and an excuse for one that is audited, or
    // is gone, is a review that no longer describes the code.
    should(audited.filter(route => !routes.includes(route))).eql([]);
    should(auditedSockets.filter(route => !sockets.includes(route))).eql([]);
    should(Object.keys(NOT_AUDITED).filter(route => !routes.includes(route) || audited.includes(route))).eql([]);
    should(
      Object.keys(NOT_AUDITED_SOCKETS).filter(route => !sockets.includes(route) || auditedSockets.includes(route)),
    ).eql([]);
  });

  it('should give every excuse a reason', () => {
    should(Object.values({ ...NOT_AUDITED, ...NOT_AUDITED_SOCKETS }).filter(reason => reason.length < 20)).eql([]);
  });
});
