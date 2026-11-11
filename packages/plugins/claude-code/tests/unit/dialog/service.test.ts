import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FormKey } from '@ferretry/core-ferrets/contract';
import should from 'should';
import type { HarnessDialogAnswerRequest } from '../../../contract/index.ts';
import { DialogAnswerError, DialogAnswerService, type FerretDialogPane } from '../../../daemon/lib/dialog/service.ts';
import { parseHarnessDialog, recordedDialogId } from '../../../daemon/lib/pane/harness-dialog.ts';

/**
 * Answering a harness's own dialog for someone who is not at the terminal.
 *
 * The pane is a fake that serves captured frames and records every key pressed, so each test states
 * what was typed — and, more often, that nothing was.
 */

const FIXTURES = join(import.meta.dir, '../../fixtures/harness-dialogs');
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');

const REVIEW = fixture('claude-2.1.220-settings-error');
const MOVED = REVIEW.replace('❯ 1. Fix with Claude', '  1. Fix with Claude').replace(
  '    2. Exit and fix manually',
  '  ❯ 2. Exit and fix manually',
);
const TWO = fixture('claude-2.1.220-mcp-servers');
const UPDATE_OLD = REVIEW.replace('Enter to confirm · Esc to cancel', 'Press enter to continue');
const THIRD = REVIEW.replace('❯ 1. Fix with Claude', '  1. Fix with Claude').replace(
  '    3. Continue without these settings',
  '  ❯ 3. Continue without these settings',
);
const IDLE = '❯ \n  ? for shortcuts';

const DOWN = 'Down';
const UP = 'Up';
const ENTER = 'Enter';
const ESC = 'Escape';

const idOf = (pane: string): string =>
  (parseHarnessDialog(pane) as NonNullable<ReturnType<typeof parseHarnessDialog>>).id;
const choice = (pane: string, number: number): HarnessDialogAnswerRequest => ({
  kind: 'choice',
  dialogId: idOf(pane),
  number,
});
const pressEsc = (pane: string): HarnessDialogAnswerRequest => ({ kind: 'escape', dialogId: idOf(pane) });

/** Serves `frames` in order (the last one repeats); an `Error` frame makes that capture throw. */
class ScriptedPane implements FerretDialogPane {
  readonly writes: string[] = [];
  captures = 0;

  constructor(private readonly frames: readonly (string | Error)[]) {}

  async capture(): Promise<string> {
    const frame = this.frames[Math.min(this.captures, this.frames.length - 1)] as string | Error;
    this.captures += 1;
    await Promise.resolve();
    if (frame instanceof Error) throw frame;
    return frame;
  }

  async key(_ferretId: string, key: FormKey): Promise<void> {
    this.writes.push(key);
    await Promise.resolve();
  }
}

const recordingSleep = () => {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number): Promise<void> => {
      slept.push(ms);
      await Promise.resolve();
    },
  };
};

const TIMING = { settleReads: 3, settleMs: 10 } as const;

const refusalOf = async (promise: Promise<unknown>): Promise<DialogAnswerError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  should(error).be.instanceOf(DialogAnswerError);
  return error as DialogAnswerError;
};

describe('the frames these tests stand on', () => {
  it('should be one dialog under three cursor positions, and a different dialog for two hooks', () => {
    should(idOf(MOVED)).equal(idOf(REVIEW));
    should(idOf(THIRD)).equal(idOf(REVIEW));
    should(parseHarnessDialog(THIRD)?.selected).equal(3);
    should(idOf(TWO)).not.equal(idOf(REVIEW));
  });
});

describe('DialogAnswerService.answer, by the id Ferrets recorded', () => {
  const recorded = (pane: string): string =>
    recordedDialogId(parseHarnessDialog(pane) as NonNullable<ReturnType<typeof parseHarnessDialog>>);

  it('answers the dialog the recorded id names (the card holds it), moving the cursor and waiting for it as ever', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW, REVIEW, MOVED, IDLE]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const result = await service.answer('s1', { kind: 'choice', dialogId: recorded(REVIEW), number: 2 });

    // Assert
    should(result).eql({ dialogId: recorded(REVIEW), cleared: true });
    should(pane.writes).eql([DOWN, ENTER]);
  });

  it('refuses as gone, typing nothing, when the recorded id is another dialog’s', async () => {
    // Arrange
    const pane = new ScriptedPane([TWO]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', { kind: 'escape', dialogId: recorded(REVIEW) }));

    // Assert
    should(error.refusal).equal('gone');
    should(pane.writes).eql([]);
  });
});

describe('DialogAnswerService.answer — a choice', () => {
  it('presses Enter alone when the cursor is already on the chosen row', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW, REVIEW, IDLE]);
    const { sleep, slept } = recordingSleep();
    const service = new DialogAnswerService(pane, sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(REVIEW, 1));

    // Assert
    should(result).eql({ dialogId: idOf(REVIEW), cleared: true });
    should(pane.writes).eql([ENTER]);
    should(pane.captures).equal(3);
    should(slept).eql([10, 10]);
  });

  it('moves the cursor with arrows, waits for it to arrive, and only then presses Enter', async () => {
    // Arrange: the first read before the arrows, then the cursor has not moved yet, then it has, then gone.
    const pane = new ScriptedPane([REVIEW, REVIEW, MOVED, IDLE]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(REVIEW, 2));

    // Assert
    should(result).eql({ dialogId: idOf(REVIEW), cleared: true });
    should(pane.writes).eql([DOWN, ENTER]);
  });

  it('presses one arrow per row of distance, and Up when the choice is above the cursor', async () => {
    // Arrange
    const down = new ScriptedPane([REVIEW, THIRD, IDLE]);
    const up = new ScriptedPane([THIRD, REVIEW, IDLE]);

    // Act
    await new DialogAnswerService(down, recordingSleep().sleep, TIMING).answer('s1', choice(REVIEW, 3));
    await new DialogAnswerService(up, recordingSleep().sleep, TIMING).answer('s1', choice(THIRD, 1));

    // Assert
    should(down.writes).eql([DOWN, DOWN, ENTER]);
    should(up.writes).eql([UP, UP, ENTER]);
  });

  it('never presses Enter when the cursor does not arrive, and says the dialog did not clear', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW]);
    const { sleep, slept } = recordingSleep();
    const service = new DialogAnswerService(pane, sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(REVIEW, 3));

    // Assert
    should(result).eql({ dialogId: idOf(REVIEW), cleared: false });
    should(pane.writes).eql([DOWN, DOWN]);
    should(slept).eql([10, 10, 10]);
  });

  it('refuses as gone, with no Enter, when another dialog replaces it while the cursor moves', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW, TWO]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', choice(REVIEW, 2)));

    // Assert
    should(error.refusal).equal('gone');
    should(error.current?.id).equal(idOf(TWO));
    should(pane.writes).eql([DOWN]);
  });

  it('refuses as gone, with no Enter, when the dialog vanishes while the cursor moves', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW, IDLE]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', choice(REVIEW, 2)));

    // Assert
    should(error.refusal).equal('gone');
    should(error.current).be.undefined();
    should(pane.writes).eql([DOWN]);
  });

  it('reports a dialog that is still up after Enter as not cleared, having pressed Enter once', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW]);
    const { sleep, slept } = recordingSleep();
    const service = new DialogAnswerService(pane, sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(REVIEW, 1));

    // Assert
    should(result).eql({ dialogId: idOf(REVIEW), cleared: false });
    should(pane.writes).eql([ENTER]);
    should(slept).eql([10, 10, 10]);
    should(pane.captures).equal(4);
  });

  it('counts a different dialog after Enter as the first one cleared', async () => {
    // Arrange: answering hooks review can bring up another screen; the answered one is gone.
    const pane = new ScriptedPane([REVIEW, TWO]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(REVIEW, 1));

    // Assert
    should(result.cleared).be.true();
  });

  it('refuses an unlisted choice, and types nothing', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', choice(REVIEW, 7)));

    // Assert
    should(error.refusal).equal('invalid_choice');
    should(error.message).equal('the dialog has no choice 7');
    should(error.current?.id).equal(idOf(REVIEW));
    should(error.name).equal('DialogAnswerError');
    should(pane.writes).eql([]);
  });
});

describe('DialogAnswerService.answer — Esc', () => {
  it('presses Escape alone when the footer offers it, and reads until the dialog is gone', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW, REVIEW, IDLE]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const result = await service.answer('s1', pressEsc(REVIEW));

    // Assert
    should(result).eql({ dialogId: idOf(REVIEW), cleared: true });
    should(pane.writes).eql([ESC]);
  });

  it('reports an Escape the dialog ignored as not cleared', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const result = await service.answer('s1', pressEsc(REVIEW));

    // Assert
    should(result.cleared).be.false();
    should(pane.writes).eql([ESC]);
  });

  it('refuses an Escape the dialog does not offer, and types nothing', async () => {
    // Arrange
    should(parseHarnessDialog(UPDATE_OLD)?.escape).be.undefined();
    const pane = new ScriptedPane([UPDATE_OLD]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', pressEsc(UPDATE_OLD)));

    // Assert
    should(error.refusal).equal('invalid_choice');
    should(error.message).equal('this dialog offers no Esc');
    should(pane.writes).eql([]);
  });
});

describe('DialogAnswerService.answer — a dialog that is not there', () => {
  it('refuses as gone, and types nothing, when the pane now shows a different dialog', async () => {
    // Arrange
    const pane = new ScriptedPane([TWO]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', choice(REVIEW, 1)));

    // Assert
    should(error.refusal).equal('gone');
    should(error.current?.id).equal(idOf(TWO));
    should(pane.writes).eql([]);
  });

  it('refuses as gone, and types nothing, when the pane shows no dialog at all', async () => {
    // Arrange
    const pane = new ScriptedPane([IDLE]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', pressEsc(REVIEW)));

    // Assert
    should(error.refusal).equal('gone');
    should(error.current).be.undefined();
    should(pane.writes).eql([]);
  });

  it('waits fifteen reads of 200 ms by default', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW]);
    const { sleep, slept } = recordingSleep();
    const service = new DialogAnswerService(pane, sleep);

    // Act
    const result = await service.answer('s1', choice(REVIEW, 1));

    // Assert
    should(result.cleared).be.false();
    should(slept).eql(Array.from({ length: 15 }, () => 200));
  });

  it('reads a capture that throws after the key as no dialog', async () => {
    // Arrange
    const pane = new ScriptedPane([REVIEW, new Error('pane is gone')]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(REVIEW, 1));

    // Assert
    should(result.cleared).be.true();
    should(pane.writes).eql([ENTER]);
  });

  it('lets a capture that throws BEFORE any key fail the answer, with nothing typed', async () => {
    // Arrange
    const pane = new ScriptedPane([new Error('pane is gone')]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await service.answer('s1', choice(REVIEW, 1)).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    // Assert
    should((error as Error).message).equal('pane is gone');
    should(pane.writes).eql([]);
  });
});

describe('DialogAnswerService — one answer at a time per ferret', () => {
  /** A pane that shows the dialog until the first Enter lands, then shows nothing. */
  class AnsweredOnce implements FerretDialogPane {
    readonly writes: string[] = [];
    private shown = REVIEW;

    async capture(): Promise<string> {
      await Promise.resolve();
      await Promise.resolve();
      return this.shown;
    }

    async key(_ferretId: string, key: FormKey): Promise<void> {
      this.writes.push(key);
      if (key === ENTER) this.shown = IDLE;
      await Promise.resolve();
    }
  }

  it('lets the first of two concurrent answers through and refuses the second as gone', async () => {
    // Arrange
    const pane = new AnsweredOnce();
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const [first, second] = await Promise.allSettled([
      service.answer('s1', choice(REVIEW, 1)),
      service.answer('s1', choice(REVIEW, 1)),
    ]);

    // Assert
    should(first.status).equal('fulfilled');
    should(first.status === 'fulfilled' && first.value.cleared).be.true();
    should(second.status).equal('rejected');
    should(second.status === 'rejected' && (second.reason as DialogAnswerError).refusal).equal('gone');
    should(pane.writes).eql([ENTER]);
  });

  it('does not let a failure in the first block the second', async () => {
    // Arrange
    const pane = new ScriptedPane([new Error('boom'), REVIEW, IDLE]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const [first, second] = await Promise.allSettled([
      service.answer('s1', choice(REVIEW, 1)),
      service.answer('s1', choice(REVIEW, 1)),
    ]);

    // Assert
    should(first.status).equal('rejected');
    should(second.status).equal('fulfilled');
    should(second.status === 'fulfilled' && second.value.cleared).be.true();
    should(pane.writes).eql([ENTER]);
  });

  it('does not serialize two different sessions against each other', async () => {
    // Arrange
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const writes: string[] = [];
    const shown = new Map<string, string>([
      ['a', REVIEW],
      ['b', REVIEW],
    ]);
    const pane: FerretDialogPane = {
      async capture(ferretId) {
        if (ferretId === 'a') await held;
        return shown.get(ferretId) as string;
      },
      async key(ferretId, key) {
        writes.push(`${ferretId}:${key === ENTER ? 'enter' : 'key'}`);
        shown.set(ferretId, IDLE);
      },
    };
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);
    let aSettled = false;

    // Act
    const a = service.answer('a', choice(REVIEW, 1)).then(result => {
      aSettled = true;
      return result;
    });
    const b = await service.answer('b', choice(REVIEW, 1));

    // Assert
    should(b.cleared).be.true();
    should(aSettled).be.false();
    should(writes).eql(['b:enter']);
    release();
    should((await a).cleared).be.true();
    should(writes).eql(['b:enter', 'a:enter']);
  });
});

describe('DialogAnswerService — an unknown cursor is never confirmed', () => {
  it('types nothing on a frame with no cursor, the zero-move choice included', async () => {
    const bare = REVIEW.replace('❯ 1. Fix with Claude', '  1. Fix with Claude');
    const pane = new ScriptedPane([bare]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    const error = await refusalOf(service.answer('s1', choice(REVIEW, 1)));

    should(error.refusal).equal('cursor_unknown');
    should(error.message).containEql('could not be read safely');
    should(error.message).containEql('nothing was sent');
    should(error.message).containEql('answer it at the terminal');
    should(pane.writes).eql([]);
  });

  it('refuses a missing cursor under the recorded id too, and Esc as well: nothing is typed', async () => {
    const bare = REVIEW.replace('❯ 1. Fix with Claude', '  1. Fix with Claude');
    const pane = new ScriptedPane([bare]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    const byRecorded = await refusalOf(
      service.answer('s1', {
        kind: 'choice',
        dialogId: recordedDialogId(parseHarnessDialog(REVIEW) as never),
        number: 2,
      }),
    );
    const escaped = await refusalOf(service.answer('s1', pressEsc(REVIEW)));

    should([byRecorded.refusal, escaped.refusal]).eql(['cursor_unknown', 'cursor_unknown']);
    should(pane.writes).eql([]);
  });

  it('refuses two cursor rows as an unknown cursor, not as gone', async () => {
    const both = REVIEW.replace(/^(\s*)\s\s(?=2\.)/mu, '$1❯ ');
    should(both).not.equal(REVIEW);
    const pane = new ScriptedPane([both]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    const error = await refusalOf(service.answer('s1', choice(REVIEW, 1)));

    should(error.refusal).equal('cursor_unknown');
    should(pane.writes).eql([]);
  });

  it('keeps the gone answer for a dialog that really changed, and for a frame that is no dialog', async () => {
    const service = (frame: string) =>
      new DialogAnswerService(new ScriptedPane([frame]), recordingSleep().sleep, TIMING);

    const other = await refusalOf(service(TWO).answer('s1', choice(REVIEW, 1)));
    const idle = await refusalOf(service(IDLE).answer('s1', choice(REVIEW, 1)));

    should([other.refusal, idle.refusal]).eql(['gone', 'gone']);
  });

  it('never presses Enter when the redraw after an arrow shows no cursor: refused as an unknown cursor', async () => {
    const bare = REVIEW.replace('❯ 1. Fix with Claude', '  1. Fix with Claude');
    const pane = new ScriptedPane([THIRD, bare]);
    const service = new DialogAnswerService(pane, recordingSleep().sleep, TIMING);

    const error = await refusalOf(service.answer('s1', choice(REVIEW, 1)));

    should(error.refusal).equal('cursor_unknown');
    should(error.message).containEql('could not be read safely');
    should(pane.writes).eql([UP, UP]);
  });
});
