import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import type { PermissionAnswerRequest } from '../../../contract/index.ts';
import { parsePermissionPrompt } from '../../../daemon/lib/pane/permission-prompt.ts';
import {
  type FerretPane,
  PermissionAnswerError,
  PermissionAnswerService,
} from '../../../daemon/lib/permission/service.ts';

/**
 * Answering a harness permission prompt for someone who is not at the terminal.
 *
 * The pane is a fake that serves captured frames and records every byte written, so each test states
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

  async write(_ferretId: string, bytes: Uint8Array): Promise<number> {
    this.writes.push(new TextDecoder().decode(bytes));
    return bytes.length;
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

describe('PermissionAnswerService.answer', () => {
  it('types exactly the digit of the chosen row, then reads until the prompt is gone', async () => {
    // Arrange
    const pane = new ScriptedPane([BASH, BASH, IDLE]);
    const { sleep, slept } = recordingSleep();
    const service = new PermissionAnswerService(pane, sleep, TIMING);

    // Act
    const result = await service.answer('s1', choice(BASH, 2));

    // Assert
    should(result).eql({ requestId: idOf(BASH), cleared: true });
    should(pane.writes).eql(['2']);
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
    should(pane.writes).eql(['\u001b']);
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
    should(pane.writes).eql(['1']);
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
    should(pane.writes).eql(['1']);
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

    async write(_ferretId: string, bytes: Uint8Array): Promise<number> {
      this.writes.push(new TextDecoder().decode(bytes));
      this.shown = IDLE;
      return bytes.length;
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
    should(pane.writes).eql(['1']);
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
    should(pane.writes).eql(['1']);
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
      async write(ferretId, bytes) {
        writes.push(`${ferretId}:${new TextDecoder().decode(bytes)}`);
        shown.set(ferretId, IDLE);
        return bytes.length;
      },
    };
    const service = new PermissionAnswerService(pane, recordingSleep().sleep, TIMING);
    let aSettled = false;

    // Act
    const a = service.answer('a', choice(BASH, 1)).then(result => {
      aSettled = true;
      return result;
    });
    const b = await service.answer('b', choice(BASH, 2));

    // Assert
    should(b.cleared).be.true();
    should(aSettled).be.false();
    should(writes).eql(['b:2']);
    release();
    should((await a).cleared).be.true();
    should(writes).eql(['b:2', 'a:1']);
  });
});
