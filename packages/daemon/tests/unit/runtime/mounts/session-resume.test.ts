import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import { type GrantRefusal, STEP_UP_REQUIRED_CODE, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  resumeActorOf,
  SessionResumeError,
  type SessionResumeSubsystem,
  sessionResumeRoutes,
} from '../../../../src/lib/runtime/mounts/session-resume.ts';
import { request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FakeSessionResume, human } from './support.ts';

/**
 * The revive surface: who a request is attributed to, what each refusal answers, and what comes back.
 *
 * Every case goes through the real dispatcher and the real credentials, because the actor this mount
 * hands the resume domain is DERIVED by that dispatcher from the token class and the calling pane's
 * own session id — a test that called the route function directly would be choosing the actor itself
 * and would prove nothing about the privilege boundary.
 */

function dispatcher(subsystem = new FakeSessionResume()): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionResumeRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

function resumeRequest(
  sessionId: string,
  headers: Readonly<Record<string, string>> = human,
  body = '{}',
): Parameters<ApiDispatcher['dispatch']>[0] {
  return request({ method: 'POST', path: `/v1/sessions/${sessionId}/resume`, headers, body });
}

describe('the session resume mount', () => {
  it('should revive a session and answer with the view the read surface serves', async () => {
    // Arrange
    const reviver = new FakeSessionResume();
    const subject = dispatcher(reviver);

    // Act
    const response = await subject.dispatch(resumeRequest('s1', human, JSON.stringify({ message: 'carry on' })));

    // Assert
    should(response.status).equal(200);
    // Parsed with the protocol's own schema: a body the client would refuse is a revive that failed.
    const view = SessionViewSchema.parse(JSON.parse(response.body));
    should(view.config.id).equal('s1');
    // The turn moved, which is what tells a revive apart from a read of the same session.
    should(view.state.turn).equal(2);
    // The message reached the subsystem rather than being dropped at the boundary.
    should(reviver.resumes).deepEqual([['s1', 'admin-cli', 'carry on']]);
  });

  it('should revive with no message at all, because an interactive session just wants its terminal', async () => {
    // `ResumeSessionRequest.message` is optional and the client sends `{}`; an empty body is the same
    // request. Rejecting either would make `fy resume <id>` — the commonest form — unusable.
    // Arrange
    const reviver = new FakeSessionResume();
    const subject = dispatcher(reviver);

    // Act
    const empty = await subject.dispatch(resumeRequest('s1', human, ''));
    const braces = await subject.dispatch(resumeRequest('s1'));

    // Assert
    should(empty.status).equal(200);
    should(braces.status).equal(200);
    should(reviver.resumes).deepEqual([
      ['s1', 'admin-cli', undefined],
      ['s1', 'admin-cli', undefined],
    ]);
  });

  it('should attribute the revive to the caller the credentials identify, never to the body', async () => {
    // The actor decides the POLICY: only an automatic reviver may be suppressed by the duplicate-work
    // heuristic, and only an explicit one may clear a quarantine a human has not seen. So a teammate
    // calling from inside its own pane must arrive as `peer`, and it must not be able to claim
    // otherwise — the body below names an actor, and it is ignored.
    // Arrange
    const reviver = new FakeSessionResume();
    const subject = dispatcher(reviver);

    // Act
    const peer = await subject.dispatch(resumeRequest('s1', agentIn('s9'), JSON.stringify({ message: 'go on' })));
    const claimed = await subject.dispatch(
      resumeRequest('s1', agentIn('s9'), JSON.stringify({ message: 'go on', actor: 'admin-cli' })),
    );

    // Assert
    should(peer.status).equal(200);
    // The strict request schema refuses the unknown field outright, so the claim cannot even be sent.
    should(claimed.status).equal(400);
    should(reviver.resumes).deepEqual([['s1', 'peer', 'go on']]);
  });

  it('should refuse anonymously and refuse a warden token, because a revive relaunches a process', async () => {
    // Arrange
    const reviver = new FakeSessionResume();
    const subject = dispatcher(reviver);

    // Act
    const anonymous = await subject.dispatch(resumeRequest('s1', {}));
    const warden = await subject.dispatch(resumeRequest('s1', { authorization: `Bearer ${CREDENTIALS.warden}` }));

    // Assert
    should(anonymous.status).equal(401);
    // `admin` scope, matching the start and the stop: a warden TOKEN does not get to relaunch an agent.
    should(warden.status).equal(403);
    // Neither request reached the subsystem at all, which is what "fails closed" has to mean.
    should(reviver.resumes).be.empty();
  });

  it('should answer each refusal the resume domain raises with its own status and code', async () => {
    // The three conflicts are deliberately not collapsed: they are different next actions for a
    // caller — send a message, re-read the session, resume it explicitly — and a single 409 would
    // make a client guess which.
    // Arrange
    const subject = dispatcher(
      new FakeSessionResume(['s1'], {
        running: new SessionResumeError('refused', 'session running is already running'),
        moved: new SessionResumeError('guard_failed', 'resume guard expected status retrying but found running'),
        duplicate: new SessionResumeError('suppressed', 'automatic revive suppressed for session duplicate'),
        broken: new SessionResumeError('failed', 'the replacement pane never became ready'),
        weird: new SessionResumeError('invalid', '"weird" is not a usable session id'),
      }),
    );

    // Act
    const answers = await Promise.all(
      ['running', 'moved', 'duplicate', 'broken', 'weird', 'absent'].map(
        async id => await subject.dispatch(resumeRequest(id)),
      ),
    );

    // Assert
    should(answers.map(response => [response.status, (JSON.parse(response.body) as { code: string }).code])).deepEqual([
      [409, 'resume_refused'],
      [409, 'resume_guard_failed'],
      [409, 'revive_suppressed'],
      [500, 'session_resume_failed'],
      [400, 'invalid_session_id'],
      [404, 'not-found'],
    ]);
  });

  it('should refuse a path parameter that would regain a separator', async () => {
    // A session id is a directory name downstream. An encoded separator that decoded back into one
    // must never reach the service, so it is refused at the boundary rather than parsed later.
    // Arrange
    const reviver = new FakeSessionResume();
    const subject = dispatcher(reviver);

    // Act
    const traversal = await subject.dispatch(resumeRequest('%2e%2e%2fetc'));

    // Assert
    should(traversal.status).equal(400);
    should((JSON.parse(traversal.body) as { code: string }).code).equal('invalid_session_id');
    should(reviver.resumes).be.empty();
  });

  it('should let a message the client did not send stay absent rather than becoming empty', async () => {
    // `message` is `min(1)` on the wire: an empty string is a caller mistake, not "no message". The
    // difference matters because no message is what makes an interactive revive BARE — it gets its
    // terminal back and invents no turn — while an empty one would write a turn document with
    // nothing in it.
    // Arrange
    const subject = dispatcher();

    // Act
    const blank = await subject.dispatch(resumeRequest('s1', human, JSON.stringify({ message: '' })));

    // Assert
    should(blank.status).equal(400);
    should((JSON.parse(blank.body) as { code: string }).code).equal('invalid_request');
  });

  it('should map every actor the authorization boundary derives onto a policy the domain names', async () => {
    // An actor the resume domain does not recognise must resolve to `unknown`, which
    // `resolveResumePolicy` treats as the SAFER automatic path. That is the whole reason this goes
    // through the schema instead of a cast: a new actor kind gets the less powerful policy until
    // somebody teaches the domain about it, rather than silently inheriting an operator's.
    // Arrange / Act / Assert
    should(resumeActorOf('admin-cli')).equal('admin-cli');
    should(resumeActorOf('admin-ui')).equal('admin-ui');
    // The owner in the app on a paired device is a person, not an unknown reviver (C4).
    should(resumeActorOf('device:d_1')).equal('device');
    should(resumeActorOf('peer:s9')).equal('peer');
    should(resumeActorOf('warden:s4')).equal('warden');
    should(resumeActorOf('cron:nightly')).equal('unknown');
    should(resumeActorOf(undefined)).equal('unknown');
  });

  it('should let an error that is not a stated refusal surface as itself', async () => {
    // A defect must not be dressed up as a refusal the caller could act on: the taxonomy covers what
    // the resume domain decides, and anything else is this daemon being broken.
    // Arrange
    const subject = dispatcher(
      new FakeSessionResume(['s1'], {
        // Not a SessionResumeError: the cast is the point of the case.
        s1: new Error('the storage index was closed') as SessionResumeError,
      }),
    );

    // Act
    const response = await subject.dispatch(resumeRequest('s1'));

    // Assert
    should(response.status).equal(500);
    should((JSON.parse(response.body) as { code: string }).code).not.equal('resume_refused');
  });
});

describe('a paired device bringing back a ferret the owner cut off (secrev-1329b M2)', () => {
  /** A resume subsystem that holds `cut` sessions as cut off, and asks the route before a device restores one. */
  const cutOffReviver = (cut: ReadonlySet<string>) => {
    const restored: string[] = [];
    const subsystem: SessionResumeSubsystem = {
      resume: async (sessionId, actor, _message, _policy, confirm) => {
        if (cut.has(sessionId) && actor === 'device') {
          if (confirm === undefined) throw new SessionResumeError('refused', 'no device restore here');
          confirm();
        }
        if (cut.has(sessionId)) restored.push(sessionId);
        return await new FakeSessionResume(['s1', 's2']).resume(sessionId, actor, undefined);
      },
    };
    return { subsystem, restored };
  };

  const drive = async (
    subsystem: SessionResumeSubsystem,
    sessionId: string,
    over: {
      readonly fleet?: GrantRefusal | 'granted';
      proofs?: { left: number };
      readonly governed?: boolean;
      readonly ferret?: boolean;
      readonly undetermined?: boolean;
    } = {},
  ) => {
    const found = new ApiRouter(sessionResumeRoutes(subsystem)).lookup('POST', `/v1/sessions/${sessionId}/resume`);
    if (found.kind !== 'matched') throw new Error('no resume route');
    const proofs = over.proofs ?? { left: 0 };
    const claimed: string[] = [];
    const fleet = over.fleet ?? 'granted';
    const context = {
      request: request({ method: 'POST', path: `/v1/sessions/${sessionId}/resume`, headers: human, body: '{}' }),
      params: found.params,
      actor: 'device:fy_device_id_AAAAAAAAAAAAAAAAAAAAAA',
      credential: over.ferret === true ? { tokenClass: 'session', sessionId: 's9' } : { tokenClass: 'device' },
      governance:
        over.undetermined === true
          ? undefined
          : {
              governed: over.governed ?? true,
              decide: (demand: { capability: string; axis: string }) =>
                demand.capability === 'fleet' && demand.axis === 'configure'
                  ? { allowed: fleet === 'granted', refusal: fleet }
                  : { allowed: false, refusal: 'not-granted' },
            },
      claimFreshStepUp: (act: string) => {
        claimed.push(act);
        if (act !== 'resume-cut-off' || proofs.left <= 0) return false;
        proofs.left -= 1;
        return true;
      },
    } as unknown as RouteContext;
    try {
      const response = await found.route.handle(context);
      return { status: response.status, code: undefined as string | undefined, extra: undefined, claimed };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { status: error.status, code: error.code, extra: error.extra, claimed };
    }
  };

  it('should refuse a restore with no passkey proved for it, and name the act to prove', async () => {
    const { subsystem, restored } = cutOffReviver(new Set(['s1']));

    const answer = await drive(subsystem, 's1');

    should([answer.status, answer.code]).eql([403, STEP_UP_REQUIRED_CODE]);
    should(answer.extra).eql({ demand: { capability: 'fleet', axis: 'configure', act: 'resume-cut-off' } });
    should(restored).eql([]);
  });

  it('should restore with a passkey proved for it, and spend it: one confirmation brings back one session', async () => {
    const { subsystem, restored } = cutOffReviver(new Set(['s1', 's2']));
    const proofs = { left: 1 };

    const first = await drive(subsystem, 's1', { proofs });
    const second = await drive(subsystem, 's2', { proofs });

    should([first.status, second.status]).eql([200, 403]);
    should(first.claimed).eql(['resume-cut-off']);
    should(restored).eql(['s1']);
  });

  it('should refuse a device the grants do not let change the fleet, before any passkey is taken', async () => {
    const { subsystem, restored } = cutOffReviver(new Set(['s1']));
    const proofs = { left: 1 };

    const answer = await drive(subsystem, 's1', { fleet: 'device-not-granted', proofs });

    should([answer.status, answer.code]).eql([403, 'grant_device_not_granted']);
    should(answer.claimed).eql([]);
    should(proofs.left).equal(1);
    should(restored).eql([]);
  });

  it('should refuse a restore it cannot judge, before any passkey is taken', async () => {
    const { subsystem, restored } = cutOffReviver(new Set(['s1']));
    const proofs = { left: 1 };

    const answer = await drive(subsystem, 's1', { undetermined: true, proofs });

    should([answer.status, answer.code]).eql([403, 'grant_undetermined']);
    should(proofs.left).equal(1);
    should(restored).eql([]);
  });

  it('should refuse a ferret’s own credential, which reads ungoverned, whatever it claims to be', async () => {
    const { subsystem, restored } = cutOffReviver(new Set(['s1']));

    const answer = await drive(subsystem, 's1', { ferret: true, governed: false, proofs: { left: 1 } });

    should([answer.status, answer.code]).eql([403, 'owner_only']);
    should(answer.claimed).eql([]);
    should(restored).eql([]);
  });

  it('should ask nothing more of a session nobody cut off, nor of the app on the host', async () => {
    const { subsystem } = cutOffReviver(new Set(['s1']));

    const plain = await drive(subsystem, 's2');
    const onHost = await drive(subsystem, 's1', { governed: false });

    should([plain.status, onHost.status]).eql([200, 200]);
    should([...plain.claimed, ...onHost.claimed]).eql([]);
  });

  it('should ask the route before the daemon restores a cut-off session for a device, and refuse when it cannot', async () => {
    const fyd = (await Bun.file(new URL('../../../../bin/fyd.ts', import.meta.url)).text()).replaceAll(/\s+/gu, ' ');
    should(fyd).containEql(
      "if (cutOff === 'restore' && actor === 'device') { if (confirmRestore === undefined) throw new SessionResumeError('refused',",
    );
    should(fyd).containEql("confirmRestore(); } if (cutOff === 'restore') await restoreCredential(storage, id);");
  });
});
