import { afterEach, beforeEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  accountName,
  runProgram,
  SystemLoginShell,
  type SystemLoginShellSources,
  systemLoginShell,
} from '../../../src/adapters/index.ts';

let dir = '';
let zsh = '';
let bash = '';

async function script(name: string, mode = 0o755): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, mode);
  return path;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fy-login-shell-'));
  zsh = await script('zsh');
  bash = await script('bash');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Harness {
  readonly subject: SystemLoginShell;
  readonly reported: string[];
  readonly ran: (readonly string[])[];
}

/** Every file is a fixture in the temp directory; nothing here reads the real /etc. */
async function resolver(
  options: {
    readonly passwd?: string;
    readonly shells?: readonly string[];
    readonly platform?: string;
    readonly uid?: number | undefined;
    readonly username?: string;
    readonly environmentShell?: string;
    readonly configured?: string;
    readonly programs?: (argv: readonly string[]) => string | undefined;
  } = {},
): Promise<Harness> {
  const passwdFile = join(dir, 'passwd');
  const shellsFile = join(dir, 'shells');
  if (options.passwd !== undefined) await writeFile(passwdFile, options.passwd);
  if (options.shells !== undefined) await writeFile(shellsFile, options.shells.join('\n'));
  const reported: string[] = [];
  const ran: (readonly string[])[] = [];
  const sources: SystemLoginShellSources = {
    platform: options.platform ?? 'linux',
    uid: 'uid' in options ? options.uid : 1000,
    username: options.username ?? 'kirin',
    environmentShell: options.environmentShell,
    passwdFile,
    shellsFile,
    configured: async () => options.configured,
    run: async argv => {
      ran.push(argv);
      return options.programs?.(argv);
    },
    report: message => reported.push(message),
  };
  return { subject: new SystemLoginShell(sources), reported, ran };
}

const passwdLine = (shell: string): string => `kirin:x:1000:1000::/home/kirin:${shell}\n`;

describe('SystemLoginShell', () => {
  it("should open the account's passwd shell when /etc/shells lists it, and say nothing", async () => {
    // Arrange
    const { subject, reported } = await resolver({ passwd: passwdLine(zsh), shells: [zsh, bash] });

    // Act + Assert
    should(await subject.shell()).equal(zsh);
    should(reported).deepEqual([]);
  });

  it('should prefer what getent answers, which covers accounts the passwd file does not hold', async () => {
    // Arrange
    const { subject, ran } = await resolver({
      passwd: passwdLine(bash),
      shells: [zsh, bash],
      programs: argv => (argv[0] === 'getent' ? passwdLine(zsh) : undefined),
    });

    // Act + Assert
    should(await subject.shell()).equal(zsh);
    should(ran).deepEqual([['getent', 'passwd', '1000']]);
  });

  it('should read the directory service on macOS, where a launchd daemon has no $SHELL', async () => {
    // Arrange
    const { subject, ran } = await resolver({
      platform: 'darwin',
      shells: [zsh],
      programs: () => `UserShell: ${zsh}\n`,
    });

    // Act + Assert
    should(await subject.shell()).equal(zsh);
    should(ran).deepEqual([['/usr/bin/dscl', '.', '-read', '/Users/kirin', 'UserShell']]);
  });

  it('should never put a user name that could leave /Users/ into the directory-service path', async () => {
    // Arrange
    const { subject, ran, reported } = await resolver({
      platform: 'darwin',
      username: '../etc',
      shells: [zsh],
      environmentShell: zsh,
    });

    // Act + Assert
    should(await subject.shell()).equal(zsh);
    should(ran).deepEqual([]);
    should(reported).deepEqual([]);
  });

  it('should fall back to $SHELL when the account has no entry', async () => {
    // Arrange
    const { subject } = await resolver({
      passwd: 'root:x:0:0::/root:/bin/bash\n',
      shells: [zsh],
      environmentShell: zsh,
    });

    // Act + Assert
    should(await subject.shell()).equal(zsh);
  });

  it('should let terminals.shell choose between shells the machine lists', async () => {
    // Arrange
    const { subject } = await resolver({ passwd: passwdLine(zsh), shells: [zsh, bash], configured: bash });

    // Act + Assert
    should(await subject.shell()).equal(bash);
  });

  it('should refuse a terminals.shell that /etc/shells does not list, use the account shell, and say why once', async () => {
    // Arrange — the configured path is a real executable, which is not what makes a shell acceptable.
    const rogue = await script('rogue');
    const { subject, reported } = await resolver({ passwd: passwdLine(zsh), shells: [zsh], configured: rogue });

    // Act
    const first = await subject.shell();
    const second = await subject.shell();

    // Assert
    should(first).equal(zsh);
    should(second).equal(zsh);
    should(reported).have.length(1);
    should(reported[0]).containEql(
      `${rogue} from terminals.shell in config/daemon.json was not used because it is not listed in /etc/shells`,
    );
  });

  it('should fall back to /bin/sh and say why when the listed shell is not executable', async () => {
    // Arrange
    const dead = await script('dead', 0o644);
    const { subject, reported } = await resolver({ passwd: passwdLine(dead), shells: [dead] });

    // Act + Assert
    should(await subject.shell()).equal('/bin/sh');
    should(reported).have.length(1);
    should(reported[0]).containEql('it is not an executable file');
  });

  it('should fall back to /bin/sh when /etc/shells is absent', async () => {
    // Arrange
    const { subject, reported } = await resolver({ passwd: passwdLine(zsh) });

    // Act + Assert
    should(await subject.shell()).equal('/bin/sh');
    should(reported[0]).containEql('/etc/shells could not be read');
  });

  it('should resolve once for every terminal that asks at the same time', async () => {
    // Arrange
    const { subject, ran } = await resolver({ shells: [zsh], programs: () => passwdLine(zsh) });

    // Act
    const answers = await Promise.all([subject.shell(), subject.shell(), subject.shell()]);

    // Assert
    should(answers).deepEqual([zsh, zsh, zsh]);
    should(ran).have.length(1);
  });

  it('should still answer when the configuration cannot be read', async () => {
    // Arrange
    const { subject } = await resolver({ passwd: passwdLine(zsh), shells: [zsh] });
    const failing = new SystemLoginShell({
      platform: 'linux',
      uid: 1000,
      username: 'kirin',
      environmentShell: undefined,
      passwdFile: join(dir, 'passwd'),
      shellsFile: join(dir, 'shells'),
      configured: async () => {
        throw new Error('config unreadable');
      },
      run: async () => undefined,
      report: () => undefined,
    });

    // Act + Assert
    should(await failing.shell()).equal(await subject.shell());
  });
});

describe('accountName', () => {
  it('should answer the name, or nothing when the account has no entry', () => {
    should(accountName(() => 'kirin')).equal('kirin');
    should(
      accountName(() => {
        throw new Error('ENOENT');
      }),
    ).be.undefined();
  });
});

describe('runProgram', () => {
  it('should answer standard output only for a program that exited 0', async () => {
    should(await runProgram(['sh', '-c', 'printf hi'])).equal('hi');
    should(await runProgram(['sh', '-c', 'printf hi; exit 3'])).be.undefined();
  });

  it('should answer nothing for a program that is not there', async () => {
    should(await runProgram([join(dir, 'missing-program')])).be.undefined();
  });
});

describe('systemLoginShell', () => {
  it('should resolve to an absolute shell on this machine without ever rejecting', async () => {
    // Arrange — the real account database; only the shape of the answer is machine-independent.
    const subject = systemLoginShell(async () => undefined, { SHELL: undefined });

    // Act
    const shell = await subject.shell();

    // Assert
    should(shell.startsWith('/')).be.true();
  });
});
