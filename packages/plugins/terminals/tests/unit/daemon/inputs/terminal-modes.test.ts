import { describe, it } from 'bun:test';
import should from 'should';
import { SttyTerminalModes } from '../../../../daemon/lib/inputs/terminal-modes.ts';

/** The argv `stty` is run with for a platform and path, or undefined when it is refused before running. */
const argvFor = async (platform: string, path: string): Promise<readonly string[] | undefined> => {
  let seen: readonly string[] | undefined;
  await new SttyTerminalModes(platform, async argv => {
    seen = argv;
    return undefined;
  }).echo(path);
  return seen;
};
const echoOf = (output: string) => new SttyTerminalModes('linux', async () => output).echo('/dev/pts/3');
const canonicalOf = (output: string) => new SttyTerminalModes('linux', async () => output).canonical('/dev/pts/3');

const STTY_ECHO_ON = 'speed 38400 baud; line = 0;\nisig icanon iexten echo echoe echok -echonl\n';
const STTY_ECHO_OFF = 'speed 38400 baud; line = 0;\nisig icanon iexten -echo echoe echok -echonl\n';

describe('reading whether a terminal echoes', () => {
  it('should pass -F on Linux and -f on macOS', async () => {
    should(await argvFor('linux', '/dev/pts/3')).deepEqual(['stty', '-F', '/dev/pts/3', '-a']);
    should(await argvFor('darwin', '/dev/ttys003')).deepEqual(['stty', '-f', '/dev/ttys003', '-a']);
  });

  it('should refuse a platform it does not know and a path that is not a device', async () => {
    should(await argvFor('win32', '/dev/pts/3')).be.undefined();
    should(await argvFor('linux', '/tmp/x')).be.undefined();
    should(await argvFor('linux', '/dev/pts/3 -a')).be.undefined();
  });

  it('should read echo and -echo as whole words only', async () => {
    should(await echoOf(STTY_ECHO_ON)).equal('on');
    should(await echoOf(STTY_ECHO_OFF)).equal('off');
    should(await echoOf('echoe echok')).equal('unknown');
  });

  it('should run stty with argv and answer what it printed', async () => {
    const seen: (readonly string[])[] = [];
    const modes = new SttyTerminalModes('linux', async argv => {
      seen.push(argv);
      return STTY_ECHO_OFF;
    });

    should(await modes.echo('/dev/pts/3')).equal('off');
    should(seen).deepEqual([['stty', '-F', '/dev/pts/3', '-a']]);
  });

  it('should answer unknown when stty fails or the platform or path is unusable', async () => {
    should(await new SttyTerminalModes('linux', async () => undefined).echo('/dev/pts/3')).equal('unknown');
    should(await new SttyTerminalModes('plan9', async () => STTY_ECHO_ON).echo('/dev/pts/3')).equal('unknown');
    should(await new SttyTerminalModes('linux', async () => STTY_ECHO_ON).echo('nope')).equal('unknown');
  });
});

describe('reading whether a terminal is in line mode', () => {
  it('should read icanon and -icanon as whole words, and nothing as unknown', async () => {
    should(await canonicalOf(STTY_ECHO_OFF)).be.true();
    should(await canonicalOf('isig -icanon iexten -echo')).be.false();
    should(await canonicalOf('isig iexten -echo')).be.undefined();
  });

  it('should run stty for it, and answer unknown when it cannot', async () => {
    should(await new SttyTerminalModes('linux', async () => STTY_ECHO_OFF).canonical('/dev/pts/3')).be.true();
    should(await new SttyTerminalModes('linux', async () => undefined).canonical('/dev/pts/3')).be.undefined();
    should(await new SttyTerminalModes('win32', async () => STTY_ECHO_OFF).canonical('/dev/pts/3')).be.undefined();
  });
});
