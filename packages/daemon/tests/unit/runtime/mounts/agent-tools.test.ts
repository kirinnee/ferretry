import { describe, it } from 'bun:test';
import { AGENT_TOOL_MAX_TEXT_CHARS, AgentToolResultSchema, SurfaceControlViewSchema } from '@ferretry/protocol';
import should from 'should';
import type { CapabilityDemand, CapabilityGuard, GrantDecision } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  AGENT_SESSION_CAPABILITY_HEADER,
  agentToolRoutes,
  sessionCredentialDirectory,
} from '../../../../src/lib/runtime/mounts/agent-tools.ts';
import { terminalRoutes } from '../../../../src/lib/runtime/mounts/terminals.ts';
import { agentToolWorld, PREFIXED_S1 } from '../../agent-tools/support.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, GRANTED, human } from './support.ts';

/**
 * The agent tools' HTTP surface, driven through the real router and authorization boundary.
 *
 * What these cases are about is WHO the route lets act as WHICH session: the agent's route takes its
 * session from the presented credential and nothing else, and a person's routes refuse an agent. The
 * domain behind them is real; only the terminal and browser subsystems are fakes.
 */

function served(extra?: Parameters<typeof agentToolWorld>[0]) {
  const world = agentToolWorld(extra);
  const dispatch = new ApiDispatcher(
    new ApiRouter([...agentToolRoutes(world.service, world.identities), ...terminalRoutes(world.terminals)]),
    CREDENTIALS,
    GRANTED,
  );
  return { world, dispatch };
}

const json = (body: unknown) => (body === undefined ? '' : JSON.stringify(body));

/** An agent's tools server: its session credential, over loopback, and NO host token. */
const agentCall = (body: unknown, capability = 'cap-s1', extra: Readonly<Record<string, string>> = {}) =>
  request({
    method: 'POST',
    path: '/v1/agent/tools',
    headers: {
      'content-type': 'application/json',
      ...(capability === '' ? {} : { [AGENT_SESSION_CAPABILITY_HEADER]: capability }),
      ...extra,
    },
    body: json(body),
    loopback: true,
    privilegedLoopback: true,
  });

const personCall = (path: string, body: unknown, headers: Readonly<Record<string, string>> = human) =>
  request({ method: 'POST', path, headers: { ...headers, 'content-type': 'application/json' }, body: json(body) });

const deviceCall = (path: string, body: unknown) =>
  request({
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: json(body),
    device: { deviceId: 'device-1', appSession: 'app-one' },
  });

describe('the agent tools route', () => {
  it('should act for the session the credential was minted for', async () => {
    // Arrange
    const { world, dispatch } = served();

    // Act
    const opened = await dispatch.dispatch(agentCall({ tool: 'terminal.open', name: 'dev' }));
    const listed = await dispatch.dispatch(agentCall({ tool: 'terminal.list' }));

    // Assert
    should(opened.status).equal(200);
    should(AgentToolResultSchema.parse(jsonBody(opened)).summary).equal('Opened %terminal:dev.');
    should(AgentToolResultSchema.parse(jsonBody(listed)).surfaces).match([{ name: 'dev' }]);
    should((await world.terminals.list('s1')).terminals).have.length(1);
    should((await world.terminals.list('s2')).terminals).have.length(0);
  });

  it('should refuse a session header that names another session, and audit it', async () => {
    // Arrange — s2's credential, with a session header naming s1: the credential says who is calling, and a
    // header that disagrees is an attribution nothing backs.
    const { world, dispatch } = served();
    await world.terminals.create('s1', { name: 'dev' });

    // Act
    const spoofed = await dispatch.dispatch(
      agentCall({ tool: 'terminal.send', name: 'dev', text: 'rm -rf /' }, 'cap-s2', { 'x-ferretry-session-id': 's1' }),
    );
    const agreeing = await dispatch.dispatch(
      agentCall({ tool: 'terminal.list' }, 'cap-s2', { 'x-ferretry-session-id': 's2' }),
    );
    const bodyClaim = await dispatch.dispatch(agentCall({ tool: 'terminal.list', sessionId: 's1' }, 'cap-s2'));

    // Assert
    should(spoofed.status).equal(401);
    should(jsonBody(spoofed)).match({ code: 'session_mismatch' });
    should(agreeing.status).equal(200);
    should(bodyClaim.status).equal(400);
    should(world.terminals.typed.size).equal(0);
    should(world.audit.entries[0]).match({
      event: 'session.credential-refused',
      subject: 's2',
      outcome: 'refused',
      detail: { by: 'agent', reason: 'session_mismatch', route: 'POST /v1/agent/tools' },
    });
  });

  it('should take the session credential as a bearer, and still take an older one on its header', async () => {
    // Arrange — a pane launched since the prefix presents `Authorization: Bearer fys_…`; one launched
    // before it holds an unprefixed value, still accepted where it always was until that pane relaunches.
    const { world, dispatch } = served();

    // Act
    const bearer = await dispatch.dispatch(
      agentCall({ tool: 'terminal.open', name: 'dev' }, '', { authorization: `Bearer ${PREFIXED_S1}` }),
    );
    const legacy = await dispatch.dispatch(agentCall({ tool: 'terminal.list' }, 'cap-s1'));
    const unprefixedBearer = await dispatch.dispatch(
      agentCall({ tool: 'terminal.list' }, '', { authorization: 'Bearer cap-s1' }),
    );

    // Assert — both act for s1; an unprefixed value is not a bearer, so on its own it is no credential.
    should(bearer.status).equal(200);
    should((await world.terminals.list('s1')).terminals).have.length(1);
    should(AgentToolResultSchema.parse(jsonBody(legacy)).surfaces).match([{ name: 'dev' }]);
    should(unprefixedBearer.status).equal(401);
    should(jsonBody(unprefixedBearer)).match({ code: 'missing_capability' });
  });

  it('should refuse a session bearer whose header names another session', async () => {
    // Arrange
    const { world, dispatch } = served();

    // Act
    const spoofed = await dispatch.dispatch(
      agentCall({ tool: 'terminal.open', name: 'dev' }, '', {
        authorization: `Bearer ${PREFIXED_S1}`,
        'x-ferretry-session-id': 's2',
      }),
    );

    // Assert
    should(spoofed.status).equal(401);
    should(jsonBody(spoofed)).match({ code: 'session_mismatch' });
    should((await world.terminals.list('s1')).terminals).have.length(0);
    should((await world.terminals.list('s2')).terminals).have.length(0);
  });

  it('should refuse two different session credentials on one request, and audit it', async () => {
    // Arrange — s1's bearer beside s2's header: which session is calling has no single answer.
    const { world, dispatch } = served();

    // Act
    const both = await dispatch.dispatch(
      agentCall({ tool: 'terminal.open', name: 'dev' }, 'cap-s2', { authorization: `Bearer ${PREFIXED_S1}` }),
    );
    const same = await dispatch.dispatch(
      agentCall({ tool: 'terminal.list' }, PREFIXED_S1, { authorization: `Bearer ${PREFIXED_S1}` }),
    );

    // Assert
    should(both.status).equal(401);
    should(same.status).equal(200);
    should((await world.terminals.list('s2')).terminals).have.length(0);
    should(world.audit.entries[0]).match({
      outcome: 'refused',
      detail: { by: 'agent', reason: 'two different session credentials' },
    });
  });

  it('should refuse a caller with no credential, or one that names no session — and audit both', async () => {
    // Arrange
    const { world, dispatch } = served();

    // Act
    const missing = await dispatch.dispatch(agentCall({ tool: 'terminal.list' }, ''));
    const unknown = await dispatch.dispatch(agentCall({ tool: 'terminal.list' }, 'cap-nobody'));
    const hostTokenAlone = await dispatch.dispatch(agentCall({ tool: 'terminal.list' }, '', human));
    const notACall = await dispatch.dispatch(agentCall({ tool: 'shell.exec' }));

    // Assert — the host's own token buys nothing here: only a session credential does.
    should(missing.status).equal(401);
    should(jsonBody(missing)).match({ code: 'missing_capability', error: /FY_SESSION_BOARD_CAPABILITY/u });
    should(unknown.status).equal(403);
    should(hostTokenAlone.status).equal(401);
    should(notACall.status).equal(400);
    should(world.audit.entries.map(entry => [entry.outcome, entry.detail])).deepEqual([
      ['refused', { by: 'agent', reason: 'no session credential' }],
      ['refused', { by: 'agent', reason: 'unknown session credential' }],
      ['refused', { by: 'agent', reason: 'no session credential' }],
      ['refused', { by: 'agent', reason: 'not a tool call' }],
    ]);
  });

  it('should need no host token at all, and be served only over a privileged loopback carrier', async () => {
    // Arrange
    const { dispatch } = served();
    const body = json({ tool: 'terminal.list' });
    const headers = { 'content-type': 'application/json', [AGENT_SESSION_CAPABILITY_HEADER]: 'cap-s1' };

    // Act
    const tokenless = await dispatch.dispatch(agentCall({ tool: 'terminal.list' }));
    const remote = await dispatch.dispatch(request({ method: 'POST', path: '/v1/agent/tools', headers, body }));
    const relayedDevice = await dispatch.dispatch(
      request({
        method: 'POST',
        path: '/v1/agent/tools',
        headers,
        body,
        loopback: true,
        device: { deviceId: 'device-1', appSession: 'app-one' },
      }),
    );

    // Assert
    should(tokenless.status).equal(200);
    should([remote.status, relayedDevice.status]).deepEqual([403, 403]);
  });

  it('should answer a takeover refusal as a conflict, in the words the agent is shown', async () => {
    // Arrange
    const { dispatch } = served();
    await dispatch.dispatch(agentCall({ tool: 'terminal.open', name: 'dev' }));
    await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/terminals/control', { action: 'takeover', key: 'dev' }),
    );

    // Act
    const refused = await dispatch.dispatch(agentCall({ tool: 'terminal.send', name: 'dev', text: 'ls' }));

    // Assert
    should(refused.status).equal(409);
    should(jsonBody(refused)).match({
      code: 'taken_over',
      error: 'A person has taken over %terminal:dev; wait or ask them.',
    });
  });

  it('should refuse an input past its bound before anything reaches a terminal', async () => {
    const { world, dispatch } = served();
    await world.terminals.create('s1', { name: 'dev' });
    const huge = await dispatch.dispatch(
      agentCall({ tool: 'terminal.send', name: 'dev', text: 'x'.repeat(AGENT_TOOL_MAX_TEXT_CHARS + 1) }),
    );
    should(huge.status).equal(400);
    should(world.terminals.typed.size).equal(0);
  });
});

describe('a genuine defect', () => {
  it('should surface as the 500 it is rather than as a refusal', async () => {
    const { world, dispatch } = served();
    world.terminals.list = async () => {
      throw new Error('disk on fire');
    };
    const failed = await dispatch.dispatch(agentCall({ tool: 'terminal.list' }));
    should(failed.status).equal(500);
  });
});

describe('a person’s tool routes', () => {
  it('should let the CLI and a paired device drive a session they name', async () => {
    // Arrange
    const { world, dispatch } = served();

    // Act
    const opened = await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/terminals/tools', { tool: 'terminal.open', name: 'dev' }),
    );
    const page = await dispatch.dispatch(
      deviceCall('/v1/sessions/s1/surfaces/browser/tools', { tool: 'browser.open', name: 'app' }),
    );

    // Assert
    should([opened.status, page.status]).deepEqual([200, 200]);
    should((await world.terminals.get('s1', '000000000001')).openedBy).deepEqual({ by: 'local' });
    should(world.audit.entries.map(entry => entry.actor)).deepEqual([
      { kind: 'host' },
      { kind: 'device', deviceId: 'device-1' },
    ]);
  });

  it('should refuse an agent that names a session — taking over or handing on included — sending it to its own route', async () => {
    // Arrange
    const { world, dispatch } = served();

    // Act
    const refused = await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/terminals/tools', { tool: 'terminal.list' }, agentIn('s2')),
    );
    const handback = await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/terminals/control', { action: 'handback', key: 'dev' }, agentIn('s1')),
    );

    // Assert
    should(refused.status).equal(403);
    should(jsonBody(refused)).match({ error: /POST \/v1\/agent\/tools/u });
    should(handback.status).equal(403);
    should(world.audit.entries).deepEqual([]);
  });

  it('should take only its own kind of tool', async () => {
    const { dispatch } = served();
    const wrong = await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/browser/tools', { tool: 'terminal.list' }),
    );
    should(wrong.status).equal(400);
    should(jsonBody(wrong)).match({ error: 'this route takes browser tools; terminal.list is not one' });
  });

  it('should keep the login hint an agent’s tool: no person’s surface route takes it', async () => {
    const { dispatch } = served();
    const wrong = await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/browser/tools', { tool: 'account.hint', site: 'vercel.com' }),
    );
    should(wrong.status).equal(400);
  });

  it('should hold the old login.hint name to the same rule: it is read as account.hint', async () => {
    const { dispatch } = served();
    const wrong = await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/browser/tools', { tool: 'login.hint', site: 'vercel.com' }),
    );
    should(wrong.status).equal(400);
    should(jsonBody(wrong)).match({ error: 'this route takes browser tools; account.hint is not one' });
  });

  it('should treat the old login.propose name as account.propose on the agent route', async () => {
    const filed: unknown[] = [];
    const { world, dispatch } = served({
      recipes: {
        scrubbedAccounts: async listing => listing,
        propose: async (...parameters) => {
          filed.push(parameters);
          return {
            id: 'rp_0000000000000001',
            login: 'VERCEL',
            signIn: 'si_00000000000000c1',
            state: 'pending',
            agendaItemId: 'A4',
          };
        },
      },
    });
    const answered = await dispatch.dispatch(
      agentCall({ tool: 'login.propose', login: 'VERCEL', recipe: 'Open vercel.com', why: 'first sign-in' }),
    );
    should(answered.status).equal(200);
    should(filed).deepEqual([['s1', { login: 'VERCEL' }, 'Open vercel.com', 'first sign-in']]);
    should(world.audit.entries.at(-1)?.detail).match({ tool: 'account.propose', signIn: 'si_00000000000000c1' });
  });

  it('should refuse a session id that cannot be one', async () => {
    const { dispatch } = served();
    const bad = await dispatch.dispatch(
      personCall('/v1/sessions/..%2Fx/surfaces/terminals/tools', { tool: 'terminal.list' }),
    );
    should(bad.status).equal(400);
  });
});

/** A guard for a paired device the operator granted the browser but, per `denied`, not the files. */
const guardDenying = (denied: ReadonlySet<string>, governed = true): CapabilityGuard => {
  const decide = (demand: CapabilityDemand): GrantDecision =>
    denied.has(demand.capability) ? { allowed: false, refusal: 'not-granted' } : { allowed: true, refusal: 'granted' };
  return { decide, governance: () => ({ governed, decide }), explain: () => undefined };
};

const servedUnder = (guard: CapabilityGuard) => {
  const world = agentToolWorld();
  const dispatch = new ApiDispatcher(
    new ApiRouter(agentToolRoutes(world.service, world.identities)),
    CREDENTIALS,
    guard,
  );
  return { world, dispatch };
};

const FILE_CALLS = [
  { tool: 'browser.upload', name: 'app', selector: '#f', files: ['a.txt'] },
  { tool: 'browser.download', name: 'app' },
  { tool: 'browser.pdf', name: 'app' },
] as const;

describe('a person’s file tools need the filesystem grant as well as the browser', () => {
  const route = '/v1/sessions/s1/surfaces/browser/tools';

  it('should refuse each file tool for a device with the browser but not the filesystem, before the browser is touched', async () => {
    // Arrange
    const { world, dispatch } = servedUnder(guardDenying(new Set(['filesystem'])));
    await dispatch.dispatch(deviceCall(route, { tool: 'browser.open', name: 'app' }));
    world.audit.entries.length = 0;

    // Act
    const answers = [];
    for (const call of FILE_CALLS) answers.push(await dispatch.dispatch(deviceCall(route, call)));
    const click = await dispatch.dispatch(deviceCall(route, { tool: 'browser.click', name: 'app', selector: 'a' }));

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([403, 403, 403]);
    should(jsonBody(answers[0] as ApiResponse)).match({
      error: /filesystem permission/u,
      code: 'grant_not_granted',
    });
    should(world.browser.fileActions).deepEqual([]);
    should(world.files.prepared).deepEqual([]);
    should(click.status).equal(200);
  });

  it('should serve the file tools to a device that holds both grants', async () => {
    const { world, dispatch } = servedUnder(guardDenying(new Set()));
    await dispatch.dispatch(deviceCall(route, { tool: 'browser.open', name: 'app' }));

    const answer = await dispatch.dispatch(deviceCall(route, { tool: 'browser.pdf', name: 'app' }));

    should(answer.status).equal(200);
    should(world.browser.fileActions).deepEqual([{ action: 'pdf' }]);
  });

  it('should fail closed when the route cannot say where the caller stands', async () => {
    const guard: CapabilityGuard = { ...guardDenying(new Set()), governance: () => undefined as never };
    const { world, dispatch } = servedUnder(guard);

    const answer = await dispatch.dispatch(deviceCall(route, FILE_CALLS[2]));

    should(answer.status).equal(403);
    should(jsonBody(answer)).match({ error: /cannot say whether this caller may use files/u });
    should(world.browser.fileActions).deepEqual([]);
  });

  it('should not hold the owner at the machine to the filesystem grant', async () => {
    const { world, dispatch } = servedUnder(GRANTED);
    await dispatch.dispatch(personCall(route, { tool: 'browser.open', name: 'app' }));

    const answer = await dispatch.dispatch(personCall(route, FILE_CALLS[2]));

    should(answer.status).equal(200);
    should(world.browser.fileActions).deepEqual([{ action: 'pdf' }]);
  });
});

describe('take over and hand back', () => {
  it('should record who took a surface over, list it, and clear it on hand back', async () => {
    // Arrange
    const { dispatch } = served();
    await dispatch.dispatch(agentCall({ tool: 'browser.open', name: 'app' }));

    // Act
    const taken = await dispatch.dispatch(
      deviceCall('/v1/sessions/s1/surfaces/browser/control', { action: 'takeover', key: 'app' }),
    );
    const listed = await dispatch.dispatch(
      request({ method: 'GET', path: '/v1/sessions/s1/surfaces/browser/control', headers: human }),
    );
    const terminals = await dispatch.dispatch(
      request({ method: 'GET', path: '/v1/sessions/s1/surfaces/terminals/control', headers: human }),
    );
    const handedBack = await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/browser/control', { action: 'handback', key: '%browser:app' }),
    );

    // Assert
    should(SurfaceControlViewSchema.parse(jsonBody(taken)).takeovers).match([
      { surface: 'browser', name: 'app', by: { by: 'human', deviceId: 'device-1' } },
    ]);
    should(SurfaceControlViewSchema.parse(jsonBody(listed)).takeovers).have.length(1);
    // Each kind's read shows only that kind, so each is governed by that kind's grant.
    should(SurfaceControlViewSchema.parse(jsonBody(terminals)).takeovers).deepEqual([]);
    should(SurfaceControlViewSchema.parse(jsonBody(handedBack))).match({ sessionId: 's1', takeovers: [] });
  });

  it('should hand a person’s terminal to the agent, which may then use it', async () => {
    // Arrange
    const { dispatch } = served();
    await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/terminals/tools', { tool: 'terminal.open', name: 'mine' }),
    );
    const before = await dispatch.dispatch(agentCall({ tool: 'terminal.read', name: 'mine' }));

    // Act
    const handed = await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/terminals/control', { action: 'handover', key: 'mine' }),
    );
    const after = await dispatch.dispatch(agentCall({ tool: 'terminal.read', name: 'mine' }));

    // Assert
    should(before.status).equal(403);
    should(SurfaceControlViewSchema.parse(jsonBody(handed)).handed).match([{ name: 'mine', by: { by: 'local' } }]);
    should(after.status).equal(200);
  });

  it('should answer a takeover of a surface that is not there as not found', async () => {
    const { dispatch } = served();
    const missing = await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/terminals/control', { action: 'takeover', key: 'ghost' }),
    );
    should(missing.status).equal(404);
  });
});

describe('the agent tools routes — publication at the transport', () => {
  const SCREEN = 'pane-screen-CANARY';

  /** A world whose terminal is quarantined one microtask after the service's last check, with its audit suspended. */
  const racing = async () => {
    let held = false;
    let afterAudit = false;
    let queued = false;
    const world = agentToolWorld({
      quarantinedUntil: () => {
        if (afterAudit && !queued) {
          queued = true;
          queueMicrotask(() => (held = true));
        }
        return held ? Date.now() + 60_000 : undefined;
      },
    });
    await world.service.call({ kind: 'agent', sessionId: 's1' }, { tool: 'terminal.open', name: 'dev' });
    world.terminals.screens.set('000000000001', SCREEN);
    world.audit.during = async () => {
      afterAudit = true;
    };
    return new ApiDispatcher(new ApiRouter(agentToolRoutes(world.service, world.identities)), CREDENTIALS, GRANTED);
  };

  it('should not spell a screen read for an agent when a hold begins after the service last checked', async () => {
    const dispatch = await racing();

    const answered = await dispatch.dispatch(agentCall({ tool: 'terminal.read', name: 'dev' }));

    should(answered.status).equal(409);
    should(String(answered.body)).not.containEql(SCREEN);
  });

  it.each([['an agent'], ['a person']])(
    'should not spell a screen read for %s when a hold begins after the route last checked',
    async (who: string) => {
      let held = false;
      const world = agentToolWorld({ quarantinedUntil: () => (held ? Date.now() + 60_000 : undefined) });
      await world.service.call({ kind: 'agent', sessionId: 's1' }, { tool: 'terminal.open', name: 'dev' });
      world.terminals.screens.set('000000000001', SCREEN);
      const publish = world.service.publish.bind(world.service);
      let publications = 0;
      world.service.publish = result => {
        publications += 1;
        if (publications === 2) queueMicrotask(() => (held = true));
        return publish(result);
      };
      const dispatch = new ApiDispatcher(
        new ApiRouter(agentToolRoutes(world.service, world.identities)),
        CREDENTIALS,
        GRANTED,
      );
      const call = { tool: 'terminal.read', name: 'dev' } as const;

      const answered = await dispatch.dispatch(
        who === 'an agent' ? agentCall(call) : personCall('/v1/sessions/s1/surfaces/terminals/tools', call),
      );

      should(publications).equal(3);
      should(answered.status).equal(409);
      should(String(answered.body)).not.containEql(SCREEN);
    },
  );

  it('should not spell a screen read for a person when a hold begins after the service last checked', async () => {
    const dispatch = await racing();

    const answered = await dispatch.dispatch(
      personCall('/v1/sessions/s1/surfaces/terminals/tools', { tool: 'terminal.read', name: 'dev' }),
    );

    should(answered.status).equal(409);
    should(String(answered.body)).not.containEql(SCREEN);
  });
});

describe('a person’s tool routes and secure copy', () => {
  it('should refuse every secure tool on both person routes, so no grant reaches a command through them', async () => {
    // Arrange
    const { world, dispatch } = served();
    const copy = { tool: 'secure.copy', name: 'token', source: { kind: 'command', argv: ['id'] } };

    // Act
    const answers = await Promise.all([
      dispatch.dispatch(deviceCall('/v1/sessions/s1/surfaces/browser/tools', copy)),
      dispatch.dispatch(personCall('/v1/sessions/s1/surfaces/terminals/tools', copy)),
      dispatch.dispatch(personCall('/v1/sessions/s1/surfaces/browser/tools', { tool: 'secure.list' })),
      dispatch.dispatch(
        personCall('/v1/sessions/s1/surfaces/terminals/tools', { tool: 'secure.discard', handle: 'token' }),
      ),
    ]);

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([400, 400, 400, 400]);
    should(jsonBody(answers[0] as ApiResponse).error).equal(
      "secure.copy is an agent's tool, not one a person's surface route takes",
    );
    should(world.audit.entries).deepEqual([]);
  });
});

describe('the session credential directory the boundary is wired with', () => {
  it("should answer with the agent tools' own resolver, naming only the session", async () => {
    // Arrange
    const { world } = served();
    const directory = sessionCredentialDirectory(world.identities, world.audit);

    // Act
    const known = await directory.resolve(PREFIXED_S1);
    const unknown = await directory.resolve(`fys_${'n'.repeat(43)}`);

    // Assert — the session id and nothing else of the identity, such as its spoken name.
    should(known).deepEqual({ sessionId: 's1' });
    should(unknown).be.undefined();
  });

  it('should audit a refusal under the session the credential named, within the one-line bound', async () => {
    // Arrange
    const { world } = served();
    const directory = sessionCredentialDirectory(world.identities, world.audit);
    const long = `GET /v1/${'x'.repeat(400)}`;

    // Act
    await directory.refused?.({ reason: 'session_mismatch', sessionId: 's1', route: 'GET /v1/sessions' });
    await directory.refused?.({ reason: 'session_mismatch', sessionId: 's2', route: long });

    // Assert
    should(world.audit.entries).deepEqual([
      {
        event: 'session.credential-refused',
        actor: { kind: 'host' },
        subject: 's1',
        outcome: 'refused',
        detail: { by: 'agent', reason: 'session_mismatch', route: 'GET /v1/sessions' },
      },
      {
        event: 'session.credential-refused',
        actor: { kind: 'host' },
        subject: 's2',
        outcome: 'refused',
        detail: { by: 'agent', reason: 'session_mismatch', route: long.slice(0, 160) },
      },
    ]);
  });
});
