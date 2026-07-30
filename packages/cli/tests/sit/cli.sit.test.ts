import { beforeAll, describe, it } from 'bun:test';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { BinaryCliDriver, type CliDriver, type CliResult, InProcessCliDriver } from './driver';

// SIT journeys; SIT_DRIVER picks the compiled binary (default, no coverage) or in-process (coverage).
const useInProcess = process.env.SIT_DRIVER === 'inprocess';
const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;

let driver: CliDriver;

async function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return driver.run(args, env);
}

beforeAll(() => {
  if (useInProcess) {
    driver = new InProcessCliDriver();
  } else {
    const os = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
    const bin = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
    driver = new BinaryCliDriver(bin);
  }
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
