import { describe, expect, test } from 'bun:test';
import { HOME_PORT_FILE, homePortOf } from '../../../contract/home-port.ts';

const direct = (lines: string): string => `direct:\n  host: 127.0.0.1\n${lines}`;

describe('the port a home configures for its daemon (connections.yaml direct.port)', () => {
  test('names the one file that holds it', () => {
    expect(HOME_PORT_FILE).toBe('config/connections.yaml');
  });

  test('no file, an empty file or no direct block says nothing', () => {
    expect(homePortOf(undefined)).toEqual({ kind: 'none' });
    expect(homePortOf('')).toEqual({ kind: 'none' });
    expect(homePortOf('relay: []\n')).toEqual({ kind: 'none' });
    expect(homePortOf('direct:\n  host: 127.0.0.1\n')).toEqual({ kind: 'none' });
  });

  test('a whole number from 0 to 65535 is the home’s port', () => {
    expect(homePortOf(direct('  port: 7603\n'))).toEqual({ kind: 'port', port: 7603 });
    expect(homePortOf(direct('  port: 0\n'))).toEqual({ kind: 'port', port: 0 });
    expect(homePortOf(direct('  port: 65535\n'))).toEqual({ kind: 'port', port: 65_535 });
  });

  test.each(['"7603"', 'abc', '70000', '-1', '1.5', 'null', '[1]', 'true'])(
    'port %s is refused with a sentence, never clamped',
    written => {
      const outcome = homePortOf(direct(`  port: ${written}\n`));
      expect(outcome.kind).toBe('refused');
      expect(outcome.kind === 'refused' && outcome.sentence).toContain('config/connections.yaml direct.port');
      expect(outcome.kind === 'refused' && outcome.sentence).toContain('is not a port number');
    },
  );

  test('text that is not YAML says nothing: the configuration layer refuses that file itself', () => {
    expect(homePortOf('direct: [unclosed')).toEqual({ kind: 'none' });
  });
});
