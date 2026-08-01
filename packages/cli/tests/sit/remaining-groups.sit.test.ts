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

describe(`remaining command groups (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('mounts every group on the program', async () => {
    // Act
    const actual = await cli(['--help']);

    // Assert — the composition root actually constructs each group, not just its tests
    should(actual.code).equal(0);
    for (const group of ['learning', 'stt', 'worktree', 'fleet', 'fs', 'migrate', 'gc', 'signal']) {
      should(actual.out).containEql(group);
    }
  });

  it('uses the injected session environment instead of an ambient live session', async () => {
    // Act
    const actual = await cli(['signal', 'done']);

    // Assert — OFFLINE supplies a blank FY_SESSION_ID, so no daemon client is reached.
    should(actual.code).not.equal(0);
    should(actual.err).containEql('FY_SESSION_ID is unset');
  });

  it('lists the learning verbs in its help', async () => {
    // Act
    const actual = await cli(['learning', '--help']);

    // Assert
    should(actual.code).equal(0);
    for (const verb of ['ls', 'show', 'accept', 'reject', 'edit', 'patch', 'run', 'status', 'config']) {
      should(actual.out).containEql(verb);
    }
  });

  it('refuses a learning state the protocol does not define, without reaching the daemon', async () => {
    // Act
    const actual = await cli(['learning', 'ls', '--state', 'pendign']);

    // Assert
    should(actual.code).not.equal(0);
    should(actual.err).containEql('--state must be one of pending, accepted, rejected');
  });

  it('refuses --all together with --state', async () => {
    // Act
    const actual = await cli(['learning', 'ls', '--all', '--state', 'accepted']);

    // Assert
    should(actual.code).not.equal(0);
    should(actual.err).containEql('contradict each other');
  });

  it('lists the dictation verbs in its help', async () => {
    // Act
    const actual = await cli(['stt', '--help']);

    // Assert
    should(actual.code).equal(0);
    for (const verb of ['status', 'models', 'install', 'transcribe', 'enhance']) {
      should(actual.out).containEql(verb);
    }
  });

  it('refuses audio it cannot decode before reading or uploading it', async () => {
    // Act
    const actual = await cli(['stt', 'transcribe', '/nonexistent/clip.mp3']);

    // Assert
    should(actual.code).not.equal(0);
    should(actual.err).containEql('cannot tell how');
  });

  it('refuses an empty enhancement rather than paying a provider for nothing', async () => {
    // Act
    const actual = await cli(['stt', 'enhance', '   ']);

    // Assert
    should(actual.code).not.equal(0);
    should(actual.err).containEql('needs the text to clean up');
  });

  it('offers no blanket force on a worktree removal', async () => {
    // Act
    const actual = await cli(['worktree', 'rm', '/managed/anything', '--force']);

    // Assert — every class of loss is opt-in by name
    should(actual.code).not.equal(0);
    should(actual.err).containEql('--force');
  });

  it('documents each removal consent flag in its help', async () => {
    // Act
    const actual = await cli(['worktree', '--help']);

    // Assert
    should(actual.code).equal(0);
    for (const flag of ['--discard-changes', '--accept-unpushed', '--delete-unmerged']) {
      should(actual.out).containEql(flag);
    }
  });

  it('lists the fleet verbs in its help', async () => {
    // Act
    const actual = await cli(['fleet', '--help']);

    // Assert
    should(actual.code).equal(0);
    for (const verb of ['ls', 'apply', 'usage', 'recommend']) should(actual.out).containEql(verb);
  });

  it('refuses a recommendation with no task described', async () => {
    // Act
    const actual = await cli(['fleet', 'recommend', '   ']);

    // Assert
    should(actual.code).not.equal(0);
    should(actual.err).containEql('describe the task');
  });
});
