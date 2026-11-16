import { afterEach, describe, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { milliseconds } from '@ferretry/std';
import should from 'should';
import {
  ownSessionId,
  paneCredentialMarker,
  recipeReader,
  shellTime,
  TerminalPrompt,
} from '../../../cli/adapters/terminal.ts';

/** The process's own stdin and stdout, stood in for by streams, then put back. */
const withStandInTerminal = async <T>(run: (stdin: PassThrough, written: string[]) => Promise<T>): Promise<T> => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdout.on('data', chunk => written.push(String(chunk)));
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  try {
    return await run(stdin, written);
  } finally {
    if (realIn !== undefined) Object.defineProperty(process, 'stdin', realIn);
    if (realOut !== undefined) Object.defineProperty(process, 'stdout', realOut);
  }
};

const ENVIRONMENT = ['FY_SESSION_ID', 'FY_SESSION_TOKEN', 'FY_SESSION_BOARD_CAPABILITY'] as const;

describe('the accounts CLI terminal facilities', () => {
  const kept = Object.fromEntries(ENVIRONMENT.map(name => [name, process.env[name]]));
  afterEach(() => {
    for (const name of ENVIRONMENT) {
      const value = kept[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('should read a recipe file through the shell, and say so when the shell cannot', async () => {
    // Arrange
    const reader = recipeReader({ readText: async path => `recipe at ${path}` });
    const bare = recipeReader({});

    // Act
    const text = await reader('./work.yaml');

    // Assert
    should(text).equal('recipe at ./work.yaml');
    await should(bare('./work.yaml')).be.rejectedWith(
      'this fy shell cannot read recipe files yet; update fy, or edit the recipe in Settings › Accounts',
    );
  });

  it('should ask on the terminal, showing the question and the answer typed', async () => {
    // Arrange / Act
    const { answer, written } = await withStandInTerminal(async (stdin, out) => {
      const asking = new TerminalPrompt().ask('Account name?');
      stdin.write('work\n');
      return { answer: await asking, written: out.join('') };
    });

    // Assert
    should(answer).equal('work');
    should(written).containEql('Account name?');
  });

  it('should read a hidden answer without echoing it, and end the line itself', async () => {
    // Arrange / Act
    const { answer, written } = await withStandInTerminal(async (stdin, out) => {
      const asking = new TerminalPrompt().askHidden('Seed? ');
      stdin.write('correct horse\n');
      return { answer: await asking, written: out.join('') };
    });

    // Assert
    should(answer).equal('correct horse');
    should(written).not.containEql('correct horse');
    should(written.endsWith('\n')).be.true();
  });

  it('should answer the session this CLI runs inside, and nothing at the owner own shell', () => {
    // Arrange / Act / Assert
    process.env.FY_SESSION_ID = 'ses-1';
    should(ownSessionId()).equal('ses-1');
    delete process.env.FY_SESSION_ID;
    should(ownSessionId()).be.undefined();
  });

  it('should mark a pane that holds a credential without ever returning its value', () => {
    // Arrange
    delete process.env.FY_SESSION_TOKEN;
    delete process.env.FY_SESSION_BOARD_CAPABILITY;

    // Act / Assert
    should(paneCredentialMarker()).be.undefined();
    process.env.FY_SESSION_TOKEN = '   ';
    should(paneCredentialMarker()).be.undefined();
    process.env.FY_SESSION_TOKEN = 'stand-in-value';
    should(paneCredentialMarker()).equal('present');
    delete process.env.FY_SESSION_TOKEN;
    process.env.FY_SESSION_BOARD_CAPABILITY = 'stand-in-value';
    should(paneCredentialMarker()).equal('present');
  });

  it('should read the clock and sleep through the shell, and say which one a too-old shell lacks', async () => {
    // Arrange
    const slept: unknown[] = [];
    const time = shellTime({
      clock: { nowMs: () => 4_321 },
      sleep: async delay => {
        slept.push(delay);
      },
    });
    const bare = shellTime({});

    // Act
    const now = time.nowMs();
    await time.sleep(250);

    // Assert
    should(now).equal(4_321);
    should(slept).eql([milliseconds(250)]);
    should(() => bare.nowMs()).throw('this fy shell has no clock yet; update fy');
    await should(bare.sleep(1)).be.rejectedWith('this fy shell has no timer yet; update fy');
  });
});
