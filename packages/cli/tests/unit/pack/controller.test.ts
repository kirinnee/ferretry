import { describe, it } from 'bun:test';
import should from 'should';
import { GUIDE_POLL, PACK_REFUSED_EXIT_CODE, PackController } from '../../../src/lib/pack/controller.ts';
import type { IPackGateway } from '../../../src/lib/pack/gateway.ts';
import { RecordingProgress } from '../progress/fixtures.ts';
import {
  CapturingPackIo,
  FakePackGateway,
  JOB,
  option,
  packView,
  recommendation,
  refused,
  SUGGESTION,
  started,
} from './fixtures.ts';

function build(options: { parent?: string; gateway?: IPackGateway; files?: Record<string, string> } = {}) {
  const gateway = (options.gateway ?? new FakePackGateway()) as FakePackGateway;
  const out = new CapturingPackIo();
  const controller = new PackController({
    gateway,
    out,
    parent: async () => options.parent,
    cwd: '/here',
    absolute: path => (path.startsWith('/') ? path : `/here/${path}`),
    readFile: async path => options.files?.[path] ?? '',
    binaryName: 'foo',
  });
  return { controller, gateway, out };
}

describe('PackController.showGuide', () => {
  it('should print the routing prompt for a person, and the prompt with its undo as JSON', async () => {
    // Arrange
    const undo = { savedAt: '2026-10-22T10:00:00.000Z', source: 'file' as const };
    const plain = build();
    const undoable = build({ gateway: new FakePackGateway(recommendation(), started(), packView({ undo })) });

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

describe('PackController.newChild', () => {
  it('should send no cwd when a parent ferret starts it, and the parent instead', async () => {
    // Arrange
    const { controller, gateway, out } = build({ parent: 'parent-1' });

    // Act
    await controller.newChild(['do', 'it'], { runtime: 'claude-work' });

    // Assert
    should(gateway.newCalls).eql([{ task: 'do it', parent: 'parent-1', runtime: 'claude-work' }]);
    should(out.out[0]).startWith('Started child-1 on claude-work');
    should(out.err).be.empty();
    should(out.exitCode).be.undefined();
  });

  it('should send the working folder when a person starts it, and every option given', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    await controller.newChild(['do it'], {
      runtime: 'claude-work',
      model: 'opus',
      effort: 'high',
      name: 'Do It',
      mode: 'interactive',
    });

    // Assert
    should(gateway.newCalls).eql([
      {
        task: 'do it',
        runtime: 'claude-work',
        model: 'opus',
        effort: 'high',
        cwd: '/here',
        name: 'Do It',
        mode: 'interactive',
      },
    ]);
  });

  it('should title a pointer brief from the file it points at, and never override --name', async () => {
    // Arrange
    const pointer = 'You are an implementer. Read /tmp/brief.md and follow it.';
    const { controller, gateway } = build({ files: { '/tmp/brief.md': '# Port the Sessions Filter' } });

    // Act
    await controller.newChild([pointer], { runtime: 'r' });
    await controller.newChild([pointer], { runtime: 'r', name: 'Mine' });

    // Assert
    should(gateway.newCalls[0]).have.property('name', 'Port the Sessions Filter');
    should(gateway.newCalls[1]).have.property('name', 'Mine');
  });

  it('should make a relative --cwd absolute against where it was run, and pass --allow-scratch on', async () => {
    // Arrange
    const { controller, gateway } = build({ parent: 'parent-1' });

    // Act
    await controller.newChild(['x'], { runtime: 'r', cwd: 'sub/dir', allowScratch: true });

    // Assert
    should(gateway.newCalls).eql([
      { task: 'x', parent: 'parent-1', runtime: 'r', cwd: '/here/sub/dir', allowScratch: true },
    ]);
  });

  it('should send an explicit --cwd whether or not there is a parent', async () => {
    // Arrange
    const person = build();
    const child = build({ parent: 'p' });

    // Act
    await person.controller.newChild(['x'], { runtime: 'r', cwd: '/elsewhere' });
    await child.controller.newChild(['x'], { runtime: 'r', cwd: '/elsewhere' });

    // Assert
    should(person.gateway.newCalls[0]).have.property('cwd', '/elsewhere');
    should(child.gateway.newCalls[0]).have.property('cwd', '/elsewhere');
  });

  it('should let --auto choose, sending no runtime', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    await controller.newChild(['x'], { auto: true });

    // Assert
    should(gateway.newCalls).eql([{ task: 'x', auto: true, cwd: '/here' }]);
  });

  it('should read the brief from --prompt-file and trim it, ignoring typed words', async () => {
    // Arrange
    const { controller, gateway } = build({ files: { 'brief.md': '\n  the long brief\n\n' } });

    // Act
    await controller.newChild(['ignored'], { runtime: 'r', promptFile: 'brief.md' });

    // Assert
    should(gateway.newCalls[0]).have.property('task', 'the long brief');
  });

  it('should refuse an empty brief, naming the shipped command', async () => {
    // Arrange
    const typed = build();
    const filed = build({ files: { 'empty.md': ' \n' } });

    // Act
    const fromWords = await typed.controller.newChild([], { runtime: 'r' }).catch((error: unknown) => error);
    const fromFile = await filed.controller
      .newChild([], { runtime: 'r', promptFile: 'empty.md' })
      .catch((error: unknown) => error);

    // Assert
    for (const failure of [fromWords, fromFile])
      should(failure)
        .be.instanceof(Error)
        .and.have.property('message', 'give the brief: foo new --runtime <runtime> "<complete brief>"');
    should(typed.gateway.newCalls).be.empty();
    should(filed.gateway.newCalls).be.empty();
  });

  it('should reject a request the daemon would refuse before sending it', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    const failure = await controller.newChild(['x'], {}).catch((error: unknown) => error);

    // Assert — neither --runtime nor --auto
    should(failure).be.instanceof(Error);
    should(gateway.newCalls).be.empty();
  });

  it('should write a refusal to stderr with the command name and exit 2', async () => {
    // Arrange
    const { controller, out } = build({ gateway: new FakePackGateway(recommendation(), refused()) });

    // Act
    await controller.newChild(['x'], { runtime: 'r' });

    // Assert
    should(out.out).be.empty();
    should(out.err).eql(['foo new: refused (limit_reached): you have 4 running sub-ferrets']);
    should(out.exitCode).equal(PACK_REFUSED_EXIT_CODE);
    should(PACK_REFUSED_EXIT_CODE).equal(2);
  });

  it('should print the outcome as JSON on stdout, and still exit 2 for a refusal', async () => {
    // Arrange
    const ok = build({ gateway: new FakePackGateway(recommendation(), started()) });
    const no = build({ gateway: new FakePackGateway(recommendation(), refused()) });

    // Act
    await ok.controller.newChild(['x'], { runtime: 'r', json: true });
    await no.controller.newChild(['x'], { runtime: 'r', json: true });

    // Assert
    should(JSON.parse(ok.out.out[0] ?? '')).have.property('outcome', 'started');
    should(ok.out.exitCode).be.undefined();
    should(JSON.parse(no.out.out[0] ?? '')).have.property('outcome', 'refused');
    should(no.out.err).be.empty();
    should(no.out.exitCode).equal(2);
  });
});

describe('PackController progress', () => {
  function watched(progress: RecordingProgress) {
    const gateway = new FakePackGateway();
    const controller = new PackController({
      gateway,
      out: new CapturingPackIo(),
      parent: async () => undefined,
      cwd: '/here',
      absolute: path => path,
      readFile: async () => '',
      binaryName: 'foo',
      progress,
    });
    return { controller, gateway };
  }

  it('should name the runtime being checked while the probe runs', async () => {
    // Arrange
    const progress = new RecordingProgress();

    // Act
    await watched(progress).controller.newChild(['do it'], { runtime: 'claude-work' });

    // Assert
    should(progress.events).deepEqual(['start Checking claude-work', 'succeed']);
  });

  it('should say it is choosing when no runtime was named, and fail the step when the gateway throws', async () => {
    // Arrange
    const progress = new RecordingProgress();
    const { controller, gateway } = watched(progress);
    gateway.newChild = () => Promise.reject(new Error('daemon down'));

    // Act
    await controller.newChild(['do it'], { auto: true }).catch(() => undefined);

    // Assert
    should(progress.events).deepEqual(['start Choosing the best runtime', 'fail']);
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
    const progress = new RecordingProgress();
    const controller = new PackController({
      gateway,
      out,
      parent: async () => undefined,
      cwd: '/here',
      absolute: path => path,
      readFile: async path => options.files?.[path] ?? '',
      binaryName: 'foo',
      progress,
      sleep: async ms => void sleeps.push(ms),
    });
    return { controller, gateway, out, sleeps, progress };
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
    const { controller, gateway, out, sleeps, progress } = generator(fake => {
      fake.runs = [{ job: JOB }, { job: JOB }, { job: { ...JOB, status: 'suggested' }, suggestion: SUGGESTION }];
    });

    // Act
    await controller.cleanUp({ runtime: 'claude-work', model: 'opus', prompt: '  Opus for reviews.  ' });

    // Assert
    should(gateway.cleanUpCalls).deepEqual([{ prompt: 'Opus for reviews.', runtime: 'claude-work', model: 'opus' }]);
    should(gateway.jobCalls).deepEqual(['run-1', 'run-1', 'run-1']);
    should(sleeps).deepEqual([GUIDE_POLL.intervalMs, GUIDE_POLL.intervalMs]);
    should(progress.events).deepEqual([
      'start Checking claude-work',
      'succeed',
      'start gonzalo is cleaning up the routing prompt on claude-work',
      'succeed',
    ]);
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
  it('should look at the run again at once', async () => {
    // Arrange
    const gateway = new FakePackGateway();
    gateway.runs = [{ job: JOB }, { job: { ...JOB, status: 'suggested' }, suggestion: SUGGESTION }];
    const { controller, out } = build({ gateway });

    // Act
    await controller.cleanUp({});

    // Assert
    should(gateway.jobCalls).have.length(2);
    should(out.out[0]).startWith('Cleaned up by');
  });
});
