import { describe, expect, test } from 'bun:test';
import {
  HOME_PORT_FILE,
  HOME_PORT_REFUSAL,
  homePortAccepted,
  homePortAcceptedPath,
  homePortOf,
} from '../../../contract/home-port.ts';

const direct = (lines: string): string => `direct:\n  host: 127.0.0.1\n${lines}`;
const MARKER = 'FAKE_CONFIG_VALUE_DO_NOT_PRINT';

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
    'port %s is refused with the fixed sentence, never clamped',
    written => {
      expect(homePortOf(direct(`  port: ${written}\n`))).toEqual({ kind: 'refused', sentence: HOME_PORT_REFUSAL });
    },
  );

  test.each([
    ['a scalar', `  port: ${MARKER}\n`],
    ['a quoted scalar', `  port: "${MARKER}"\n`],
    ['a list', `  port: [${MARKER}, other]\n`],
    ['a mapping', `  port: {token: ${MARKER}}\n`],
    ['a nested mapping', `  port:\n    api:\n      token: ${MARKER}\n`],
  ])('a malformed port that is %s is refused WITHOUT printing any value from the file', (_name, lines) => {
    const outcome = homePortOf(direct(lines));
    expect(outcome.kind).toBe('refused');
    const sentence = outcome.kind === 'refused' ? outcome.sentence : '';
    expect(sentence).toBe(HOME_PORT_REFUSAL);
    expect(sentence).not.toContain(MARKER);
    expect(sentence).toContain('config/connections.yaml direct.port');
    expect(sentence).toContain('0 to 65535');
  });

  test('text that is not YAML says nothing: the configuration layer refuses that file itself', () => {
    expect(homePortOf('direct: [unclosed')).toEqual({ kind: 'none' });
  });
});

describe('the port the configuration service has accepted (what fy reads while no daemon has recorded one)', () => {
  const record = (text: string): string => JSON.stringify({ format: 1, etag: 'e', text, plugin: 'connections' });

  test('lives where the service keeps the file’s accepted record', () => {
    expect(homePortAcceptedPath('/h')).toBe('/h/state/kernel/accepted-config/connections.yaml.json');
  });

  test('is the port of the accepted TEXT', () => {
    expect(homePortAccepted(record(direct('  port: 43210\n')))).toEqual({ kind: 'port', port: 43_210 });
  });

  test('nothing accepted, an unreadable record or one with no text says nothing', () => {
    expect(homePortAccepted(undefined)).toEqual({ kind: 'none' });
    expect(homePortAccepted('{not json')).toEqual({ kind: 'none' });
    expect(homePortAccepted('{"format":1,"etag":"e"}')).toEqual({ kind: 'none' });
    expect(homePortAccepted(record('direct:\n  host: h\n'))).toEqual({ kind: 'none' });
  });
});
