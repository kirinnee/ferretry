import { afterEach, describe, it } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { milliseconds } from '@ferretry/std';
import should from 'should';
import { hostFacilities } from '../../../cli/adapters/host.ts';
import type { ShellTime } from '../../../cli/shell.ts';

/** A terminal that records what it was told; `isTty` decides how progress is drawn. */
const terminal = (isTty: boolean) => {
  const err: string[] = [];
  return { io: { out: () => undefined, err: (text: string) => err.push(text), isTty }, err };
};

describe('the access CLI host facilities', () => {
  const realHome = process.env.FY_HOME;
  afterEach(() => {
    if (realHome === undefined) delete process.env.FY_HOME;
    else process.env.FY_HOME = realHome;
  });

  it('should read the clock and sleep through the shell, and say which one a too-old shell lacks', async () => {
    // Arrange
    const slept: number[] = [];
    const time: ShellTime = {
      clock: { nowMs: () => 1_234 },
      sleep: async delay => {
        slept.push(Number(delay));
      },
    };
    const facilities = hostFacilities(terminal(false).io, time);
    const bare = hostFacilities(terminal(false).io, {});

    // Act
    const now = facilities.clock.now();
    await facilities.clock.sleep(250);

    // Assert
    should(now).equal(1_234);
    should(slept).eql([Number(milliseconds(250))]);
    should(() => bare.clock.now()).throw('this fy shell has no clock yet; update fy');
    await should(bare.clock.sleep(1)).be.rejectedWith('this fy shell has no timer yet; update fy');
  });

  it('should ask on the terminal and answer the line typed', async () => {
    // Arrange: the process's own stdin and stdout, stood in for, then put back.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdout.on('data', chunk => written.push(String(chunk)));
    const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
    const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
    let answer: string;
    try {
      // Act
      const asking = hostFacilities(terminal(false).io, {}).prompt.ask('Revoke this device?');
      stdin.write('yes\n');
      answer = await asking;
    } finally {
      if (realIn !== undefined) Object.defineProperty(process, 'stdin', realIn);
      if (realOut !== undefined) Object.defineProperty(process, 'stdout', realOut);
    }

    // Assert
    should(answer).equal('yes');
    should(written.join('')).containEql('? Revoke this device? ');
  });

  it('should draw progress as lines off a terminal and rewrite one line on a terminal', () => {
    // Arrange
    const plain = terminal(false);
    const tty = terminal(true);

    // Act
    for (const { io } of [plain, tty]) {
      const progress = hostFacilities(io, {}).progress;
      progress.start('pairing');
      progress.succeed('paired');
      progress.fail('refused');
    }

    // Assert
    should(plain.err).eql(['- pairing\n', '✔ paired\n', '✖ refused\n']);
    should(tty.err).eql(['\r\u001b[2K- pairing', '\r\u001b[2K✔ paired\n', '\r\u001b[2K✖ refused\n']);
  });

  it('should answer FY_HOME when it is absolute, the product home when it is unset or blank, and refuse a relative one', () => {
    // Arrange
    const facilities = hostFacilities(terminal(false).io, {});

    // Act / Assert: only the path is computed; no home is read.
    process.env.FY_HOME = '  /tmp/fy-access-host-home  ';
    should(facilities.stateHome()).equal('/tmp/fy-access-host-home');
    delete process.env.FY_HOME;
    should(facilities.stateHome()).equal(join(homedir(), '.ferretry'));
    process.env.FY_HOME = '   ';
    should(facilities.stateHome()).equal(join(homedir(), '.ferretry'));
    process.env.FY_HOME = 'relative/home';
    should(() => facilities.stateHome()).throw('FY_HOME must be an absolute path');
  });
});
