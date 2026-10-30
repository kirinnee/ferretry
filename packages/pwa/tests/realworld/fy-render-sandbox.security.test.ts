// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { describe, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  fyRenderFixtureTestSeam,
  fyRenderIntegrationFixture,
} from '../integration/support/fy-render-integration-fixture.ts';

const loaderRejection = async (): Promise<unknown> =>
  await fyRenderIntegrationFixture().then(
    () => null,
    (error: unknown) => error,
  );

describe('fy-render fixture loader — the manifest gate', () => {
  test('should reject when the child outlives its bound, even ignoring SIGTERM', async () => {
    // Arrange — a builder that ignores SIGTERM, so only the raced deadline plus SIGKILL can end it.
    const directory = await mkdtemp(join(tmpdir(), 'fy-render-stub-'));
    const stub = join(directory, 'wedged-builder.ts');
    await writeFile(stub, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n", 'utf8');
    const savedMemo = fyRenderFixtureTestSeam.takeMemo();
    fyRenderFixtureTestSeam.useBuilder(stub);
    fyRenderFixtureTestSeam.useTimeout(750);
    try {
      // Act
      const started = Date.now();
      const rejection = await loaderRejection();
      const elapsed = Date.now() - started;

      // Assert
      should(String(rejection)).match(/did not finish within 750ms/u);
      should(elapsed).be.below(30_000);
    } finally {
      fyRenderFixtureTestSeam.useTimeout(null);
      fyRenderFixtureTestSeam.useBuilder(null);
      fyRenderFixtureTestSeam.restoreMemo(savedMemo);
      await rm(directory, { force: true, recursive: true });
    }
  }, 120_000);
});
