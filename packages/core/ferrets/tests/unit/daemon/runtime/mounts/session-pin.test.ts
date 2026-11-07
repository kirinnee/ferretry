import { describe, it } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import should from 'should';
import { AgentPinError, type PinnedFerret } from '../../../../../daemon/lib/agent-pins/index.ts';
import { type SessionPinSubsystem, sessionPinRoutes } from '../../../../../daemon/lib/runtime/mounts/session-pin.ts';
import { bodyOf, callOf, ferretSummary, refusalOf } from '../../support/calls.ts';

class FakePins implements SessionPinSubsystem {
  readonly calls: string[] = [];
  async pin(reference: string): Promise<PinnedFerret> {
    this.calls.push(`pin ${reference}`);
    if (reference === 'ghost') throw new AgentPinError('not-found', 'no ferret ghost');
    if (reference === 'crowded') throw new AgentPinError('full', 'too many');
    return { ...ferretSummary(reference), pinnedAt: '2026-11-01T10:00:00.000Z' };
  }
  async unpin(reference: string): Promise<PinnedFerret> {
    this.calls.push(`unpin ${reference}`);
    return ferretSummary(reference);
  }
}

const at = (ferretId: string) => callOf({ ferretId }, {});

describe('the ferret pin mount', () => {
  it('should pin and unpin for the owner, answering the ferret', async () => {
    const subsystem = new FakePins();
    const routes = sessionPinRoutes(subsystem);

    const pinned = await routes.pin(at('s1'));
    const unpinned = await routes.unpin(at('s1'));

    should([pinned.status, unpinned.status]).deepEqual([200, 200]);
    should(bodyOf(pinned).pinnedAt).equal('2026-11-01T10:00:00.000Z');
    should(bodyOf(unpinned)).not.have.property('pinnedAt');
    should(subsystem.calls).deepEqual(['pin s1', 'unpin s1']);
  });

  it('should restate the domain refusals in HTTP, and refuse an unusable id', async () => {
    const routes = sessionPinRoutes(new FakePins());
    should(await refusalOf(routes.pin(at('ghost')))).deepEqual({ status: 404, code: 'not-found' });
    should(await refusalOf(routes.pin(at('crowded')))).deepEqual({ status: 409, code: 'pin_limit' });
    should(await refusalOf(routes.pin(at('%2e%2e%2fetc')))).deepEqual({ status: 400, code: 'invalid_session_id' });
  });

  it('should not dress an unexpected failure up as a domain refusal', async () => {
    const broken: SessionPinSubsystem = {
      pin: async () => {
        throw new Error('disk gone');
      },
      unpin: async () => ferretSummary('s1'),
    };
    const thrown = await sessionPinRoutes(broken)
      .pin(at('s1'))
      .catch((error: unknown) => error);
    should(thrown).be.instanceOf(Error);
    should(thrown).not.be.instanceOf(ApiError);
  });
});
