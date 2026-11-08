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
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { createWardenRemedies, RESTART_STOP_REASON } from '../../daemon/remedies.ts';

/** Ferrets' fake with the additives it does not model: the options a resume carries, what it decided, and the move. */
class AdditiveFerrets extends FakeFerrets {
  readonly resumeOptions: (ResumeOptions | undefined)[] = [];
  readonly moves: { ferret: FerretId; runtime: string; options?: MoveOptions; caller?: FerretId }[] = [];
  refuseMove: MoveFailure | undefined;

  /** Run just before the resume decides: a start or a stop that lands between the Warden's read and its resume. */
  beforeResume: ((ferret: FerretId) => void) | undefined;

  /** Models Ferrets' `decided` answer as its service gives it: a stopped ferret relaunches, any other is left running. */
  override async resume(ferret: FerretId, message?: string, options?: ResumeOptions) {
    const { decided, ...recorded } = options ?? {};
    this.resumeOptions.push(options === undefined ? undefined : recorded);
    this.beforeResume?.(ferret);
    const before = (await this.get(ferret))?.state;
    const resumed = await super.resume(ferret, message);
    if (resumed.ok) decided?.(before === 'stopped' ? 'relaunching' : 'running');
    return resumed;
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
  const undelivered: string[] = [];
  const made = createWardenRemedies({
    ferrets,
    asks,
    conversation,
    acted: (ferret, action, outcome) => acted.push(`${ferret} ${action} ${outcome}`),
    noticeUndelivered: (ferret, reason) => undelivered.push(`${ferret}: ${reason}`),
  });
  return { ferrets, asks, acted, undelivered, conversation, ...made };
}

/** Conversation as 5.0 has it: every send refuses until its terminal seam lands. */
const refuseSends = (conversation: ConversationApi): void => {
  (conversation as { send: ConversationApi['send'] }).send = async () =>
    err({ code: 'unavailable', message: 'This needs the ferret’s terminal' } as never);
};

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

/** Every send the Warden asked Conversation for, refused as 5.0 still refuses them. */
const recordRefusedSends = (conversation: ConversationApi): string[] => {
  const asked: string[] = [];
  (conversation as { send: ConversationApi['send'] }).send = async ferret => {
    asked.push(ferret);
    return err({ code: 'unavailable', message: 'This needs the ferret’s terminal' } as never);
  };
  return asked;
};

describe('M2 a Warden resume hands its message over once: as the relaunch’s turn, or said to a running ferret', () => {
  it('M2 should give a stopped ferret the message as its relaunch’s turn, never say it again, and journal no false "not delivered"', async () => {
    // Arrange
    const { ferrets, conversation, undelivered, resume } = subject();
    const asked = recordRefusedSends(conversation);
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });

    // Act
    const revived = await resume('f1', 'carry on');

    // Assert: Ferrets writes it as the turn and types its pointer; nothing is sent a second time.
    should(revived).eql({ ok: true });
    should(ferrets.resumes).eql([{ ferret: 'f1', message: 'carry on' }]);
    should(asked).eql([]);
    should(undelivered).eql([]);
  });

  it('M2 should report a resume and a restart done with nothing said again, and journal a refused notice only for a running ferret', async () => {
    // Arrange
    const { ferrets, conversation, acted, undelivered, remedies } = subject();
    const asked = recordRefusedSends(conversation);
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });
    ferrets.add({ id: ferretId('f2'), state: 'working' });
    ferrets.add({ id: ferretId('f3'), state: 'working' });

    // Act: a resume of a stopped ferret and a restart both relaunch; a resume of a running one relaunches nothing.
    await remedies.resume('f1', 'carry on');
    await remedies.restart('f2', 'carry on');
    await remedies.resume('f3', 'carry on');

    // Assert
    should(acted).eql(['f1 resume done', 'f2 restart done', 'f3 resume done']);
    should(asked).eql(['f3']);
    should(undelivered).have.length(1);
    should(undelivered[0]).startWith('f3: ');
  });

  it('should answer a revive of a running ferret as ok, saying it could not be told why when the notice is refused', async () => {
    // Arrange
    const { ferrets, conversation, undelivered, resume } = subject();
    refuseSends(conversation);
    ferrets.add({ id: ferretId('f1'), state: 'working' });

    // Act
    const revived = await resume('f1', 'carry on');

    // Assert
    should(revived.ok).be.true();
    should((revived as { caveat?: string }).caveat).startWith('It could not be told why');
    should(undelivered).have.length(1);
  });
});

describe('m2 the Warden hands its notice over by what Ferrets did, never by its own earlier read', () => {
  it('m2 should say the notice when the ferret was started between the Warden’s read and its resume (no drop)', async () => {
    // Arrange: stopped when the Warden looks, started by someone else before Ferrets decides.
    const { ferrets, conversation, undelivered, resume } = subject();
    const asked = recordRefusedSends(conversation);
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });
    ferrets.beforeResume = ferret => ferrets.setState(ferret, 'working');

    // Act
    const revived = await resume('f1', 'carry on');

    // Assert: Ferrets left it running (no turn carried the words), so the Warden says them, once.
    should(revived.ok).be.true();
    should(asked).eql(['f1']);
    should(undelivered).have.length(1);
  });

  it('m2 should not say the notice again when the ferret was stopped between the Warden’s read and its resume (no double)', async () => {
    // Arrange: running when the Warden looks, stopped before Ferrets decides, so the resume relaunches it.
    const { ferrets, conversation, undelivered, remedies } = subject();
    const asked = recordRefusedSends(conversation);
    ferrets.add({ id: ferretId('f1'), state: 'working' });
    ferrets.beforeResume = ferret => ferrets.setState(ferret, 'stopped');

    // Act
    await remedies.resume('f1', 'carry on');

    // Assert: the relaunch’s turn carried the words; nothing is said a second time, nothing is journalled.
    should(ferrets.resumes).eql([{ ferret: 'f1', message: 'carry on' }]);
    should(asked).eql([]);
    should(undelivered).eql([]);
  });
});

describe('a resume Ferrets did not answer cleanly', () => {
  it('should count a revive as done when Ferrets threw instead of answering (whether it started cannot be told)', async () => {
    // Arrange
    const { ferrets, resume } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });
    ferrets.resume = async () => await Promise.reject(new Error('the runner went away'));

    // Act
    const revived = await resume('f1', 'carry on');

    // Assert: fail closed — counted as a revive
    should(revived.ok).be.true();
    should((revived as { caveat?: string }).caveat).containEql('counts as a revive');
  });

  it('should answer ok false when Ferrets itself refused the resume (nothing started)', async () => {
    // Arrange
    const { ferrets, resume } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });
    ferrets.resume = async () => err({ code: 'failed', reason: 'no login' } as never);

    // Act
    const refused = await resume('f1', 'carry on');

    // Assert
    should(refused).eql({ ok: false, reason: 'revive refused: no login' });
  });

  it('should count a revive when Ferrets relaunched the ferret and then answered no (its turn’s pointer did not land)', async () => {
    // Arrange: Ferrets commits the relaunch (says `relaunching`), then the pointer to the turn does not reach the pane.
    const { ferrets, resume, acted } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });
    ferrets.resume = async (_ferret, _message, options) => {
      options?.decided?.('relaunching');
      return err({ code: 'failed', reason: 'the turn could not be handed over' } as never);
    };

    // Act
    const revived = await resume('f1', 'carry on');

    // Assert: counted (cooldown, crash_repeat and the breaker see it), with the reason in its caveat; nothing said.
    should(revived.ok).be.true();
    should((revived as { caveat?: string }).caveat).containEql('counts as a revive');
    should((revived as { caveat?: string }).caveat).containEql('the turn could not be handed over');
    should(acted).eql([]);
  });

  it('should not count a revive Ferrets refused before it decided anything, nor one it answered no while running', async () => {
    // Arrange: one refusal with no decision told, one after `running` (nothing relaunched).
    const { ferrets, resume } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });
    ferrets.add({ id: ferretId('f2'), state: 'stopped' });
    ferrets.resume = async (ferret, _message, options) => {
      if (ferret === ferretId('f2')) options?.decided?.('running');
      return err({ code: 'refused', reason: 'not now' } as never);
    };

    // Act
    const before = await resume('f1', 'carry on');
    const running = await resume('f2', 'carry on');

    // Assert: nothing started, so neither is a revive.
    should(before).eql({ ok: false, reason: 'revive refused: not now' });
    should(running).eql({ ok: false, reason: 'revive refused: not now' });
  });

  it('should record a resume and a restart that relaunched and then failed as failed remedies', async () => {
    // Arrange
    const { ferrets, remedies, acted } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'stopped' });
    ferrets.resume = async (_ferret, _message, options) => {
      options?.decided?.('relaunching');
      return err({ code: 'failed', reason: 'the turn could not be handed over' } as never);
    };

    // Act
    const resumed = await remedies.resume('f1', 'carry on').catch((error: unknown) => error);

    // Assert: the remedy row stays `failed` (more honest than today's `done`), with the relaunch named in the error.
    should((resumed as Error).message).eql(
      'resume relaunched the ferret, then failed: the turn could not be handed over',
    );
    should(acted).eql(['f1 resume failed']);
  });
});

describe('the Warden’s resumes are automatic and its own (ResumeOptions.automatic, ResumeOptions.actor)', () => {
  it('M2 should mark a resume, a restart and a revive as automated recovery by the Warden, so its turn is from the Warden', async () => {
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
    should(ferrets.resumeOptions).eql([
      { automatic: true, actor: 'warden' },
      { automatic: true, actor: 'warden' },
      { automatic: true, actor: 'warden' },
    ]);
  });
});

describe('the Warden moves a ferret to another login (a failover, through Ferrets’ move)', () => {
  it('should move the same ferret onto the named runtime moved by the Warden (today’s movedBy only), and report it done', async () => {
    // Arrange
    const { ferrets, remedies, acted } = subject();
    ferrets.add({ id: ferretId('f1'), state: 'working', runtime: 'claude-a' as never });

    // Act
    await remedies.failover('f1', 'claude-b');

    // Assert
    should(ferrets.moves).eql([{ ferret: 'f1', runtime: 'claude-b', options: { movedBy: 'warden' } }]);
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
