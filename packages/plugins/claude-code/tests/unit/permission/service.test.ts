import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import { KeyPane, withCursor } from '../../support/key-pane.ts';
import type { FormKey } from '@ferretry/core-ferrets/contract';
import type { PermissionAnswerRequest } from '../../../contract/index.ts';
import { parsePermissionPrompt, recordedPermissionId } from '../../../daemon/lib/pane/permission-prompt.ts';
import {
  type FerretPane,
  PermissionAnswerError,
  PermissionAnswerService,
} from '../../../daemon/lib/permission/service.ts';

/**
 * Answering a harness permission prompt for someone who is not at the terminal.
 *
 * The pane is a fake that serves captured frames and records every key pressed, so each test states
 * what was typed — and, more often, that nothing was.
 */

const FIXTURES = join(import.meta.dir, '../../fixtures/permission-prompts');
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');

const BASH = fixture('claude-2.1.220-bash');
const WRITE = fixture('claude-2.1.220-write');
const IDLE = '❯ \n  ? for shortcuts';

const idOf = (pane: string): string =>
  (parsePermissionPrompt(pane) as NonNullable<ReturnType<typeof parsePermissionPrompt>>).id;
const choice = (pane: string, number: number): PermissionAnswerRequest => ({
  kind: 'choice',
  requestId: idOf(pane),
  number,
});
const deny = (pane: string): PermissionAnswerRequest => ({ kind: 'deny', requestId: idOf(pane) });

/** Serves `frames` in order (the last one repeats); an `Error` frame makes that capture throw. */
class ScriptedPane implements FerretPane {
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

const refusalOf = async (promise: Promise<unknown>): Promise<PermissionAnswerError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  should(error).be.instanceOf(PermissionAnswerError);
  return error as PermissionAnswerError;
};

describe('PermissionAnswerService.answer, by the id Ferrets recorded', () => {
  const recorded = (pane: string): string =>
    recordedPermissionId(parsePermissionPrompt(pane) as NonNullable<ReturnType<typeof parsePermissionPrompt>>);

  it('answers the prompt the recorded id names (the card holds it), and reports it under that id', async () => {
    // Arrange
    const pane = new KeyPane(BASH, IDLE);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const result = await service.answer('s1', { kind: 'choice', requestId: recorded(BASH), number: 2 });

    // Assert
    should(result).eql({ requestId: recorded(BASH), cleared: true });
    should(pane.keys).eql(['Down', 'Enter']);
  });

  it('still refuses as gone, typing nothing, when the recorded id is another prompt’s', async () => {
    // Arrange
    const pane = new ScriptedPane([WRITE]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', { kind: 'deny', requestId: recorded(BASH) }));

    // Assert
    should(error.refusal).equal('gone');
    should(pane.writes).eql([]);
  });
});

describe('PermissionAnswerService.answer', () => {
  it('moves the cursor to the chosen row, checks it arrived, presses Enter, then reads until the prompt is gone', async () => {
    // Arrange
    const pane = new KeyPane(BASH, IDLE);
    const { sleep, slept } = recordingSleep();
    const service = new PermissionAnswerService(pane, sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(BASH, 2));

    // Assert
    should(result).eql({ requestId: idOf(BASH), cleared: true });
    should(pane.keys).eql(['Down', 'Enter']);
    should(pane.captures).equal(3);
    should(slept).eql([10, 10]);
  });

  it('refuses a deny with Escape alone', async () => {
    // Arrange
    const pane = new ScriptedPane([BASH, IDLE]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const result = await service.answer('s1', deny(BASH));

    // Assert
    should(result.cleared).be.true();
    should(pane.writes).eql(['Escape']);
  });

  it('refuses as gone, and types nothing, when the pane now shows a different request', async () => {
    // Arrange
    const pane = new ScriptedPane([WRITE]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', choice(BASH, 1)));

    // Assert
    should(error.refusal).equal('gone');
    should(error.current?.id).equal(idOf(WRITE));
    should(pane.writes).eql([]);
  });

  it('refuses as gone, and types nothing, when the pane shows no prompt at all', async () => {
    // Arrange
    const pane = new ScriptedPane([IDLE]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', deny(BASH)));

    // Assert
    should(error.refusal).equal('gone');
    should(error.current).be.undefined();
    should(error.name).equal('PermissionAnswerError');
    should(pane.writes).eql([]);
  });

  it('refuses an unlisted choice, and types nothing', async () => {
    // Arrange
    const pane = new ScriptedPane([BASH]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', choice(BASH, 7)));

    // Assert
    should(error.refusal).equal('invalid_choice');
    should(error.message).equal('the prompt has no choice 7');
    should(error.current?.id).equal(idOf(BASH));
    should(pane.writes).eql([]);
  });

  it('reports a prompt that is still up as not cleared, having typed once and never again', async () => {
    // Arrange
    const pane = new ScriptedPane([BASH]);
    const { sleep, slept } = recordingSleep();
    const service = new PermissionAnswerService(pane, sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(BASH, 1));

    // Assert
    should(result).eql({ requestId: idOf(BASH), cleared: false });
    should(pane.writes).eql(['Enter']);
    should(slept).eql([10, 10, 10]);
    should(pane.captures).equal(4);
  });

  it('waits fifteen reads of 200 ms by default', async () => {
    // Arrange
    const pane = new ScriptedPane([BASH]);
    const { sleep, slept } = recordingSleep();
    const service = new PermissionAnswerService(pane, sleep);

    // Act
    const result = await service.answer('s1', choice(BASH, 1));

    // Assert
    should(result.cleared).be.false();
    should(slept).eql(Array.from({ length: 15 }, () => 200));
  });

  it('reads a capture that throws after the key as no prompt', async () => {
    // Arrange
    const pane = new ScriptedPane([BASH, new Error('pane is gone')]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(BASH, 1));

    // Assert
    should(result.cleared).be.true();
    should(pane.writes).eql(['Enter']);
  });

  it('lets a capture that throws BEFORE the key fail the answer, with nothing typed', async () => {
    // Arrange
    const pane = new ScriptedPane([new Error('pane is gone')]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await service.answer('s1', choice(BASH, 1)).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    // Assert
    should((error as Error).message).equal('pane is gone');
    should(pane.writes).eql([]);
  });
});

describe('PermissionAnswerService — the cursor is checked before Enter', () => {
  it('moves up as well as down: choice 1 from a cursor on row 3 presses Up twice', async () => {
    // Arrange
    const pane = new KeyPane(withCursor(BASH, 3), IDLE);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(BASH, 1));

    // Assert
    should(result.cleared).be.true();
    should(pane.keys).eql(['Up', 'Up', 'Enter']);
  });

  it('never presses Enter when the cursor does not arrive on the chosen row', async () => {
    // Arrange
    const pane = new KeyPane(BASH, IDLE);
    pane.moves = false;
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', choice(BASH, 3)));

    // Assert: refused with words for the owner, and Enter never pressed
    should(error.refusal).equal('cursor_unknown');
    should(error.message).match(/nothing was confirmed/u);
    should(pane.keys).eql(['Down', 'Down']);
  });

  it('never presses Enter when another prompt replaced the request while the cursor moved', async () => {
    // Arrange: the first Down lands on the next permission prompt.
    const pane = new KeyPane(BASH, WRITE);
    pane.clears = true;
    const press = pane.key.bind(pane);
    pane.key = async (ferretId, key) => {
      await press(ferretId, key);
      pane.frame = WRITE;
    };
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', choice(BASH, 2)));

    // Assert
    should(error.refusal).equal('gone');
    should(pane.keys).eql(['Down']);
  });
});

describe('PermissionAnswerService — one answer at a time per ferret', () => {
  /** A pane that shows the prompt until the first key lands, then shows nothing. */
  class AnsweredOnce implements FerretPane {
    readonly writes: string[] = [];
    private shown = BASH;

    async capture(): Promise<string> {
      await Promise.resolve();
      await Promise.resolve();
      return this.shown;
    }

    async key(_ferretId: string, key: FormKey): Promise<void> {
      this.writes.push(key);
      this.shown = IDLE;
      await Promise.resolve();
    }
  }

  it('lets the first of two concurrent answers through and refuses the second as gone', async () => {
    // Arrange
    const pane = new AnsweredOnce();
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const [first, second] = await Promise.allSettled([
      service.answer('s1', choice(BASH, 1)),
      service.answer('s1', choice(BASH, 3)),
    ]);

    // Assert
    should(first.status).equal('fulfilled');
    should(first.status === 'fulfilled' && first.value.cleared).be.true();
    should(second.status).equal('rejected');
    should(second.status === 'rejected' && (second.reason as PermissionAnswerError).refusal).equal('gone');
    should(pane.writes).eql(['Enter']);
  });

  it('does not let a failure in the first block the second', async () => {
    // Arrange
    const pane = new ScriptedPane([new Error('boom'), BASH, IDLE]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const [first, second] = await Promise.allSettled([
      service.answer('s1', choice(BASH, 1)),
      service.answer('s1', choice(BASH, 1)),
    ]);

    // Assert
    should(first.status).equal('rejected');
    should(second.status).equal('fulfilled');
    should(second.status === 'fulfilled' && second.value.cleared).be.true();
    should(pane.writes).eql(['Enter']);
  });

  it('does not serialize two different ferrets against each other', async () => {
    // Arrange
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const writes: string[] = [];
    const shown = new Map<string, string>([
      ['a', BASH],
      ['b', BASH],
    ]);
    const pane: FerretPane = {
      async capture(ferretId) {
        if (ferretId === 'a') await held;
        return shown.get(ferretId) as string;
      },
      async key(ferretId, key) {
        writes.push(`${ferretId}:${key}`);
        shown.set(ferretId, IDLE);
      },
    };
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);
    let aSettled = false;

    // Act
    const a = service.answer('a', choice(BASH, 1)).then(result => {
      aSettled = true;
      return result;
    });
    const b = await service.answer('b', deny(BASH));

    // Assert
    should(b.cleared).be.true();
    should(aSettled).be.false();
    should(writes).eql(['b:Escape']);
    release();
    should((await a).cleared).be.true();
    should(writes).eql(['b:Escape', 'a:Enter']);
  });
});

/** The same frame with its cursor glyph undrawn (a redraw that lost the marker); labels and identity kept. */
const markerless = (frame: string): string => frame.replace(/^(\s*)[❯›>]\s(?=[1-9][.)])/gmu, '$1  ');

describe('PermissionAnswerService — an unknown cursor is never confirmed', () => {
  it('refuses a choice on a frame with no cursor marker: nothing typed, no Enter, the zero-move path included', async () => {
    // Arrange: the live list is on row 2; the captured frame shows no cursor. Choosing row 1 must not press Enter.
    const frame = markerless(BASH);
    const pane = new ScriptedPane([frame]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', choice(BASH, 1)));

    // Assert
    should(error.refusal).equal('cursor_unknown');
    should(error.message).match(/could not be read safely/u);
    should(pane.writes).eql([]);
  });

  it('refuses a choice when two rows show a cursor: ambiguous, nothing typed', async () => {
    const both = BASH.replace(/^(\s*)\s\s(?=2[.)])/mu, '$1❯ ');
    should(parsePermissionPrompt(both)?.selected).be.undefined();
    const pane = new ScriptedPane([both]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    const error = await refusalOf(service.answer('s1', choice(BASH, 1)));

    should(error.refusal).equal('cursor_unknown');
    should(pane.writes).eql([]);
  });

  it('never presses Enter after a dropped arrow when the redraw shows no cursor: markerless is no evidence', async () => {
    // Arrange: cursor on 3, choose 1; the first Up is lost and the pane redraws without its marker.
    const pane = new ScriptedPane([withCursor(BASH, 3), markerless(BASH)]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    // Act
    const error = await refusalOf(service.answer('s1', choice(BASH, 1)));

    // Assert
    should(error.refusal).equal('cursor_unknown');
    should(error.message).match(/could not be read safely/u);
    should(pane.writes).eql(['Up', 'Up']);
  });

  it('still refuses an unlisted choice as invalid, not as an unknown cursor', async () => {
    const pane = new ScriptedPane([markerless(BASH)]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    const error = await refusalOf(service.answer('s1', choice(BASH, 9)));

    should(error.refusal).equal('invalid_choice');
    should(pane.writes).eql([]);
  });

  it('denies with Escape alone even when the cursor is unknown: a refusal needs no cursor', async () => {
    const pane = new ScriptedPane([markerless(BASH), IDLE]);
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);

    const result = await service.answer('s1', deny(BASH));

    should(result.cleared).be.true();
    should(pane.writes).eql(['Escape']);
  });
});
