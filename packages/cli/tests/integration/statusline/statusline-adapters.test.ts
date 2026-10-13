import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  createStatuslineController,
  readBounded,
  runChainedStatusline,
  STATUSLINE_INPUT_LIMIT,
} from '../../../src/adapters/statusline/index.ts';

const encoder = new TextEncoder();

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const PAYLOAD = JSON.stringify({
  rate_limits: {
    five_hour: { used_percentage: 12, resets_at: 1_790_003_600 },
    seven_day: { used_percentage: 34, resets_at: 1_790_400_000 },
  },
});

describe('statusline adapters', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fy-statusline-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('readBounded', () => {
    it('should read every chunk of a stream', async () => {
      should(await readBounded(streamOf('ab', 'cd', 'ef'))).equal('abcdef');
    });

    it('should keep at most the limit and drain the rest', async () => {
      should(await readBounded(streamOf('abc', 'def', 'ghi'), 4)).equal('abcd');
    });

    it('should default to the declared limit', () => {
      should(STATUSLINE_INPUT_LIMIT).equal(1024 * 1024);
    });
  });

  describe('runChainedStatusline', () => {
    it('should pass the same stdin to the command and return its exit code', async () => {
      // Arrange
      const out = join(directory, 'seen.txt');

      // Act
      const code = await runChainedStatusline(`cat > '${out}'; exit 3`, PAYLOAD);

      // Assert
      should(code).equal(3);
      should(await readFile(out, 'utf8')).equal(PAYLOAD);
    });

    it('should return the code of a command that never reads its input', async () => {
      should(await runChainedStatusline('exit 0', 'x'.repeat(256 * 1024))).equal(0);
    });
  });

  describe('createStatuslineController', () => {
    it('should record usage under the fleet, never under the home .claude, then chain', async () => {
      // Arrange
      const stateHome = join(directory, 'state');
      const home = join(directory, 'home');
      const out = join(directory, 'chained.txt');
      const exitCodes: number[] = [];
      const controller = createStatuslineController({
        environment: { FY_HOME: stateHome, FY_CREDENTIAL: 'claude-you' },
        homeDirectory: home,
        product: 'ferretry',
        io: { setExitCode: code => exitCodes.push(code) },
        stdin: streamOf(PAYLOAD.slice(0, 10), PAYLOAD.slice(10)),
      });

      // Act
      await controller.run({ own: `cat > '${out}'` });

      // Assert
      const usageFile = join(stateHome, 'fleet', 'credentials', 'claude-you', 'usage.json');
      const record = JSON.parse(await readFile(usageFile, 'utf8')) as Record<string, unknown>;
      should(record).match({
        version: 1,
        source: 'claude-statusline',
        fiveHour: { usedPercent: 12, resetAt: 1_790_003_600_000 },
        weekly: { usedPercent: 34, resetAt: 1_790_400_000_000 },
      });
      should((await stat(usageFile)).mode & 0o777).equal(0o600);
      should(await readFile(out, 'utf8')).equal(PAYLOAD);
      should(exitCodes).eql([0]);
      should(await readdir(directory)).not.containEql('home');
    });

    it('should default the state home under the person\'s home when FY_HOME is unset', async () => {
      // Arrange
      const home = join(directory, 'home');
      const controller = createStatuslineController({
        environment: { FY_CREDENTIAL: 'claude-you' },
        homeDirectory: home,
        product: 'ferretry',
        io: { setExitCode: () => undefined },
        stdin: streamOf(PAYLOAD),
      });

      // Act
      await controller.run({});

      // Assert
      const usageFile = join(home, '.ferretry', 'fleet', 'credentials', 'claude-you', 'usage.json');
      should((await stat(usageFile)).isFile()).be.true();
      should(await readdir(home)).eql(['.ferretry']);
    });
  });
});
