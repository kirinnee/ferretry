import { describe, it } from 'bun:test';
import should from 'should';
import { GUIDE_POLL, PackController } from '../../../cli/lib/controller.ts';
import type { IPackGateway } from '../../../cli/lib/gateway.ts';
import { CapturingPackIo, FakePackGateway, JOB, option, packView, recommendation, SUGGESTION, at } from './fixtures.ts';

function build(options: { gateway?: IPackGateway; files?: Record<string, string> } = {}) {
  const gateway = (options.gateway ?? new FakePackGateway()) as FakePackGateway;
  const out = new CapturingPackIo();
  const controller = new PackController({
    gateway,
    out,
    readFile: async path => options.files?.[path] ?? '',
    binaryName: 'foo',
  });
  return { controller, gateway, out };
}

describe('PackController.showGuide', () => {
  it('should print the routing prompt for a person, and the prompt with its undo as JSON', async () => {
    // Arrange
    const undo = { savedAt: at('2026-10-22T10:00:00.000Z'), source: 'file' as const };
    const plain = build();
    const undoable = build({ gateway: new FakePackGateway(recommendation(), packView({ undo })) });

    // Act
    await plain.controller.showGuide({});
    await plain.controller.showGuide({ json: true });
    await undoable.controller.showGuide({});
    await undoable.controller.showGuide({ json: true });

    // Assert
    should(plain.out.out[0]).startWith('Routing prompt (your routing prompt):');
    should(plain.out.out[0]).containEql('Plan and review on claude-opus-5-5');
    should(JSON.parse(plain.out.out[1] ?? '')).eql({ routing: { text: packView().routing.text, source: 'file' } });
    should(undoable.out.out[0]).endWith('foo guide undo puts it back.');
    should(JSON.parse(undoable.out.out[1] ?? '')).have.property('undo', undo);
  });
});

describe('PackController.recommend', () => {
  it('should send the joined task and print the prompt, the live list and the first to start', async () => {
    // Arrange
    const { controller, gateway, out } = build();

    // Act
    await controller.recommend(['rename', '  a\n', 'helper'], {});

    // Assert
    should(gateway.recommendCalls).eql([{ task: 'rename a helper' }]);
    should(out.out).have.length(1);
    should(out.out[0]).startWith('Routing prompt (your routing prompt):');
    should(out.out[0]).containEql('Models usable here now (1):');
    should(out.out[0]).endWith(`Start the first: ${recommendation().next ?? ''}`);
  });

  it('should ask with no task when none is given, since the task is optional', async () => {
    // Arrange
    const { controller, gateway, out } = build();

    // Act
    await controller.recommend([], {});
    await controller.recommend([' ', ''], {});

    // Assert
    should(gateway.recommendCalls).eql([{}, {}]);
    should(out.err).be.empty();
    should(out.out).have.length(2);
  });

  it('should print the payload as JSON', async () => {
    // Arrange
    const { controller, out } = build({
      gateway: new FakePackGateway(recommendation({ available: [option({ named: undefined })] })),
    });

    // Act
    await controller.recommend(['x'], { json: true });

    // Assert
    should(JSON.parse(out.out[0] ?? '')).eql(
      JSON.parse(JSON.stringify(recommendation({ available: [option({ named: undefined })] }))),
    );
  });
});

describe('PackController guide clean-up', () => {
  function generator(
    setup: (gateway: FakePackGateway) => void = () => undefined,
    options: { terminal?: boolean; files?: Record<string, string> } = {},
  ) {
    const gateway = new FakePackGateway();
    setup(gateway);
    const out = new CapturingPackIo(options.terminal === true);
    const sleeps: number[] = [];
    const controller = new PackController({
      gateway,
      out,
      readFile: async path => options.files?.[path] ?? '',
      binaryName: 'foo',
      sleep: async ms => void sleeps.push(ms),
    });
    return { controller, gateway, out, sleeps };
  }

  it('should print the inventory for a person, or as JSON', async () => {
    // Arrange
    const { controller, out } = generator();

    // Act
    await controller.showInventory({});
    await controller.showInventory({ json: true });

    // Assert
    should(out.out[0]).startWith('Runtimes (2):');
    should(JSON.parse(out.out[1] ?? '').models).have.length(3);
  });

  it('should start with the options given, wait on the run, then print the diff, the notes and how to accept', async () => {
    // Arrange
    const { controller, gateway, out, sleeps } = generator(fake => {
      fake.runs = [{ job: JOB }, { job: JOB }, { job: { ...JOB, status: 'suggested' }, suggestion: SUGGESTION }];
    });

    // Act
    await controller.cleanUp({ runtime: 'claude-work', model: 'opus', prompt: '  Opus for reviews.  ' });

    // Assert
    should(gateway.cleanUpCalls).deepEqual([{ prompt: 'Opus for reviews.', runtime: 'claude-work', model: 'opus' }]);
    should(gateway.jobCalls).deepEqual(['run-1', 'run-1', 'run-1']);
    should(sleeps).deepEqual([GUIDE_POLL.intervalMs, GUIDE_POLL.intervalMs]);
    should(out.out).have.length(1);
    should(out.out[0]).startWith('Cleaned up by claude-opus-5-5 on claude-work');
    should(out.out[0]).containEql('Use [-opus-] {+claude-opus-5-5+} for plans.');
    should(out.out[0]).containEql('  - absent_model: glm-5 is not run by any runtime here');
    should(out.out[0]).endWith('Accept with: foo guide accept run-1');
    should(gateway.acceptCalls).be.empty();
    should(out.exitCode).be.undefined();
  });

  it('should send no prompt when none is given, leaving the daemon to use the one in effect', async () => {
    // Arrange
    const { controller, gateway } = generator();

    // Act
    await controller.cleanUp({});

    // Assert
    should(gateway.cleanUpCalls).deepEqual([{}]);
  });

  it('should read the rough prompt from --prompt-file, and refuse both at once or an empty one', async () => {
    // Arrange
    const { controller, gateway } = generator(() => undefined, {
      files: { 'rough.md': '\n my rough prompt \n', 'blank.md': ' \n' },
    });

    // Act
    await controller.cleanUp({ promptFile: 'rough.md' });
    const both = await controller.cleanUp({ prompt: 'x', promptFile: 'rough.md' }).catch((error: unknown) => error);
    const blank = await controller.cleanUp({ promptFile: 'blank.md' }).catch((error: unknown) => error);
    const typed = await controller.cleanUp({ prompt: '  ' }).catch((error: unknown) => error);

    // Assert
    should(gateway.cleanUpCalls).deepEqual([{ prompt: 'my rough prompt' }]);
    should((both as Error).message).equal('give the rough prompt with --prompt or --prompt-file, not both');
    should((blank as Error).message).startWith('the rough prompt is empty');
    should(typed).be.instanceof(Error);
  });

  it('should tint the diff through report at a terminal, and use success anywhere else', async () => {
    // Arrange
    const tty = generator(() => undefined, { terminal: true });
    const piped = generator();

    // Act
    await tty.controller.cleanUp({});
    await piped.controller.cleanUp({});

    // Assert
    should(tty.out.out).be.empty();
    should(tty.out.reported[0]).containEql('\u001b[31m[-opus-]\u001b[39m');
    should(tty.out.reported[0]).containEql('\u001b[32m{+claude-opus-5-5+}\u001b[39m');
    should(piped.out.out[0]).not.containEql('\u001b');
    should(piped.out.reported).be.empty();
  });

  it('should accept the rewrite at once with --apply, and print the run as JSON with --json', async () => {
    // Arrange
    const { controller, gateway, out } = generator();

    // Act
    await controller.cleanUp({ apply: true, json: true });

    // Assert
    should(JSON.parse(out.out[0] ?? '').suggestion.suggested.by).equal('claude-opus-5-5');
    should(gateway.acceptCalls).deepEqual([{ prompt: SUGGESTION.after, suggested: SUGGESTION.suggested }]);
    should(out.out[1]).equal('Accepted.');
  });

  it('should show the review before accepting with --apply', async () => {
    // Arrange
    const { controller, gateway, out } = generator();

    // Act
    await controller.cleanUp({ apply: true });

    // Assert
    should(out.out[0]).startWith('Cleaned up by');
    should(out.out[1]).equal('Accepted.');
    should(gateway.acceptCalls).have.length(1);
  });

  it('should write from an idea: send the generate mode with the idea trimmed, then print the new prompt plainly', async () => {
    // Arrange
    const { controller, gateway, out } = generator(fake => {
      fake.started = { outcome: 'started', job: { ...JOB, mode: 'generate' } };
      fake.runs = [
        {
          job: { ...JOB, mode: 'generate', status: 'suggested' },
          suggestion: { ...SUGGESTION, before: '', suggested: { ...SUGGESTION.suggested, mode: 'generate' } },
        },
      ];
    });

    // Act
    await controller.write({ idea: '  cheap models for chores  ', runtime: 'claude-work', model: 'opus' });

    // Assert
    should(gateway.cleanUpCalls).deepEqual([
      { mode: 'generate', idea: 'cheap models for chores', runtime: 'claude-work', model: 'opus' },
    ]);
    should(out.out[0]).startWith('Written by claude-opus-5-5 on claude-work');
    should(out.out[0]).containEql(SUGGESTION.after);
    should(out.out[0]).not.containEql('[-');
    should(out.out[0]).endWith('Accept with: foo guide accept run-1');
    should(gateway.acceptCalls).be.empty();
  });

  it('should write from nothing: send only the generate mode, and accept at once with --apply', async () => {
    // Arrange
    const { controller, gateway, out } = generator();

    // Act
    await controller.write({ idea: '   ', apply: true });

    // Assert
    should(gateway.cleanUpCalls).deepEqual([{ mode: 'generate' }]);
    should(gateway.acceptCalls).have.length(1);
    should(out.out.at(-1)).equal('Accepted.');
  });

  it('should name the write, not the clean-up, when it is refused, fails or is still working', async () => {
    // Arrange
    const refused = generator(fake => {
      fake.started = { outcome: 'refused', message: 'No runtime can start a ferret now.' };
    });
    const failed = generator(fake => {
      fake.runs = [{ job: { ...JOB, status: 'failed' } }];
    });
    const slow = generator(fake => {
      fake.runs = [{ job: JOB }];
    });

    // Act
    await refused.controller.write({});
    await failed.controller.write({});
    await slow.controller.write({});

    // Assert
    should(refused.out.err).deepEqual(['foo guide write: No runtime can start a ferret now.']);
    should(refused.out.exitCode).equal(2);
    should(failed.out.err).deepEqual(['foo guide write: the write failed']);
    should(slow.out.err[0]).startWith('foo guide write: it is still working');
  });

  it('should exit 2 when it could not be started, and 1 when it failed or is still working', async () => {
    // Arrange
    const refusedStart = generator(fake => {
      fake.started = { outcome: 'refused', message: 'No runtime can start a ferret now.' };
    });
    const failed = generator(fake => {
      fake.runs = [{ job: { ...JOB, status: 'failed', message: 'It stopped without writing a prompt.' } }];
    });
    const quiet = generator(fake => {
      fake.runs = [{ job: { ...JOB, status: 'failed' } }];
    });
    const slow = generator(fake => {
      fake.runs = [{ job: JOB }];
    });

    // Act
    await refusedStart.controller.cleanUp({ apply: true });
    await failed.controller.cleanUp({ apply: true });
    await quiet.controller.cleanUp({});
    await slow.controller.cleanUp({});

    // Assert
    should([refusedStart.out.exitCode, failed.out.exitCode, quiet.out.exitCode, slow.out.exitCode]).deepEqual([
      2, 1, 1, 1,
    ]);
    should(refusedStart.out.err).deepEqual(['foo guide clean-up: No runtime can start a ferret now.']);
    should(failed.out.err).deepEqual(['foo guide clean-up: It stopped without writing a prompt.']);
    should(quiet.out.err).deepEqual(['foo guide clean-up: the clean-up failed']);
    should(slow.out.err[0]).equal(
      'foo guide clean-up: it is still working; look again with `foo guide accept run-1` once it is done',
    );
    should(slow.sleeps).have.length(GUIDE_POLL.attempts - 1);
    should(refusedStart.gateway.jobCalls).be.empty();
    for (const run of [refusedStart, failed, quiet, slow]) {
      should(run.gateway.acceptCalls).be.empty();
      should(run.out.out).be.empty();
    }
  });

  it('should accept a finished run by id, with the rewrite and who wrote it', async () => {
    // Arrange
    const { controller, gateway, out } = generator();

    // Act
    await controller.accept('run-1');

    // Assert
    should(gateway.jobCalls).deepEqual(['run-1']);
    should(gateway.acceptCalls).deepEqual([{ prompt: SUGGESTION.after, suggested: SUGGESTION.suggested }]);
    should(out.out).deepEqual(['Accepted.']);
  });

  it('should refuse to accept a run with no rewrite, saying what state it is in', async () => {
    // Arrange
    const empty = generator(fake => {
      fake.runs = [{ job: { ...JOB, status: 'failed', message: 'It stopped.' } }];
    });
    const running = generator(fake => {
      fake.runs = [{ job: JOB }];
    });

    // Act
    await empty.controller.accept('run-1');
    await running.controller.accept('run-1');

    // Assert
    should(empty.out.err).deepEqual(['foo guide accept: run run-1 is failed (It stopped.), with no rewrite to accept']);
    should(running.out.err).deepEqual(['foo guide accept: run run-1 is running, with no rewrite to accept']);
    should([empty.out.exitCode, running.out.exitCode]).deepEqual([1, 1]);
    should(empty.gateway.acceptCalls).be.empty();
    should(running.gateway.acceptCalls).be.empty();
  });

  it('should undo, printing what the daemon said', async () => {
    // Arrange
    const { controller, gateway, out } = generator();

    // Act
    await controller.undo();

    // Assert
    should(gateway.undoCalls).equal(1);
    should(out.out).deepEqual(['There is no accepted clean-up to undo.']);
  });
});

describe('PackController guide clean-up with no sleep given', () => {
  it('should look at the run once, never in a loop, and say how to look again while it still works', async () => {
    // Arrange: the terminal gives the verb no sleep (CliContext has none on this base).
    const gateway = new FakePackGateway();
    gateway.runs = [{ job: JOB }, { job: { ...JOB, status: 'suggested' }, suggestion: SUGGESTION }];
    const { controller, out } = build({ gateway });

    // Act
    await controller.cleanUp({});

    // Assert
    should(gateway.jobCalls).have.length(1);
    should(out.err[0]).containEql('it is still working; look again with `foo guide accept run-1`');
    should(out.exitCode).equal(1);
  });

  it('should show a run that was already done at the one look', async () => {
    // Arrange
    const gateway = new FakePackGateway();
    gateway.runs = [{ job: { ...JOB, status: 'suggested' }, suggestion: SUGGESTION }];
    const { controller, out } = build({ gateway });

    // Act
    await controller.cleanUp({});

    // Assert
    should(gateway.jobCalls).have.length(1);
    should(out.out[0]).startWith('Cleaned up by');
  });
});
