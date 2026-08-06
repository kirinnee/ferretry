import { describe, it } from 'bun:test';
import should from 'should';
import { SocketTicketRegistry } from '../../../../src/lib/api/socket-ticket.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { HandoverReconcileLoop } from '../../../../src/lib/handover/index.ts';
import {
  createMountedDispatcher,
  createMountedSocketDispatcher,
  type MountedSubsystems,
  mountedDaemonRoutes,
  mountedSocketRoutes,
  type PairingSubsystem,
  type ScratchGcSubsystem,
} from '../../../../src/lib/runtime/index.ts';
import { SessionFilesystem } from '../../../../src/lib/session/filesystem/index.ts';
import { OperatorReadService } from '../../../../src/lib/session/reads/index.ts';
import { fixedClock, request } from '../../api/support.ts';
import { FakeRootPinner, FakeSessionGit } from '../../session/filesystem/support.ts';
import {
  analyticsSubsystem,
  attachSubsystem,
  attentionService,
  CREDENTIALS,
  emptyFeed,
  FakeBrowserLogin,
  FakeSessionControl,
  FakeSessionMigrate,
  FakeSessionResume,
  FakeSessionSend,
  FakeSessionSignal,
  FakeSttEnhancer,
  FakeTaskBoards,
  FakeTerminals,
  FakeWarden,
  fleetEventSubsystem,
  grantSubsystem,
  healthSubsystem,
  human,
  learningSubsystem,
  nameSubsystem,
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
  redeem: async () => ({ kind: 'refused' }),
});

const subsystems = (scratchGc?: ScratchGcSubsystem): MountedSubsystems => ({
  health: healthSubsystem(),
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
    register: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    revoke: async () => {
      throw new Error('not exercised by the surface inventory');
    },
  },
  // A VALUE, not a subsystem, and the only field here that is one: the set is resolved once at boot and
  // the pairing service is handed the very same array. Non-empty on purpose — an empty one would let
  // `PairingResponseSchema`'s default stand in for a carried-through set.
  carriers: [
    { kind: 'direct', url: 'https://workstation.example.test' },
    { kind: 'relay', url: 'wss://rendezvous.example.test/fy' },
  ],
  fleet: {
    accounts: async () => ({ version: 1, generatedAt: '2026-01-01T00:00:00.000Z', accounts: [] }),
    config: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    environment: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    updateEnvironment: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    plan: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    usage: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    health: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    apply: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    permissions: () => {
      throw new Error('not exercised by the surface inventory');
    },
    assets: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    asset: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    propose: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    readProposal: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    authorizeProposal: async () => {
      throw new Error('not exercised by the surface inventory');
    },
    applyProposal: async () => {
      throw new Error('not exercised by the surface inventory');
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
  // Like the monitor and quota-failover loops, this serves no route. Its presence proves the daemon
  // constructs the unattended evidence pass rather than leaving its timer as unreachable code.
  fleetRefresh: { run: async () => undefined },
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
  pins: pinService([]),
  sessions: sessionDirectory([sessionView('s1')]),
  catalogs: {
    projects: async () => [],
    registerProject: async () => {
      throw new Error('not used by this surface fixture');
    },
    skills: async session => ({ harness: session.config.harness, skills: [] }),
  },
  sessionControl: new FakeSessionControl(),
  sessionResume: new FakeSessionResume(),
  sessionSend: new FakeSessionSend(),
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
  // The declared-wait loop serves no route, so it contributes nothing to the table below. It is a
  // mounted subsystem because a background loop the daemon never constructs is the same absent
  // capability as an unserved route — see the field's own comment.
  monitor: { intervalMs: 15_000, arm: () => {}, run: async () => undefined, close: async () => {} },
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
    { pendingSourceSessionIds: async () => [] },
    { every: () => () => {} },
  ),
  tasks: taskSubsystem(),
  taskBoards: new FakeTaskBoards(),
  analytics: analyticsSubsystem(),
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
    closeAll: async () => undefined,
    stream: async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined }),
  },
  names: nameSubsystem(),
  learning: learningSubsystem(),
  recommend: recommendSubsystem(),
  sttEnhancement: new FakeSttEnhancer(),
  sessionFilesystem: new SessionFilesystem(new FakeRootPinner(), new FakeSessionGit()),
  scratchGc: scratchGc ?? { plan: async () => [], sweep: async () => ({ sessions: 0, bytes: 0, failures: 0 }) },
  secrets: secretSubsystem(),
  warden: new FakeWarden(),
  sessionReads: new OperatorReadService(
    {
      replay: async () => [
        { sequence: 1, sessionId: 's1', time: '2026-01-01T00:00:00.000Z', type: 'session.created', data: {} },
      ],
    },
    { capture: async () => ({ alive: true, dead: false, text: 'screen' }) },
    { tail: async () => ({ kind: 'read', events: [] }) },
  ),
  sessionAttach: attachSubsystem(),
  fleetEvents: fleetEventSubsystem(),
  grants: grantSubsystem(),
  socketTickets: new SocketTicketRegistry({ now: () => 1_000 }, { ticket: () => `fy_ticket_${'t'.repeat(43)}` }),
});

describe('the mounted daemon surface', () => {
  it('should declare credential and privileged-arrival requirements independently', () => {
    const mounted = subsystems();
    const routes = [...mountedDaemonRoutes(base, mounted), ...mountedSocketRoutes(mounted)];
    const minima = routes.reduce<Record<string, number>>((counts, route) => {
      counts[route.minimum] = (counts[route.minimum] ?? 0) + 1;
      return counts;
    }, {});

    // The handover added three: its two writes are `operator` like the migration they sit beside, and
    // its receipt read is `authenticated`, because reading what happened to a session is a lesser
    // thing than causing it.
    should(minima).deepEqual({ none: 5, authenticated: 7, operator: 112, 'admin-token': 1 });
    should(
      routes.filter(route => route.privilegedOnly === true).map(route => `${route.method} ${route.path}`),
    ).deepEqual(['PUT /v1/grants/password', 'GET /v1/sessions/:sessionId/attach']);
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
      'POST /v1/pair',
      'POST /v1/pair/code',
      'GET /v1/pair/code/:pairingId',
      'DELETE /v1/pair/code/:pairingId',
      // Who may reach this machine, and one entry's removal. NOTE WHAT IS ABSENT: there is no route
      // that returns a device token or its digest — the list is a projection with no field for one.
      'GET /v1/pair/devices',
      'DELETE /v1/pair/devices/:deviceId',
      // Which browsers this daemon may WAKE. NOTE WHAT IS ABSENT: no route returns a push endpoint or
      // its key halves — that triple is a bearer capability to buzz somebody's phone, and the enrolment
      // list is a projection with no field for one.
      'GET /v1/push/vapid',
      'GET /v1/push/subscriptions',
      'POST /v1/push/subscriptions',
      'DELETE /v1/push/subscriptions/:pushId',
      // The grant surface. NOTE WHAT IS ABSENT: no route returns the operator password, its hash or
      // its length — `GET /v1/grants` answers with booleans and reasons, and this list is the proof.
      'GET /v1/grants',
      'GET /v1/grants/audit',
      'POST /v1/grants/unlock',
      'PATCH /v1/grants',
      'PUT /v1/grants/password',
      // The carrier refresh, beside the pairing exchange whose second half it is. NOTE WHAT IS ABSENT:
      // there is no POST, PUT or DELETE here — a device may read where this daemon can be reached and
      // can never re-point it, because that is a change to the operator's own document.
      'GET /v1/carriers',
      'GET /v1/health',
      'GET /v1/doctor',
      'GET /v1/fleet/accounts',
      'GET /v1/fleet/config',
      'GET /v1/fleet/environment',
      'PUT /v1/fleet/environment',
      'GET /v1/fleet/plan',
      'GET /v1/fleet/usage',
      'GET /v1/fleet/health',
      'POST /v1/fleet/apply',
      'GET /v1/fleet/permissions',
      'GET /v1/fleet/assets',
      'GET /v1/fleet/assets/:assetPath',
      'POST /v1/fleet/proposals',
      'GET /v1/fleet/proposals/:proposalId',
      // Host-scoped: only the host's own admin token may mint an approval, and NOTE WHAT IS ABSENT —
      // no route returns a minted code to anyone who did not just ask for it, and no read discloses
      // one at all.
      'POST /v1/fleet/proposals/:proposalId/authorize',
      'POST /v1/fleet/proposals/:proposalId/apply',
      // Resource limits, beside the fleet they bound. NOTE WHAT IS ABSENT: there is no POST and no
      // DELETE — an operator narrows or widens one saved document, and nothing here creates or
      // destroys a slice, because the units are transient and belong to the launches that made them.
      'GET /v1/cgroups/config',
      'PATCH /v1/cgroups/config',
      // Imported harness history is deliberately not a session route: it can be read but has no
      // daemon journal, lifecycle, pane, or resume/send control.
      'GET /v1/imports/history',
      'GET /v1/imports/history/:importId',
      'GET /v1/gc',
      'POST /v1/gc',
      // The secret store. NOTE WHAT IS ABSENT: there is no `GET /v1/secrets/:name`, and this list is
      // the proof of it — no route returns a secret value. `use` is how a value is spent instead.
      'GET /v1/secrets',
      'POST /v1/secrets/use',
      'POST /v1/secrets',
      'DELETE /v1/secrets/:name',
      'GET /v1/sessions',
      'GET /v1/sessions/:sessionId',
      'GET /v1/projects',
      'POST /v1/projects',
      'GET /v1/sessions/:sessionId/skills',
      'POST /v1/sessions',
      'POST /v1/sessions/:sessionId/stop',
      'GET /v1/sessions/by-request/:requestId',
      'POST /v1/sessions/:sessionId/resume',
      'POST /v1/sessions/:sessionId/migrate',
      'POST /v1/sessions/:sessionId/handover',
      'GET /v1/sessions/:sessionId/handover',
      'POST /v1/sessions/:sessionId/handover/cancel',
      'POST /v1/sessions/:sessionId/signal',
      'POST /v1/sessions/:sessionId/send',
      'POST /v1/sessions/:sessionId/interrupt',
      'POST /v1/sessions/:sessionId/answer',
      'POST /v1/sessions/:sessionId/attachments',
      'GET /v1/sessions/:sessionId/attachments/:attachmentId',
      'POST /v1/sessions/:sessionId/attachments/:attachmentId/unlock',
      'DELETE /v1/sessions/:sessionId/attachments/:attachmentId/unlock',
      'GET /v1/sessions/:sessionId/attention',
      'POST /v1/sessions/:sessionId/attention',
      'GET /v1/sessions/:sessionId/pins',
      'POST /v1/sessions/:sessionId/pins',
      'GET /v1/tasks',
      'GET /v1/sessions/:sessionId/tasks',
      'POST /v1/sessions/:sessionId/tasks',
      'GET /v1/sessions/:sessionId/tasks/:taskId',
      'POST /v1/sessions/:sessionId/tasks/:taskId',
      // The board MEMBERSHIP surface. Three of the CLI's eleven board routes are absent on purpose —
      // `/mark-done` and `/grants/revoke` have no reducer in the domain at all, and
      // `/coordinator/replace` has one whose administrator authority the wire cannot supply. See the
      // mount's header; this list is the proof of exactly which nine are real.
      'GET /v1/task-boards/membership',
      'POST /v1/task-boards/create',
      'POST /v1/task-boards/child-grants/request',
      'POST /v1/task-boards/child-grants/approve',
      'POST /v1/task-boards/invitations/request',
      'POST /v1/task-boards/invitations/approve',
      'POST /v1/task-boards/invitations/accept',
      'POST /v1/task-boards/invitations/verify',
      'POST /v1/task-boards/membership/relinquish',
      'GET /v1/analytics',
      'GET /v1/sessions/:sessionId/terminals',
      'POST /v1/sessions/:sessionId/terminals',
      'GET /v1/sessions/:sessionId/terminals/:terminalId',
      'POST /v1/sessions/:sessionId/terminals/:terminalId',
      'DELETE /v1/sessions/:sessionId/terminals/:terminalId',
      'POST /v1/sessions/:sessionId/terminals/:terminalId/stream/ticket',
      // The human login window, and the per-session automation that is now genuinely served: the
      // browser session runtime composes the worker and its transport into a production
      // `BrowserViewerHost`, so the read, the action and the viewer's ticket counter are all real.
      'GET /v1/browser/login',
      'POST /v1/browser/login',
      'GET /v1/sessions/:sessionId/browser',
      'POST /v1/sessions/:sessionId/browser',
      'POST /v1/sessions/:sessionId/browser/stream/ticket',
      'GET /v1/names',
      'GET /v1/learning/status',
      'GET /v1/learning/config',
      'GET /v1/learning/proposals',
      'POST /v1/learning/proposals/:id',
      'GET /v1/learning/proposals/:id/patch',
      'POST /v1/learning/run',
      'POST /v1/recommend',
      // Dictation enhancement: the daemon's one remaining speech-to-text route, and a fixed literal
      // under a prefix no other subsystem uses. Recognition happens in the browser.
      'POST /v1/stt/enhance',
      // The working-tree read. Its three deeper paths come before the one-segment `fs`, which is what
      // keeps `fs/file` reachable at all: the router matches in registration order.
      'GET /v1/sessions/:sessionId/fs/file',
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
      'GET /v1/warden/config',
      'PATCH /v1/warden/config',
      // The operator reads: the history the daemon recorded, the screen the agent is looking at, and
      // the transcript it wrote. Every one of these answered `unknown_route` while the protocol
      // client carried a method for it — see the mount's own header.
      'GET /v1/sessions/:sessionId/events',
      'GET /v1/sessions/:sessionId/snapshot',
      'GET /v1/sessions/:sessionId/logs',
      // The attach proof. It sits with the operator reads but authorizes a local process action
      // rather than answering a question, which is why it is its own mount and its own literal.
      'GET /v1/sessions/:sessionId/attach',
      // The ticket counters for the socket table below. They are on THIS table, not that one: a
      // browser buys a ticket over an ordinary request — the only kind that can carry a header — and
      // spends it on the upgrade.
      'POST /v1/events/ticket',
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
    const fleetAccounts = await dispatcher.dispatch(request({ path: '/v1/fleet/accounts', headers: human }));
    const gc = await dispatcher.dispatch(request({ path: '/v1/gc', headers: human }));
    const sessions = await dispatcher.dispatch(request({ path: '/v1/sessions', headers: human }));
    const session = await dispatcher.dispatch(request({ path: '/v1/sessions/s1', headers: human }));
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
    const terminals = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/terminals', headers: human }));
    const learning = await dispatcher.dispatch(request({ path: '/v1/learning/status', headers: human }));
    // The login window, over the same dispatcher: the route `fy browser login` and the PWA's banner
    // have both spoken since they were ported, against a daemon that answered `unknown_route`.
    const login = await dispatcher.dispatch(request({ path: '/v1/browser/login', headers: human }));
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
    should(fleetAccounts.status).equal(200);
    should(gc.status).equal(200);
    should(sessions.status).equal(200);
    // The id pattern is reached rather than shadowed by the deeper per-session routes below it.
    should(session.status).equal(200);
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
    const authorized = await dispatcher.upgrade(request({ path, headers: human }));
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
