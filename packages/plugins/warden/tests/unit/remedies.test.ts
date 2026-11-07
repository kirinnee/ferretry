import { describe, it } from 'bun:test';
import should from 'should';
import { entryId, FakeAsks, sourceKey } from '@ferretry/core-asks/contract/testing';
import type {
  FerretId,
  FerretsApi,
  FerretSummary,
  MoveFailure,
  MoveOptions,
  ResumeOptions,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { err, ok, type Result } from '@ferretry/std';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { createWardenRemedies, RESTART_STOP_REASON } from '../../daemon/remedies.ts';

/** Ferrets' fake with the two additives it does not model: the options a resume carries, and the move. */
class AdditiveFerrets extends FakeFerrets {
  readonly resumeOptions: (ResumeOptions | undefined)[] = [];
  readonly moves: { ferret: FerretId; runtime: string; options?: MoveOptions; caller?: FerretId }[] = [];
  refuseMove: MoveFailure | undefined;

  override async resume(ferret: FerretId, message?: string, options?: ResumeOptions) {
    this.resumeOptions.push(options);
    return await super.resume(ferret, message);
  }

  move: NonNullable<FerretsApi['move']> = async (
    ferret,
    runtime,
    options,
    caller,
  ): Promise<Result<FerretSummary, MoveFailure>> => {
    this.moves.push({
      ferret,
      runtime,
      ...(options === undefined ? {} : { options }),
      ...(caller === undefined ? {} : { caller }),
    });
    const found = await this.get(ferret);
    if (found === undefined || this.refuseMove !== undefined)
      return err(this.refuseMove ?? { code: 'not_found', reason: 'no such ferret' });
    return ok({ ...found, runtime });
  };
}

function subject() {
  const ferrets = new AdditiveFerrets();
  const asks = new FakeAsks();
  const conversation = fakeConversation();
  const acted: string[] = [];
  const made = createWardenRemedies({
    ferrets,
    asks,
    conversation,
    acted: (ferret, action, outcome) => acted.push(`${ferret} ${action} ${outcome}`),
  });
  return { ferrets, asks, acted, ...made };
}

const askQuestion = async (asks: FakeAsks, ferret: string): Promise<void> => {
  await asks.raise({
    source: sourceKey('ferret'),
    entry: entryId(`${ferret}-q`),
    ref: {},
    kind: 'yesno',
    subject: 'Ship it?',
    why: 'a decision',
    raisedBy: { kind: 'ferret', ferret },
    ferret,
  });
};

describe('the Warden stops a ferret', () => {
  it('should give Ferrets the Warden reason, so the history does not say "stopped by client"', async () => {
    // Arrange
    const { ferrets, remedies } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'working' });

    // Act
    await remedies.stop('f1', 'it is burning time with no progress');

    // Assert
    should(ferrets.stops).eql([{ ferret: 'f1', how: 'polite', reason: 'it is burning time with no progress' }]);
  });
});

describe('the Warden restarts a ferret (today’s authorizeResume under the automatic policy)', () => {
  it('should stop it with the Warden reason, then resume it', async () => {
    // Arrange
    const { ferrets, remedies, acted } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'working' });

    // Act
    await remedies.restart('f1');

    // Assert
    should(ferrets.stops).eql([{ ferret: 'f1', how: 'now', reason: RESTART_STOP_REASON }]);
    should(ferrets.resumes).eql([{ ferret: 'f1' }]);
    should(acted).eql(['f1 restart done']);
  });

  it('should refuse a live ferret holding an unanswered question of its own, and stop nothing', async () => {
    // Arrange
    const { ferrets, asks, remedies, acted } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'idle' });
    await askQuestion(asks, 'f1');

    // Act
    const refused = await remedies.restart('f1').catch((error: Error) => error);

    // Assert
    should(refused).be.an.Error();
    should((refused as Error).message).equal(
      'answer or abandon the pending question on f1 before resuming this live session',
    );
    should(ferrets.stops).eql([]);
    should(ferrets.resumes).eql([]);
    should(acted).eql(['f1 restart failed']);
  });

  it('should refuse when a live ferret shares its label and checkout (the automatic-recovery dedupe scope)', async () => {
    // Arrange
    const { ferrets, remedies } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'working', label: 'batch-7', folder: '/work/repo' });
    ferrets.add({ id: ferretId('f2'), state: 'working', label: 'batch-7', folder: '/work/repo/' });

    // Act
    const refused = await remedies.restart('f1').catch((error: Error) => error);

    // Assert
    should((refused as Error).message).startWith('automatic revive suppressed for session f1: live session f2');
    should(ferrets.stops).eql([]);
  });

  it('should not dedupe against a ferret that is stopped, or one with no label', async () => {
    // Arrange
    const { ferrets, remedies } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'working', label: 'batch-7', folder: '/work/repo' });
    ferrets.add({ id: ferretId('f2'), state: 'stopped', label: 'batch-7', folder: '/work/repo' });
    ferrets.add({ id: ferretId('f3'), state: 'working', folder: '/work/repo' });

    // Act
    await remedies.restart('f1');

    // Assert
    should(ferrets.resumes).eql([{ ferret: 'f1' }]);
  });
});

describe('the auto-revive resume', () => {
  it('should answer a refusal as ok false, never a throw', async () => {
    // Arrange
    const { ferrets, resume } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'stopped', label: 'b', folder: '/w' });
    ferrets.add({ id: ferretId('f2'), state: 'working', label: 'b', folder: '/w' });

    // Act
    const refused = await resume('f1', 'carry on');
    const unknown = await resume('nobody', 'carry on');

    // Assert
    should(refused.ok).be.false();
    should(unknown).eql({ ok: false, reason: 'no ferret nobody to resume' });
    should(ferrets.resumes).eql([]);
  });

  it('should resume a stopped ferret with its turn even when it has a question open (its pane is gone)', async () => {
    // Arrange
    const { ferrets, asks, resume } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });
    await askQuestion(asks, 'f1');

    // Act
    const revived = await resume('f1', 'carry on');

    // Assert
    should(revived).eql({ ok: true });
    should(ferrets.resumes).eql([{ ferret: 'f1', message: 'carry on' }]);
  });
});

describe('the Warden’s resumes are automatic (ResumeOptions.automatic)', () => {
  it('should mark a resume, a restart and a revive as automated recovery, not a person asking', async () => {
    // Arrange
    const { ferrets, remedies, resume } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });
    ferrets.add({ id: ferretId('f2'), state: 'working' });
    ferrets.add({ id: ferretId('f3'), state: 'stopped' });

    // Act
    await remedies.resume('f1');
    await remedies.restart('f2');
    await resume('f3', 'carry on');

    // Assert
    should(ferrets.resumeOptions).eql([{ automatic: true }, { automatic: true }, { automatic: true }]);
  });
});

describe('the Warden moves a ferret to another login (a failover, through Ferrets’ move)', () => {
  it('should move the same ferret onto the named runtime as the Warden, and report it done', async () => {
    // Arrange
    const { ferrets, remedies, acted } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'working', runtime: 'claude-a' as never });

    // Act
    await remedies.failover('f1', 'claude-b');

    // Assert
    should(ferrets.moves).eql([{ ferret: 'f1', runtime: 'claude-b', options: { actor: 'warden', movedBy: 'warden' } }]);
    should(acted).eql(['f1 failover done']);
  });

  it('should throw Ferrets’ own reason when the move is refused, and report it failed', async () => {
    // Arrange
    const { ferrets, remedies, acted } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'working' });
    ferrets.refuseMove = { code: 'move_refused', reason: 'a tool is running' };

    // Act
    const refused = await remedies.failover('f1', 'claude-b').catch((error: Error) => error);

    // Assert
    should((refused as Error).message).equal('the move was refused: a tool is running');
    should(acted).eql(['f1 failover failed']);
  });
});
