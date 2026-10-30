import { describe, it } from 'bun:test';
import should from 'should';
import { parseEcho, SttyTerminalModes, sttyArguments } from '../../../src/lib/input-requests/terminal-modes.ts';

const STTY_ECHO_ON = 'speed 38400 baud; line = 0;\nisig icanon iexten echo echoe echok -echonl\n';
const STTY_ECHO_OFF = 'speed 38400 baud; line = 0;\nisig icanon iexten -echo echoe echok -echonl\n';

describe('reading whether a terminal echoes', () => {
  it('should pass -F on Linux and -f on macOS', () => {
    should(sttyArguments('linux', '/dev/pts/3')).deepEqual(['stty', '-F', '/dev/pts/3', '-a']);
    should(sttyArguments('darwin', '/dev/ttys003')).deepEqual(['stty', '-f', '/dev/ttys003', '-a']);
  });

  it('should refuse a platform it does not know and a path that is not a device', () => {
    should(sttyArguments('win32', '/dev/pts/3')).be.undefined();
    should(sttyArguments('linux', '/tmp/x')).be.undefined();
    should(sttyArguments('linux', '/dev/pts/3 -a')).be.undefined();
  });

  it('should read echo and -echo as whole words only', () => {
    should(parseEcho(STTY_ECHO_ON)).equal('on');
    should(parseEcho(STTY_ECHO_OFF)).equal('off');
    should(parseEcho('echoe echok')).equal('unknown');
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
