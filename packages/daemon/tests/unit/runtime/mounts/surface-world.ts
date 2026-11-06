import type { DaemonId } from '@ferretry/protocol';
import { BrowserProxyTester } from '../../../../src/lib/browser/proxy/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { HandoverReconcileLoop } from '../../../../src/lib/handover/index.ts';
import { NO_PERFORMANCE_PROBE } from '../../../../src/lib/performance/recorder.ts';
import {
  type MountedSubsystems,
  type PairingSubsystem,
  type ScratchGcSubsystem,
} from '../../../../src/lib/runtime/index.ts';
import type { CatalogLinkSubsystem } from '../../../../src/lib/runtime/mounts/catalog-links.ts';
import type { CatalogMemberSubsystem } from '../../../../src/lib/runtime/mounts/catalog-members.ts';
import type { SharedCatalogSubsystem } from '../../../../src/lib/runtime/mounts/shared-catalogs.ts';
import { PasteRuleService, PasteRuleStages } from '../../../../src/lib/secure-copy/index.ts';
import { SecuritySettingsService } from '../../../../src/lib/security/index.ts';
import { SessionFilesystem } from '../../../../src/lib/session/filesystem/index.ts';
import { OperatorReadService } from '../../../../src/lib/session/reads/index.ts';
import { SharedDraftPresence } from '../../../../src/lib/shared-drafts/index.ts';
import { SignInRuleService, SignInRuleSuggestions } from '../../../../src/lib/sign-in-rules/index.ts';
import { ChallengeLedger, StepUpRegistry, StepUpService } from '../../../../src/lib/step-up/index.ts';
import { TaskPlanService } from '../../../../src/lib/task-plans/index.ts';
import { MemoryTranscript } from '../../../support/transcript-images.ts';
import { agentToolWorld } from '../../agent-tools/support.ts';
import { fixedClock } from '../../api/support.ts';
import { inputRequestService } from '../../input-requests/support.ts';
import { FakeRootPinner, FakeSessionGit } from '../../session/filesystem/support.ts';
import {
  agendaService,
  attachSubsystem,
  boardSubsystem,
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
  FakeTerminals,
  FakeWarden,
  fleetEventSubsystem,
  grantSubsystem,
  healthSubsystem,
  NO_HELD_REPLIES,
  nameSubsystem,
  permissionSubsystem,
  recommendSubsystem,
  secretSubsystem,
  sessionDirectory,
  sessionView,
  sharedDraftService,
} from './support.ts';

/**
 * The complete surface the daemon process serves.
 *
 * This is the test that catches the migration's recurring defect: a subsystem built, tested and
 * never mounted. A route missing from this table is a capability the product does not have.
 */

export const base = {
  credentials: CREDENTIALS,
  usage: emptyFeed,
  clock: fixedClock(1_700_000_000_000),
  startedAtMs: 0,
  publicUsageFeed: () => true,
};

const pairingSubsystem = (): PairingSubsystem => ({
  daemonId: `fy_daemon_${'a'.repeat(43)}` as DaemonId,
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

export const subsystems = (scratchGc?: ScratchGcSubsystem): MountedSubsystems => ({
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
  pushAlerts: { seen: async () => ({ found: true, tags: [] }) },
  stepUp: stepUpSubsystem(),
  // The published set's one view, which the pairing service reads too. Non-empty on purpose — an empty
  // one would let `PairingResponseSchema`'s default stand in for a carried-through set.
  carriers: {
    current: () => [
      { kind: 'direct', url: 'https://workstation.example.test' },
      { kind: 'relay', url: 'wss://rendezvous.example.test/fy' },
    ],
  },
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
    reviewClone: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    forgetCloneSource: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    recordCloneKeys: async () => {
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
      discard: async () => {
        throw new Error('not exercised by the surface inventory');
      },
    },
    agentControl: { allows: async () => false },
    identities: { resolve: async () => undefined },
    arm: async () => () => undefined,
  },
  // Like the monitor loop, this serves no route. Its presence proves the daemon
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
  attention: agendaService(),
  agendaReplies: NO_HELD_REPLIES,
  machineAgenda: {} as never,
  agendaClearer: {
    preview: async () => ({ cleared: 0, sessions: 0 }),
    clear: async () => ({ cleared: 0, sessions: 0 }),
  } as never,
  agendaRollup: { page: async () => ({ sessions: [] }) } as never,
  notifications: {
    enrolledDevices: async () => 0,
  },
  sharedDrafts: sharedDraftService(['s1']),
  sharedDraftStream: {
    presence: new SharedDraftPresence(),
    deviceName: async () => 'Phone',
    nextPeer: () => 'peer-1',
    clock: { nowMs: () => 0 },
  },
  sessions: sessionDirectory([sessionView('s1')]),
  sessionArchive: { count: () => 0, list: async () => [] },
  sessionAddresses: {
    has: id => id === 's1',
    candidates: async () => [{ id: 's1', name: 'aniya', status: 'running' }],
  },
  boardProjects: {
    projects: async () => [],
    project: async () => undefined,
    projectOf: async () => 'unfiled',
    apply: async () => ({ ok: false, error: { code: 'not-found', projectId: 'unfiled' } }),
  },
  boardSwitches: {
    read: async projectId => ({ projectId, on: false, setBy: 'default', setAt: null }),
    set: async (projectId, on) => ({ projectId, on, setBy: 'owner', setAt: '2026-11-01T12:00:00.000Z' }),
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
  sessionCredential: {
    revoke: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  sessionResume: new FakeSessionResume(),
  sessionSend: new FakeSessionSend(),
  sendTracking: { arm: () => () => {} },
  sendReproof: { run: async () => undefined, stop: () => undefined },
  queueDelivery: { arm: async () => undefined, stop: async () => undefined },
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
  sessionCompactAt: {
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
    subtree: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    setSwitch: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  catalogInstalls: {
    setPrefs: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    list: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    preview: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    apply: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    remove: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  localSkillInstalls: {
    list: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    preview: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    apply: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    remove: async () => {
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
  sessionRestart: {
    restart: async () => ({ restarted: [], queued: [], skipped: [], failed: [] }),
    status: async () => ({ outdated: [], queued: [] }),
    cancel: async () => ({ cancelled: 0 }),
    drain: async () => undefined,
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
  // The reconciler serves no route, for the reason the declared-wait loop does not:
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
  legacyTasks: { now: () => '2026-07-30T12:00:00.000Z' },
  board: boardSubsystem(),
  boardGitHub: { arm: () => () => undefined },
  tidy: {
    plan: async sessionId => ({
      ok: true,
      plan: { v: 1, sessionId, subFerret: false, drop: [], close: [], keep: [] },
    }),
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
  browserProxy: {
    tester: new BrowserProxyTester({
      saved: async () => undefined,
      secrets: async () => new Map(),
      probe: {
        run: async () => {
          throw new Error('not exercised by the surface inventory');
        },
      },
      now: () => 0,
    }),
    state: () => ({ state: 'stopped' }),
  },
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
    filesOnPage: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    scriptOnPage: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    closePage: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    inputOnPage: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    lifecycleOnPage: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    adoptPage: async () => {
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
  inputRequests: inputRequestService().service,
  secureCopy: (() => {
    const rules = new PasteRuleService({
      store: { read: async () => undefined, write: async () => undefined },
      clock: { now: () => 0 },
      ids: { ruleId: () => '0'.repeat(32) },
      warn: () => undefined,
    });
    const plans = new TaskPlanService({
      agenda: {
        raise: async () => ({ ok: false, message: 'not exercised by the surface inventory' }),
        close: async () => undefined,
      },
      rules,
      accounts: { listing: async () => ({ accounts: [], signIns: [] }), keyOf: async () => undefined },
      passkeys: { any: async () => false },
      redact: async text => text,
      audit: { record: async () => undefined },
      tell: async () => undefined,
      clock: { now: () => 0 },
      ids: { planId: () => '0'.repeat(32) },
    });
    return {
      copies: { list: () => [] },
      rules,
      plans,
      stages: new PasteRuleStages({ rules, clock: { now: () => 0 } }),
    };
  })(),
  // Only its routes are read here: nothing is staged, so no port is reached.
  signInRules: new SignInRuleService({
    store: { read: async () => undefined, write: async () => undefined, setAside: async () => undefined },
    accounts: { listing: async () => ({ accounts: [], signIns: [], keys: new Map() }) },
    proofs: { holds: async () => false, verify: async () => false },
    passkeys: { any: async () => false, of: async () => false },
    audit: { record: async () => undefined },
    clock: { now: () => 0 },
    warn: () => undefined,
  }),
  signInRuleSuggestions: new SignInRuleSuggestions({
    accounts: { listing: async () => ({ accounts: [], signIns: [], keys: new Map() }) },
    agenda: {
      raise: async () => ({ ok: false, message: 'not exercised' }),
      close: async () => undefined,
    },
    redact: async text => text,
    audit: { record: async () => undefined },
    clock: { now: () => 0 },
  }),
  names: nameSubsystem(),
  recommend: recommendSubsystem(),
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
  sessionFilesystem: new SessionFilesystem(new FakeRootPinner(), new FakeSessionGit()),
  scratchGc: scratchGc ?? { plan: async () => [], sweep: async () => ({ sessions: 0, bytes: 0, failures: 0 }) },
  systemOpen: { open: async () => ({ opened: true, host: 'example.com' }) },
  secrets: secretSubsystem(),
  sharedCatalogs: { catalogs: {} as SharedCatalogSubsystem['catalogs'] },
  catalogMembers: { members: {} as CatalogMemberSubsystem['members'] },
  catalogLinks: { links: {} as CatalogLinkSubsystem['links'] },
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
