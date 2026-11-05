import { describe, it } from 'bun:test';
import should from 'should';
import { VoiceController } from '../../../src/lib/voice/controller';
import { CapturingOutput, entry, FakeGateway, InstantClock, progress, view } from './fixtures';

function build() {
  const gateway = new FakeGateway();
  const out = new CapturingOutput();
  const clock = new InstantClock();
  return { gateway, out, clock, controller: new VoiceController(gateway, out, clock, 'fy') };
}

describe('fy voice install', () => {
  it('should follow the download to the end and say what to do next', async () => {
    // Arrange
    const { gateway, out, clock, controller } = build();
    gateway.started = view({ install: progress({ bytesDone: 0 }) });
    gateway.statuses = [
      view({ install: progress({ bytesDone: 30_000_000 }) }),
      view({ install: progress({ bytesDone: 100_000_000, phase: 'verifying' }) }),
      view({ install: progress({ status: 'succeeded', phase: 'finishing', bytesDone: 100_000_000 }) }),
    ];

    // Act
    await controller.install('parakeet', {});

    // Assert
    should(gateway.calls).deepEqual(['install:parakeet', 'status', 'status', 'status']);
    should(clock.slept).deepEqual([1000, 1000, 1000]);
    should(out.reports[0]).match(/Installing parakeet/u);
    should(out.reports.some(line => line.includes('Downloading parakeet: 30 MB of 100 MB (30%)'))).be.true();
    should(out.reports.some(line => line.includes('Verifying parakeet'))).be.true();
    should(out.successes).deepEqual(['parakeet is installed. Use it with: fy voice use parakeet']);
    should(out.exitCode).equal(0);
  });

  it('should not print a line for every poll while a download creeps forward', async () => {
    // Arrange
    const { gateway, out, controller } = build();
    gateway.started = view({ install: progress({ bytesDone: 0 }) });
    gateway.statuses = [
      ...[1, 2, 3, 4].map(percent => view({ install: progress({ bytesDone: percent * 1_000_000 }) })),
      view({ install: progress({ status: 'succeeded', phase: 'finishing', bytesDone: 100_000_000 }) }),
    ];

    // Act
    await controller.install('parakeet', {});

    // Assert
    should(out.reports.filter(line => line.startsWith('Downloading')).length).equal(1);
  });

  it('should set a failing exit code and show the daemon’s sentence when the install fails', async () => {
    // Arrange
    const { gateway, out, controller } = build();
    gateway.started = view({
      install: progress({
        status: 'failed',
        message: 'the download does not match its pinned SHA-256; it was deleted — try again',
      }),
    });

    // Act
    await controller.install('parakeet', {});

    // Assert
    should(out.exitCode).equal(1);
    should(out.warnings).deepEqual(['the download does not match its pinned SHA-256; it was deleted — try again']);
    should(out.successes).deepEqual([]);
  });

  it('should treat a cancelled install as not done', async () => {
    // Arrange
    const { gateway, out, controller } = build();
    gateway.started = view({ install: progress() });
    gateway.statuses = [
      view({
        install: progress({ status: 'cancelled', message: 'the install was cancelled; what was downloaded is kept' }),
      }),
    ];

    // Act
    await controller.install('parakeet', {});

    // Assert
    should(out.exitCode).equal(1);
    should(out.warnings[0]).match(/cancelled/u);
  });

  it('should print only the final payload with --json', async () => {
    // Arrange
    const { gateway, out, controller } = build();
    gateway.started = view({ install: progress() });
    gateway.statuses = [
      view({ install: progress({ status: 'succeeded', phase: 'finishing', bytesDone: 100_000_000 }) }),
    ];

    // Act
    await controller.install('parakeet', { json: true });

    // Assert
    should(out.reports.length).equal(1);
    should(JSON.parse(out.reports[0] ?? '{}').install.status).equal('succeeded');
    should(out.successes).deepEqual([]);
  });
});

describe('fy voice status, cancel, remove and use', () => {
  it('should show the runtime, the active models, each row and the install under way', async () => {
    // Arrange
    const { gateway, out, controller } = build();
    gateway.statuses = [
      view({
        active: { batch: 'parakeet', streaming: null },
        freeBytes: 50_000_000_000,
        models: [
          entry({
            id: 'parakeet',
            recommended: true,
            active: true,
            install: { state: 'installed', installedAt: '2026-11-05T12:00:00.000Z', bytes: 671_239_000 },
          }),
          entry({
            id: 'whisper-large-v3',
            weight: 'heavy',
            install: { state: 'not-installed', partialBytes: 250_000_000 },
          }),
          entry({ id: 'nemotron', role: 'streaming', recommended: true }),
        ],
        warnings: ['voice.yaml names the batch model "typo", which is not in the catalog'],
        install: progress({ modelId: 'whisper-large-v3', bytesDone: 50_000_000 }),
      }),
    ];

    // Act
    await controller.status({});
    const text = out.reports.join('\n');

    // Assert
    should(text).match(
      /Runtime: sherpa-onnx 2.0.1 for linux-x64 — not installed — it is fetched with the first model/u,
    );
    should(text).match(/Active: batch parakeet, streaming none/u);
    should(text).match(/Free disk: 50\.0 GB/u);
    should(text).match(/parakeet {2}\[active, recommended\]/u);
    should(text).match(/487\.2 MB download|487 MB download/u);
    should(text).match(/1\.5 GB memory \(estimate\) — installed/u);
    should(text).match(/whisper-large-v3 {2}\[heavy\]/u);
    should(text).match(/part downloaded \(250 MB\)/u);
    should(text).match(/Install: Downloading whisper-large-v3: 50 MB of 100 MB \(50%\)/u);
    should(text).match(/Warning: voice.yaml names the batch model "typo"/u);
    should(text.indexOf('Batch models')).be.lessThan(text.indexOf('Streaming models'));
  });

  it('should say plainly when this machine has no runtime', async () => {
    // Arrange
    const { gateway, out, controller } = build();
    gateway.statuses = [
      view({ target: null, unsupported: 'the speech engine has no prebuilt runtime for win32 on x64' }),
    ];

    // Act
    await controller.status({});

    // Assert
    should(out.reports[0]).match(/^Speech engine: the speech engine has no prebuilt runtime for win32 on x64/u);
  });

  it('should show a runtime supplied by voice.yaml as the owner’s own', async () => {
    // Arrange
    const { gateway, out, controller } = build();
    gateway.statuses = [
      view({
        runtime: {
          source: 'override',
          wrapperVersion: '2.0.1',
          install: { state: 'installed', bytes: 1_000_000 },
          path: '/opt/sherpa',
        },
      }),
    ];

    // Act
    await controller.status({});

    // Assert
    should(out.reports[0]).match(/Runtime: your runtime at \/opt\/sherpa — installed/u);
  });

  it('should print the protocol payload with --json', async () => {
    // Arrange
    const { out, controller } = build();

    // Act
    await controller.status({ json: true });

    // Assert
    should(JSON.parse(out.reports[0] ?? '{}').target).equal('linux-x64');
  });

  it('should cancel, remove and use through the gateway and say so', async () => {
    // Arrange
    const { gateway, out, controller } = build();
    gateway.statuses = [
      view({
        install: progress({ status: 'cancelled', message: 'the install was cancelled; what was downloaded is kept' }),
      }),
    ];

    // Act
    await controller.cancel({});
    await controller.remove('parakeet', {});
    await controller.use('nemotron', {});

    // Assert
    should(gateway.calls).deepEqual(['cancel', 'remove:parakeet', 'use:nemotron']);
    should(out.successes).deepEqual([
      'the install was cancelled; what was downloaded is kept',
      'parakeet is removed (its files and any part-downloaded archive).',
      'nemotron is now the active streaming model.',
    ]);
  });

  it('should say nothing was installing when a cancel finds nothing to stop', async () => {
    // Arrange
    const { out, controller } = build();

    // Act
    await controller.cancel({});

    // Assert
    should(out.successes).deepEqual(['Nothing was installing.']);
  });
});
