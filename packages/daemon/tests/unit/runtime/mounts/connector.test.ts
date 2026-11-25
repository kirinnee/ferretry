import { describe, it } from 'bun:test';
import { CONNECTOR_REFUSAL_CODES, STEP_UP_ACTS, type StepUpAct } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter, type StepUpWitness } from '../../../../src/lib/api/index.ts';
import type {
  ConnectorActResult,
  ConnectorGrantView,
  ConnectorOwnerActs,
  ConnectorPendingView,
} from '../../../../src/lib/connector/ports.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import {
  type ConnectorAvailability,
  type ConnectorSubsystem,
  connectorRoutes,
} from '../../../../src/lib/runtime/mounts/connector.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, fromFerret, grantSubsystem, human } from './support.ts';

const PENDING: ConnectorPendingView = {
  id: 'cr_abcdefghij',
  matchCode: 'K7Q-2MF',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['fleet:read', 'fleet:write'],
  createdAt: '2026-11-24T10:00:00.000Z',
  expiresAt: '2026-11-24T10:10:00.000Z',
};
const GRANT: ConnectorGrantView = {
  id: 'cg_abcdefghij',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['fleet:read', 'fleet:write'],
  createdAt: '2026-11-24T10:01:00.000Z',
  approvedBy: 'admin-cli',
};
const ENABLED: ConnectorAvailability = {
  enabled: true,
  publicUrl: 'https://mcp.example.test',
  mcpUrl: 'https://mcp.example.test/mcp',
  source: 'configured',
};
const DISABLED: ConnectorAvailability = {
  enabled: false,
  disabledReason: 'The connector is off. Switch it on in the app (Settings › Claude connector).',
  switchedOn: false,
};

/** Records every act and who it was done as; answers what the case set. */
class FakeActs implements ConnectorOwnerActs {
  readonly calls: string[] = [];
  readonly actors: string[] = [];
  /** What approve answers; a refusal, or a view carrying a field no view may have. */
  approveAnswer: ConnectorActResult<ConnectorGrantView> = { ok: true, value: GRANT };
  denyAnswer: ConnectorActResult<ConnectorPendingView> = { ok: true, value: PENDING };
  revokeAnswer: ConnectorActResult<ConnectorGrantView> = { ok: true, value: { ...GRANT, revokedAt: GRANT.createdAt } };

  async pending() {
    this.calls.push('pending');
    return [PENDING];
  }
  async grants() {
    this.calls.push('grants');
    return [GRANT];
  }
  async approve(idOrMatchCode: string, approvedBy: string) {
    this.calls.push(`approve ${idOrMatchCode}`);
    this.actors.push(approvedBy);
    return this.approveAnswer;
  }
  async deny(idOrMatchCode: string, deniedBy: string) {
    this.calls.push(`deny ${idOrMatchCode}`);
    this.actors.push(deniedBy);
    return this.denyAnswer;
  }
  async revoke(grantId: string, revokedBy: string) {
    this.calls.push(`revoke ${grantId}`);
    this.actors.push(revokedBy);
    return this.revokeAnswer;
  }
}

/** A paired browser, remote: whoever its session proved. It sends no credential of its own. */
const BROWSER_ID = 'fy_device_id_dddddddddddddddddddddd';
const browser = { deviceId: BROWSER_ID, appSession: 'app-one' } as const;
const remote = { device: browser, loopback: false } as const;
/** A paired browser ON the host: still an ordinary governed device — only the admin token over loopback is the owner. */
const localBrowser = { device: browser, loopback: true, privilegedLoopback: true } as const;

/**
 * A device holding an unlock, and the proofs it has made: `proved` names the acts it has freshly confirmed. A claim
 * spends the proof, like the real service, so a second claim of the same act is refused.
 */
function stepUps(proved: readonly StepUpAct[] = []): StepUpWitness & { readonly claimed: StepUpAct[] } {
  const remaining = [...proved];
  const claimed: StepUpAct[] = [];
  return {
    held: () => true,
    claimed,
    claimFresh: ((_subject: unknown, act?: StepUpAct) => {
      if (act === undefined) return false;
      const at = remaining.indexOf(act);
      if (at === -1) return false;
      remaining.splice(at, 1);
      claimed.push(act);
      return true;
    }) as StepUpWitness['claimFresh'],
  };
}

async function mount(
  acts: ConnectorOwnerActs,
  availability: ConnectorAvailability = ENABLED,
  witness?: StepUpWitness,
  /** The operator's daemon-wide `pairing` grant. */
  pairing = { use: true, configure: true },
  change: ConnectorSubsystem['change'] = async () => ({ ok: true }),
) {
  const grants = grantSubsystem({ grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing } });
  await grants.refresh();
  return new ApiDispatcher(
    new ApiRouter(connectorRoutes({ acts, availability: () => availability, change })),
    CREDENTIALS,
    grants,
    undefined,
    witness,
  );
}

const post = (path: string, overrides: Parameters<typeof request>[0] = {}) =>
  request({ method: 'POST', path, ...overrides });

const APPROVE = '/v1/connector/requests/K7Q-2MF/approve';
const DENY = '/v1/connector/requests/cr_abcdefghij/deny';
const REVOKE = '/v1/connector/grants/cg_abcdefghij/revoke';

describe('connector routes: who may call them', () => {
  it('should refuse a ferret on every route before any act runs, and an anonymous caller with 401', async () => {
    // Arrange
    const acts = new FakeActs();
    const surface = await mount(acts);
    const asked = [
      request({ path: '/v1/connector', headers: human, loopback: true }),
      post(APPROVE, { headers: human, loopback: true }),
      post(DENY, { headers: human, loopback: true }),
      post(REVOKE, { headers: human, loopback: true }),
    ];

    // Act — a ferret on its OWN credential, and an older fy naming its session on the admin token.
    const ferret = await Promise.all(asked.map(asking => surface.dispatch(fromFerret(asking))));
    const peers = await Promise.all(
      asked.map(asking =>
        surface.dispatch({ ...asking, headers: new Map([...asking.headers, ...Object.entries(agentIn('s1'))]) }),
      ),
    );
    const anonymous = await surface.dispatch(request({ path: '/v1/connector', loopback: true }));

    // Assert
    should(ferret.map(answer => [answer.status, jsonBody(answer).code])).deepEqual(
      asked.map(() => [403, 'owner_only']),
    );
    should(peers.map(answer => answer.status)).deepEqual(asked.map(() => 403));
    should(anonymous.status).equal(401);
    should(acts.calls).deepEqual([]);
  });

  it('should let the host’s owner approve with no passkey, as admin-cli, by match code', async () => {
    // Arrange
    const acts = new FakeActs();
    const witness = stepUps();
    const surface = await mount(acts, ENABLED, witness);

    // Act
    const answered = await surface.dispatch(
      post(APPROVE, { headers: human, loopback: true, privilegedLoopback: true }),
    );

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).equal('no-store');
    should(jsonBody(answered)).deepEqual({ ...GRANT });
    should(acts.calls).deepEqual(['approve K7Q-2MF']);
    should(acts.actors).deepEqual(['admin-cli']);
    should(witness.claimed).deepEqual([]);
  });

  it('should hold a governed device’s approval behind a passkey proved for THIS act, and not take another act’s proof', async () => {
    // Arrange
    const acts = new FakeActs();
    const unlockedOnly = await mount(acts, ENABLED, stepUps());
    const wrongAct = await mount(acts, ENABLED, stepUps([STEP_UP_ACTS.catalogInstall, STEP_UP_ACTS.addDevice]));
    const witness = stepUps([STEP_UP_ACTS.approveConnector]);
    const proved = await mount(acts, ENABLED, witness);

    // Act
    const unproved = await unlockedOnly.dispatch(post(APPROVE, remote));
    const borrowed = await wrongAct.dispatch(post(APPROVE, remote));
    const onHost = await unlockedOnly.dispatch(post(APPROVE, localBrowser));
    const approved = await proved.dispatch(post(APPROVE, remote));
    const replayed = await proved.dispatch(post(APPROVE, remote));

    // Assert — the refusals name the act so the app's prompt says what is being confirmed, and no act ran for them.
    for (const refusal of [unproved, borrowed, onHost, replayed]) {
      should(refusal.status).equal(403);
      should(jsonBody(refusal).code).equal('grant_step_up_required');
      should(jsonBody(refusal).demand).deepEqual({
        capability: 'pairing',
        axis: 'configure',
        act: 'approve-connector',
      });
    }
    should(approved.status).equal(200);
    should(witness.claimed).deepEqual(['approve-connector']);
    should(acts.calls).deepEqual(['approve K7Q-2MF']);
    should(acts.actors).deepEqual([`device:${BROWSER_ID}`]);
  });

  it('should not let the operator’s narrowing of pairing.configure be approved around', async () => {
    // Arrange
    const acts = new FakeActs();
    const surface = await mount(acts, ENABLED, stepUps([STEP_UP_ACTS.approveConnector]), {
      use: true,
      configure: false,
    });

    // Act
    const approve = await surface.dispatch(post(APPROVE, remote));
    const deny = await surface.dispatch(post(DENY, remote));

    // Assert — approving is refused by the grant; denying only takes away, and still works.
    should(approve.status).equal(403);
    should(jsonBody(approve).code).equal('grant_not_granted');
    should(deny.status).equal(200);
    should(acts.calls).deepEqual([`deny cr_abcdefghij`]);
  });

  it('should ask a device for no passkey to deny or revoke, as device revocation asks none', async () => {
    // Arrange
    const acts = new FakeActs();
    const surface = await mount(acts);

    // Act
    const denied = await surface.dispatch(post(DENY, remote));
    const revoked = await surface.dispatch(post(REVOKE, remote));

    // Assert
    should([denied.status, revoked.status]).deepEqual([200, 200]);
    should(jsonBody(denied)).deepEqual({ ...PENDING });
    should(jsonBody(revoked).revokedAt).equal(GRANT.createdAt);
    should(acts.actors).deepEqual([`device:${BROWSER_ID}`, `device:${BROWSER_ID}`]);
  });

  it('should hold the status read behind the same unlock a remote caller needs for pairing.use', async () => {
    // Arrange
    const surface = await mount(new FakeActs());

    // Act
    const locked = await surface.dispatch(request({ path: '/v1/connector', ...remote }));
    const unlocked = await (await mount(new FakeActs(), ENABLED, stepUps())).dispatch(
      request({ path: '/v1/connector', ...remote }),
    );

    // Assert
    should(locked.status).equal(403);
    should(unlocked.status).equal(200);
  });
});

describe('connector routes: what they answer', () => {
  it('should answer the status with the MCP URL, what waits and who is approved', async () => {
    // Arrange
    const surface = await mount(new FakeActs());

    // Act
    const answered = await surface.dispatch(request({ path: '/v1/connector', headers: human, loopback: true }));

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).equal('no-store');
    should(jsonBody(answered)).deepEqual({
      enabled: true,
      switchedOn: true,
      publicUrlSource: 'configured',
      publicUrl: ENABLED.enabled ? ENABLED.publicUrl : '',
      mcpUrl: ENABLED.enabled ? ENABLED.mcpUrl : '',
      pending: [{ ...PENDING }],
      grants: [{ ...GRANT }],
    });
  });

  it('should say why it is off, list nothing and never call the acts, while a switch is off', async () => {
    // Arrange
    const acts = new FakeActs();
    const surface = await mount(acts, DISABLED);

    // Act
    const status = await surface.dispatch(request({ path: '/v1/connector', headers: human, loopback: true }));
    const attempts = await Promise.all(
      [APPROVE, DENY, REVOKE].map(path => surface.dispatch(post(path, { headers: human, loopback: true }))),
    );

    // Assert
    should(jsonBody(status)).deepEqual({
      enabled: false,
      switchedOn: false,
      disabledReason: DISABLED.enabled ? '' : DISABLED.disabledReason,
      pending: [],
      grants: [],
    });
    for (const attempt of attempts) {
      should(attempt.status).equal(409);
      should(jsonBody(attempt).code).equal(CONNECTOR_REFUSAL_CODES.disabled);
      should(jsonBody(attempt).error).equal(DISABLED.enabled ? '' : DISABLED.disabledReason);
    }
    should(acts.calls).deepEqual([]);
  });

  it('should answer each refusal with the status and code a client branches on, in the daemon’s own words', async () => {
    // Arrange
    const acts = new FakeActs();
    const surface = await mount(acts);
    const asHost = { headers: human, loopback: true } as const;
    const cases: readonly [ConnectorActResult<never>, number, string][] = [
      [{ ok: false, code: 'not_found', message: 'No sign-in is waiting with that code.' }, 404, 'connector_not_found'],
      [
        { ok: false, code: 'expired', message: 'That sign-in ran out; start it again from Claude.' },
        410,
        'connector_expired',
      ],
      [
        { ok: false, code: 'already_decided', message: 'That sign-in was already decided.' },
        409,
        'connector_already_decided',
      ],
    ];

    for (const [refusal, status, code] of cases) {
      // Act
      acts.approveAnswer = refusal;
      acts.denyAnswer = refusal;
      acts.revokeAnswer = refusal;
      const answers = await Promise.all([APPROVE, DENY, REVOKE].map(path => surface.dispatch(post(path, asHost))));

      // Assert
      for (const answer of answers) {
        should([answer.status, jsonBody(answer).code, jsonBody(answer).error]).deepEqual([
          status,
          code,
          refusal.ok ? '' : refusal.message,
        ]);
      }
    }
  });

  it('should refuse a malformed id as not found, and a body that names an actor, before any act runs', async () => {
    // Arrange
    const acts = new FakeActs();
    const surface = await mount(acts);
    const asHost = { headers: human, loopback: true } as const;

    // Act
    const badRequest = await surface.dispatch(post('/v1/connector/requests/not%20a%20code%21/approve', asHost));
    const badGrant = await surface.dispatch(post('/v1/connector/grants/cr_abcdefghij/revoke', asHost));
    const forged = await surface.dispatch(
      post(APPROVE, { ...asHost, body: JSON.stringify({ approvedBy: 'admin-cli' }) }),
    );

    // Assert
    should([badRequest.status, badGrant.status]).deepEqual([404, 404]);
    should(forged.status).equal(400);
    should(acts.calls).deepEqual([]);
  });

  it('should refuse to answer with a view that carries anything a view may not, rather than pass it on', async () => {
    // Arrange — an act that (wrongly) hands back a token beside the grant.
    const SECRET = 'fyc_at_do-not-leak';
    const acts = new FakeActs();
    acts.approveAnswer = { ok: true, value: { ...GRANT, accessToken: SECRET } as ConnectorGrantView };
    const surface = await mount(acts);

    // Act
    const answered = await surface.dispatch(post(APPROVE, { headers: human, loopback: true }));

    // Assert
    should(answered.status).equal(500);
    should(answered.body).not.match(/do-not-leak/u);
  });
});

describe('connector routes: switching it (PUT /v1/connector)', () => {
  const put = (overrides: Parameters<typeof request>[0] = {}, enabled: unknown = true) =>
    request({ method: 'PUT', path: '/v1/connector', body: JSON.stringify({ enabled }), ...overrides });

  it('should let the host’s owner switch it with no passkey and answer the status read after', async () => {
    // Arrange
    const seen: boolean[] = [];
    const surface = await mount(new FakeActs(), ENABLED, stepUps(), undefined, async enabled => {
      seen.push(enabled);
      return { ok: true };
    });

    // Act
    const answered = await surface.dispatch(put({ headers: human, loopback: true, privilegedLoopback: true }));

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).equal('no-store');
    should(jsonBody(answered).switchedOn).equal(true);
    should(seen).deepEqual([true]);
  });

  it('should refuse a ferret and an anonymous caller before the switch runs', async () => {
    // Arrange
    const seen: boolean[] = [];
    const surface = await mount(new FakeActs(), ENABLED, undefined, undefined, async enabled => {
      seen.push(enabled);
      return { ok: true };
    });

    // Act
    const ferret = await surface.dispatch(fromFerret(put({ headers: human, loopback: true })));
    const anonymous = await surface.dispatch(request({ method: 'PUT', path: '/v1/connector', loopback: true }));

    // Assert
    should([ferret.status, jsonBody(ferret).code]).deepEqual([403, 'owner_only']);
    should(anonymous.status).equal(401);
    should(seen).deepEqual([]);
  });

  it('should hold a governed device’s switch behind pairing.configure and the step-up every configure demand takes', async () => {
    // Arrange
    const seen: boolean[] = [];
    const change = async (enabled: boolean) => {
      seen.push(enabled);
      return { ok: true } as const;
    };
    const locked = await mount(new FakeActs(), ENABLED, undefined, undefined, change);
    const narrowed = await mount(new FakeActs(), ENABLED, stepUps(), { use: true, configure: false }, change);
    const unlocked = await mount(new FakeActs(), ENABLED, stepUps(), undefined, change);

    // Act
    const noUnlock = await locked.dispatch(put(remote));
    const notGranted = await narrowed.dispatch(put(remote));
    const allowed = await unlocked.dispatch(put(remote));

    // Assert
    should(noUnlock.status).equal(403);
    should([notGranted.status, jsonBody(notGranted).code]).deepEqual([403, 'grant_not_granted']);
    should(allowed.status).equal(200);
    should(seen).deepEqual([true]);
  });

  it('should answer a switch that cannot be done with 409, its code and the sentence, and a malformed body with 400', async () => {
    // Arrange
    const surface = await mount(new FakeActs(), ENABLED, undefined, undefined, async () => ({
      ok: false,
      message: 'The connector could not be switched on: port 7461 is taken.',
    }));

    // Act
    const refused = await surface.dispatch(put({ headers: human, loopback: true }));
    const malformed = await surface.dispatch(put({ headers: human, loopback: true }, 'yes'));

    // Assert
    should(refused.status).equal(409);
    should(jsonBody(refused).code).equal(CONNECTOR_REFUSAL_CODES.cannotSwitch);
    should(jsonBody(refused).error).equal('The connector could not be switched on: port 7461 is taken.');
    should(malformed.status).equal(400);
  });
});
