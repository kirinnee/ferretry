import { describe, it } from 'bun:test';
import should from 'should';
import { PACK_REFUSED_EXIT_CODE, PackController } from '../../../src/lib/pack/controller.ts';
import type { IPackGateway } from '../../../src/lib/pack/gateway.ts';
import { RecordingProgress } from '../progress/fixtures.ts';
import { CapturingPackIo, FakePackGateway, packView, recommendation, refused, started } from './fixtures.ts';

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
  it('should print the guide for a person, and the guide alone as JSON', async () => {
    // Arrange
    const { controller, out } = build();

    // Act
    await controller.showGuide({});
    await controller.showGuide({ json: true });

    // Assert
    should(out.out[0]).startWith('Models guide: your models guide');
    should(out.out[0]).containEql('Plan and review on Opus');
    should(JSON.parse(out.out[1] ?? '')).eql(JSON.parse(JSON.stringify(packView().guide)));
  });
});

describe('PackController.recommend', () => {
  it('should send the joined task and print the recommendation for a person', async () => {
    // Arrange
    const { controller, gateway, out } = build();

    // Act
    await controller.recommend(['rename', '  a\n', 'helper'], {});

    // Assert
    should(gateway.recommendCalls).eql([{ task: 'rename a helper' }]);
    should(out.out).have.length(1);
    should(out.out[0]).startWith('Use case: Bulk edits');
  });

  it('should send a named use case and print the payload as JSON', async () => {
    // Arrange
    const { controller, gateway, out } = build();

    // Act
    await controller.recommend(['x'], { json: true, useCase: 'bulk' });

    // Assert
    should(gateway.recommendCalls).eql([{ task: 'x', useCase: 'bulk' }]);
    should(JSON.parse(out.out[0] ?? '')).eql(JSON.parse(JSON.stringify(recommendation())));
  });

  it('should refuse an empty task, naming the shipped command', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    const failure = await controller.recommend([' ', ''], {}).catch((error: unknown) => error);

    // Assert
    should(failure)
      .be.instanceof(Error)
      .and.have.property('message', 'describe the part: foo recommend "<what needs doing>"');
    should(gateway.recommendCalls).be.empty();
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
      useCase: 'bulk',
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
        useCase: 'bulk',
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
