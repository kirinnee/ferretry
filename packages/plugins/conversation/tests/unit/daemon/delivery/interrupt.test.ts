import { describe, it } from 'bun:test';
import should from 'should';
import { SessionInterrupt, type TurnStopped } from '../../../../daemon/delivery/lib/interrupt.ts';
import {
  SendRefused,
  type SendRepository,
  type SendTarget,
  type SendTransition,
  SendUnavailable,
} from '../../../../daemon/delivery/lib/types.ts';
import { parseSessionId } from '../../../../daemon/seams/ferret-id.ts';
import { KeyedSerialExecutor } from '../../../../daemon/seams/keyed-serial-executor.ts';

const ID = parseSessionId('session-1');

function target(overrides: Partial<SendTarget> = {}): SendTarget {
  return { id: ID, status: 'running', mode: 'auto', turn: 3, ...overrides };
}

class FakeRepository implements Pick<SendRepository, 'read' | 'transition'> {
  readonly transitions: SendTransition[] = [];
  constructor(private current: SendTarget | undefined) {}

  async read(): Promise<SendTarget | undefined> {
    return this.current;
  }

  async transition(_id: string, change: SendTransition): Promise<SendTarget> {
    this.transitions.push(change);
    if (this.current === undefined) throw new Error('no session to transition');
    this.current = { ...this.current, ...(change.status === undefined ? {} : { status: change.status }) };
    return this.current;
  }
}

/** One interrupt over a fake session and a fake harness stop that answers `stopped` (or throws `refusal`). */
function parts(session: SendTarget | undefined, stopped: TurnStopped = { pressed: true, working: false }) {
  const repository = new FakeRepository(session);
  const stops: string[] = [];
  let refusal: Error | undefined;
  const service = new SessionInterrupt({
    repository,
    serial: new KeyedSerialExecutor(),
    stopTurn: async id => {
      stops.push(id);
      if (refusal !== undefined) throw refusal;
      return stopped;
    },
  });
  return {
    service,
    repository,
    stops,
    refuseWith: (error: Error) => {
      refusal = error;
    },
  };
}

describe('interrupt (the harness stop, behind the session layer’s own refusals)', () => {
  it('stops the turn and marks an auto session interrupted', async () => {
    const { service, stops, repository } = parts(target(), { pressed: true, working: false });
    const after = await service.interrupt(ID);
    should(stops).eql([ID]);
    should(repository.transitions[0]).match({
      event: 'control.interrupted',
      status: 'interrupted',
      promptReady: true,
      reason: 'interrupted by client',
      data: { pressed: true },
    });
    should(after.status).equal('interrupted');
  });

  it('hands an interactive terminal back to its human rather than marking it interrupted forever', async () => {
    const { service, repository } = parts(target({ mode: 'interactive' }), { pressed: true, working: false });
    const after = await service.interrupt(ID);
    should(repository.transitions[0]).match({ event: 'control.interrupted', status: 'awaiting_user' });
    should(repository.transitions[0]?.reason).be.undefined();
    should(after.status).equal('awaiting_user');
  });

  it('keeps `interrupted` for an interactive session that is still visibly working', async () => {
    const { service, repository } = parts(target({ mode: 'interactive' }), { pressed: true, working: true });
    await service.interrupt(ID);
    should(repository.transitions[0]?.status).equal('interrupted');
  });

  it('still records the interrupt when the pane could not be read afterwards (working absent proves nothing)', async () => {
    const { service, repository } = parts(target({ mode: 'interactive' }), { pressed: true });
    await service.interrupt(ID);
    should(repository.transitions[0]?.status).equal('interrupted');
  });

  it('records the interrupt when the harness pressed nothing at an idle auto pane, and says so', async () => {
    const { service, repository } = parts(target(), { pressed: false, working: false });
    await service.interrupt(ID);
    should(repository.transitions[0]).match({ status: 'interrupted', data: { pressed: false } });
  });

  it('refuses to abandon a rendered structured question by accident, BEFORE the harness is asked to press', async () => {
    const { service, stops, repository } = parts(target({ pendingQuestion: { toolUseId: 'tool-7' } }));
    await should(service.interrupt(ID)).be.rejectedWith(SendUnavailable);
    await should(service.interrupt(ID)).be.rejectedWith(/tool-7/u);
    should(stops).be.empty();
    should(repository.transitions).be.empty();
  });

  it('refuses a session whose shutdown was never confirmed, before any press', async () => {
    const { service, stops } = parts(target({ status: 'kill_failed' }));
    await should(service.interrupt(ID)).be.rejectedWith(SendUnavailable);
    await should(service.interrupt(ID)).be.rejectedWith(/was not confirmed/u);
    should(stops).be.empty();
  });

  it.each(['completed', 'stopped', 'failed'] as const)(
    'refuses a %s session: there is no running turn, and nothing is pressed',
    async status => {
      const { service, stops, repository } = parts(target({ status }));
      await should(service.interrupt(ID)).be.rejectedWith(SendRefused);
      await should(service.interrupt(ID)).be.rejectedWith(/no running turn/u);
      should(stops).be.empty();
      should(repository.transitions).be.empty();
    },
  );

  it('a refusal from the harness stop records nothing: no interrupted state for a stop that pressed nothing', async () => {
    const { service, repository, refuseWith } = parts(target());
    refuseWith(new SendRefused('the pane is held'));
    await should(service.interrupt(ID)).be.rejectedWith(/the pane is held/u);
    should(repository.transitions).be.empty();
  });

  it('refuses a session it cannot read', async () => {
    const { service, stops } = parts(undefined);
    await should(service.interrupt(ID)).be.rejectedWith(SendRefused);
    await should(service.interrupt(ID)).be.rejectedWith(/session not found/u);
    should(stops).be.empty();
  });
});
