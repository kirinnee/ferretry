import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { LogRecord } from '../../../host/log.ts';
import { filterByLevel, resolveSettings } from '../../../host/settings.ts';

const FYD = join(import.meta.dir, '../../../host/fyd.ts');
const record = (level: LogRecord['level']): LogRecord => ({ level, scope: 'kernel', message: level });

test('V-0509 --host replaces the default bind host for one run and says so in --print-config', () => {
  const settings = resolveSettings({}, { host: '0.0.0.0' }, '/u');
  expect(settings.kind === 'settings' && settings.settings.host).toEqual({
    value: '0.0.0.0',
    origin: 'flag',
    source: '--host',
  });
  const child = Bun.spawnSync(['bun', FYD, '--print-config', '--host', '0.0.0.0'], { timeout: 20_000 });
  expect(child.stdout.toString()).toMatch(/host\s+0\.0\.0\.0\s+flag \(--host\)/);
});

test('V-0510 --log-level drops records below it; debug selects the same records as info', () => {
  const seen: string[] = [];
  const warn = filterByLevel(r => void seen.push(r.level), 'warn');
  for (const level of ['debug', 'info', 'warn', 'error'] as const) warn(record(level));
  expect(seen).toEqual(['warn', 'error']);
  const kept: string[] = [];
  const debug = filterByLevel(r => void kept.push(r.level), 'debug');
  for (const level of ['debug', 'info', 'warn', 'error'] as const) debug(record(level));
  expect(kept).toEqual(['debug', 'info', 'warn', 'error']);
  const same: string[] = [];
  const info = filterByLevel(r => void same.push(r.level), 'info');
  for (const level of ['debug', 'info', 'warn', 'error'] as const) info(record(level));
  expect(same).toEqual(['debug', 'info', 'warn', 'error']);
});

test('V-0507 --config is refused 64 with the reason, never ignored', () => {
  const child = Bun.spawnSync(['bun', FYD, '--config', '/nonexistent/daemon.json'], { timeout: 20_000 });
  expect(child.exitCode).toBe(64);
  expect(child.stderr.toString()).toContain('--config is not served');
});
