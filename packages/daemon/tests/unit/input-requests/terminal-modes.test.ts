import { describe, it } from 'bun:test';
import should from 'should';
import {
  parseCanonical,
  parseEcho,
  SttyTerminalModes,
  sttyArguments,
} from '../../../src/lib/input-requests/terminal-modes.ts';

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

describe('reading whether a terminal is in line mode', () => {
  it('should read icanon and -icanon as whole words, and nothing as unknown', () => {
    should(parseCanonical(STTY_ECHO_OFF)).be.true();
    should(parseCanonical('isig -icanon iexten -echo')).be.false();
    should(parseCanonical('isig iexten -echo')).be.undefined();
  });

  it('should run stty for it, and answer unknown when it cannot', async () => {
    should(await new SttyTerminalModes('linux', async () => STTY_ECHO_OFF).canonical('/dev/pts/3')).be.true();
    should(await new SttyTerminalModes('linux', async () => undefined).canonical('/dev/pts/3')).be.undefined();
    should(await new SttyTerminalModes('win32', async () => STTY_ECHO_OFF).canonical('/dev/pts/3')).be.undefined();
  });
});

describe('whether the program reading the prompt is one the ferret could not have placed', () => {
  const modes = (answer: string | undefined) => {
    const asked: (readonly string[])[] = [];
    return {
      asked,
      modes: new SttyTerminalModes('linux', async argv => {
        asked.push(argv);
        return answer;
      }),
    };
  };

  it('should trust a program that runs setuid root: effective uid 0, real uid not', async () => {
    const { modes: setuid, asked } = modes('    0  1000\n');
    should(await setuid.trusted(42)).be.true();
    should(asked).deepEqual([['ps', '-o', 'uid=,ruid=', '-p', '42']]);
  });

  it('should not trust a program the user runs, one root runs outright, or an answer it cannot read', async () => {
    for (const answer of ['1000 1000', '0 0', '', 'root kirin', undefined])
      should(await modes(answer).modes.trusted(42)).be.false();
    should(await modes('0 1000').modes.trusted(0)).be.false();
    const failing = new SttyTerminalModes('linux', async () => await Promise.reject(new Error('no ps')));
    should(await failing.trusted(42)).be.false();
  });
});
