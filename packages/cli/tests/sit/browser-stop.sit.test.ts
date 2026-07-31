import { beforeAll, describe, it } from 'bun:test';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { BinaryCliDriver, type CliDriver, type CliResult, InProcessCliDriver } from './driver';

const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

/**
 * No daemon exists in this tier, and none may be contacted: an empty `FY_TOKEN` makes the client
 * refuse before it opens a socket, so every journey here is decided entirely client-side.
 */
const OFFLINE = { FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' };

let driver: CliDriver;

const cli = (args: string[]): Promise<CliResult> => driver.run(args, OFFLINE);

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
});

describe(`browser and stop (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('lists the browser verbs in its help', async () => {
    // Act
    const actual = await cli(['browser', '--help']);

    // Assert
    should(actual.code).equal(0);
    for (const verb of ['open', 'navigate', 'screenshot', 'resize', 'login']) {
      should(actual.out).containEql(verb);
    }
  });

  it('lists the bulk stop modes in its help', async () => {
    // Act
    const actual = await cli(['stop', '--help']);

    // Assert
    should(actual.code).equal(0);
    for (const mode of ['orphan', 'cascade', 'children', 'label']) {
      should(actual.out).containEql(mode);
    }
  });

  it('rejects a viewport outside the supported range without reaching the daemon', async () => {
    // Act
    const actual = await cli(['browser', 'resize', '10', '10']);

    // Assert
    should(actual.code).not.equal(0);
    should(actual.err).containEql('width must be between');
  });

  it('refuses a browser command with no session to target', async () => {
    // Act
    const actual = await cli(['browser', 'status']);

    // Assert
    should(actual.code).not.equal(0);
    should(actual.err).containEql('--session');
  });

  it('refuses a bulk stop it cannot reach the daemon to plan', async () => {
    // Act
    const actual = await cli(['stop', 'label', 'batch', '--yes']);

    // Assert
    should(actual.code).not.equal(0);
    should(actual.err.trim()).not.be.empty();
  });

  it('rejects a login duration that is not a whole number', async () => {
    // Act
    const actual = await cli(['browser', 'login', 'start', '--minutes', 'soon']);

    // Assert
    should(actual.code).not.equal(0);
    should(actual.err).containEql('--minutes must be a whole number');
  });
});
