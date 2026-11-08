import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSettings, resolveSettings } from '../../../host/settings.ts';

const FYD = join(import.meta.dir, '../../../host/fyd.ts');
const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

test('V-0512 --print-config names each effective value and where it came from, and creates nothing', () => {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-print-'));
  parents.push(parent);
  const home = join(parent, 'home');
  const child = Bun.spawnSync(['bun', FYD, '--print-config', '--port', '9123'], {
    env: { ...process.env, FY_HOME: home, FY_PORT: '8000' },
    timeout: 20_000,
  });
  const out = child.stdout.toString();
  expect(child.exitCode).toBe(0);
  expect(out).toMatch(/home\s+\S+home\s+environment \(FY_HOME\)/);
  expect(out).toMatch(/port\s+9123\s+flag \(--port\)/);
  expect(out).toMatch(/host\s+127\.0\.0\.1\s+default/);
  expect(existsSync(home)).toBe(false);
});

test('flag beats environment beats default, and a bad port is refused', () => {
  const env = { FY_PORT: '8000' };
  const first = resolveSettings(env, { port: 9 }, '/u');
  expect(first.kind === 'settings' && first.settings.port).toEqual({ value: 9, origin: 'flag', source: '--port' });
  const second = resolveSettings(env, {}, '/u');
  expect(second.kind === 'settings' && second.settings.port.origin).toBe('environment');
  const third = resolveSettings({}, {}, '/u');
  expect(third.kind === 'settings' && renderSettings(third.settings)[0]).toContain('/u/.ferretry');
  expect(resolveSettings({ FY_PORT: 'abc' }, {}, '/u').kind).toBe('refused');
});
