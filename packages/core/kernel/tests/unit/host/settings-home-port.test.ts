import { describe, expect, test } from 'bun:test';
import { renderSettings, resolveSettings } from '../../../host/settings.ts';
import type { HomePort } from '../../../contract/home-port.ts';

const configured: HomePort = { kind: 'port', port: 7603 };
const port = (outcome: ReturnType<typeof resolveSettings>) =>
  outcome.kind === 'settings' ? outcome.settings.port : outcome;

describe('the daemon port: --port, then FY_PORT, then the home’s own, then 7457', () => {
  test('the home’s configured port beats the default and says where it came from', () => {
    expect(port(resolveSettings({}, {}, '/u', configured))).toEqual({
      value: 7603,
      origin: 'home config',
      source: 'config/connections.yaml direct.port',
    });
  });

  test('FY_PORT beats the home’s port', () => {
    expect(port(resolveSettings({ FY_PORT: '8000' }, {}, '/u', configured))).toEqual({
      value: 8000,
      origin: 'environment',
      source: 'FY_PORT',
    });
  });

  test('--port beats FY_PORT and the home’s port', () => {
    expect(port(resolveSettings({ FY_PORT: '8000' }, { port: 9 }, '/u', configured))).toEqual({
      value: 9,
      origin: 'flag',
      source: '--port',
    });
  });

  test('a home with no port, or no reading at all, keeps the 7457 default', () => {
    expect(port(resolveSettings({}, {}, '/u', { kind: 'none' }))).toEqual({ value: 7457, origin: 'default' });
    expect(port(resolveSettings({}, {}, '/u'))).toEqual({ value: 7457, origin: 'default' });
  });

  test('a malformed configured port is refused with its sentence, never clamped', () => {
    const sentence = 'config/connections.yaml direct.port "abc" is not a port number.';
    expect(resolveSettings({}, {}, '/u', { kind: 'refused', sentence })).toEqual({ kind: 'refused', sentence });
  });

  test('a flag or FY_PORT still starts a daemon whose home port is malformed (it is not consulted)', () => {
    const broken: HomePort = { kind: 'refused', sentence: 'x' };
    expect(port(resolveSettings({}, { port: 9 }, '/u', broken))).toMatchObject({ value: 9, origin: 'flag' });
    expect(port(resolveSettings({ FY_PORT: '8' }, {}, '/u', broken))).toMatchObject({ value: 8 });
  });

  test('--print-config renders the home config origin', () => {
    const outcome = resolveSettings({}, {}, '/u', configured);
    const rows = outcome.kind === 'settings' ? renderSettings(outcome.settings) : [];
    expect(rows.find(row => row.startsWith('port'))).toMatch(
      /7603\s+home config \(config\/connections\.yaml direct\.port\)/,
    );
  });
});
