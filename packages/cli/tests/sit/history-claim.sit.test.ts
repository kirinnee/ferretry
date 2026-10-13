import { afterEach, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { HISTORY_CLAIM_HELD_EXIT_CODE } from '@ferretry/fleet';
import pkg from '../../package.json' with { type: 'json' };
import { BinaryCliDriver, type CliDriver, InProcessCliDriver } from './driver';

const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
const binaryPath = process.env.CLI_BIN ?? `dist/bin/${binaryName}-${os}-${arch}`;
const useInProcess =
  process.env.SIT_DRIVER === 'inprocess' ||
  (process.env.SIT_DRIVER === undefined && !(await Bun.file(binaryPath).exists()));

const CONVERSATION = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const temporaryDirectories: string[] = [];
const writers: ReturnType<typeof Bun.spawn>[] = [];
let driver: CliDriver;

beforeAll(() => {
  driver = useInProcess ? new InProcessCliDriver() : new BinaryCliDriver(binaryPath);
});

afterEach(async () => {
  for (const writer of writers.splice(0)) writer.kill('SIGKILL');
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function stateHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-history-claim-sit-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A long-lived stand-in for a harness that is writing a conversation. */
function writer(): number {
  const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
  writers.push(child);
  return child.pid;
}

function claimArgs(pid: number): string[] {
  return [
    'history',
    'claim',
    '--harness',
    'claude',
    '--pid',
    String(pid),
    '--from-arguments',
    '--',
    '--resume',
    CONVERSATION,
  ];
}

describe(`history claim (SIT, ${useInProcess ? 'in-process' : 'compiled binary'})`, () => {
  it('should let one writer hold a conversation, refuse a second naming it, and hand over once it exits', async () => {
    // Arrange
    const home = await stateHome();
    const environment = { FY_HOME: home, FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '', FY_RUNTIME: '' };
    const first = writer();
    const second = writer();

    // Act
    const claimed = await driver.run(claimArgs(first), environment);
    const refused = await driver.run(claimArgs(second), environment);
    writers[0]?.kill('SIGKILL');
    await writers[0]?.exited;
    const handedOver = await driver.run(claimArgs(second), environment);

    // Assert
    should(claimed).match({ code: 0, out: '', err: '' });
    should(refused.code).equal(HISTORY_CLAIM_HELD_EXIT_CODE);
    should(refused.err).match(
      new RegExp(
        `conversation ${CONVERSATION} is being written by another claude running as process ${first} since`,
        'u',
      ),
    );
    should(handedOver).match({ code: 0, err: '' });
    const lease = JSON.parse(
      await readFile(path.join(home, 'fleet', 'shared', 'claude', '.leases', CONVERSATION), 'utf8'),
    ) as { holder: { pid: number } };
    should(lease.holder.pid).equal(second);
  });

  it('should name the daemon session and runtime that hold a conversation', async () => {
    // Arrange
    const home = await stateHome();
    const base = { FY_HOME: home, FY_TOKEN: '', FY_URL: '' };
    await driver.run(claimArgs(writer()), { ...base, FY_SESSION_ID: 'ms8-holder01', FY_RUNTIME: 'claude-review' });

    // Act
    const refused = await driver.run(claimArgs(writer()), { ...base, FY_SESSION_ID: '', FY_RUNTIME: '' });

    // Assert
    should(refused.code).equal(HISTORY_CLAIM_HELD_EXIT_CODE);
    should(refused.err).match(
      /being written by session ms8-holder01 on claude-review since .*stop or resume session ms8-holder01/u,
    );
  });

  it('should claim nothing for a launch that names no conversation', async () => {
    // Arrange
    const home = await stateHome();
    const environment = { FY_HOME: home, FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '', FY_RUNTIME: '' };

    // Act
    const result = await driver.run(
      ['history', 'claim', '--harness', 'claude', '--pid', String(writer()), '--from-arguments', '--', '--continue'],
      environment,
    );

    // Assert
    should(result).match({ code: 0, out: '', err: '' });
    should(await Bun.file(path.join(home, 'fleet', 'shared')).exists()).be.false();
  });

  it('should say in its own help what the held exit status means', async () => {
    // Act
    const help = await driver.run(['history', 'claim', '--help'], { FY_TOKEN: '', FY_URL: '', FY_SESSION_ID: '' });

    // Assert
    should(help.code).equal(0, help.err);
    should(help.out).containEql(
      `Exit status ${HISTORY_CLAIM_HELD_EXIT_CODE}: another session is writing this conversation`,
    );
  });
});
