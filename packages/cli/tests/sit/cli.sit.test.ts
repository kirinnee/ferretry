import { beforeAll, describe, it } from 'bun:test';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { BinaryCliDriver, type CliDriver, type CliResult, InProcessCliDriver } from './driver';

// SIT journeys; SIT_DRIVER picks the compiled binary (no coverage) or in-process (coverage).
// Unset, the suite prefers the compiled binary when one exists and falls back to in-process,
// so a bare `bun test` stays green without a compile step. CI pins SIT_DRIVER=binary.
const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

let driver: CliDriver;

async function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return driver.run(args, env);
}

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
});

describe(`cli (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('prints a semver with --version', async () => {
    // Act
    const actual = await cli(['--version']);

    // Assert
    should(actual.code).equal(0);
    should(actual.out.trim()).match(/^\d+\.\d+\.\d+/);
  });

  it('shows a usage banner naming the binary with --help', async () => {
    // Act
    const actual = await cli(['--help']);

    // Assert
    should(actual.code).equal(0);
    should(actual.out).containEql('Usage:');
    should(actual.out).containEql(binaryName);
  });

  it('rejects an unexpected argument with a non-zero exit', async () => {
    // Act
    const actual = await cli(['bogus']);

    // Assert
    should(actual.code).not.equal(0);
    should(actual.err.toLowerCase()).containEql('error');
  });
});
