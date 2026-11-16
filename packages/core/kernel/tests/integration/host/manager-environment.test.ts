/** XX systemctl / systemd-run children reach the user manager (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS) and nothing else. */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  bunSpawn,
  childEnvironment,
  childEnvironments,
  MANAGER_ENVIRONMENT_NAMES,
  managerEnvironment,
  toolEnvironment,
} from '../../../host/adapters/process.ts';

const FULL: Record<string, string> = {
  PATH: '/usr/bin',
  HOME: '/home/fy',
  XDG_RUNTIME_DIR: '/run/user/1000',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  XDG_CONFIG_HOME: '/home/fy/.config',
  SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
  HTTPS_PROXY: 'http://user:pass@proxy:3128',
  GH_TOKEN: 'ghp_must_not_pass',
  FY_TOKEN: 'admin',
  ANTHROPIC_API_KEY: 'sk-ant-must-not-pass',
};

describe('XX the user-manager environment', () => {
  test('the list is exactly the two names a user manager is found by', () => {
    expect([...MANAGER_ENVIRONMENT_NAMES].sort()).toEqual(['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']);
  });

  test('managerEnvironment copies only those names, only when set and non-empty', () => {
    expect(managerEnvironment(FULL)).toEqual({
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    });
    expect(managerEnvironment({ XDG_RUNTIME_DIR: '', GH_TOKEN: 'x' })).toEqual({});
    expect(childEnvironments(FULL).managerEnv).toEqual(managerEnvironment(FULL));
  });

  test('systemctl and systemd-run (by name or path) get it; git/gh keep the tool env; the rest get only the base', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/fy' };
    const tools = toolEnvironment(FULL);
    const managers = managerEnvironment(FULL);
    for (const program of ['systemctl', '/usr/bin/systemctl', 'systemd-run', '/run/current-system/sw/bin/systemd-run'])
      expect(childEnvironment(program, base, tools, {}, managers)).toEqual({ ...base, ...managers });
    expect(childEnvironment('git', base, tools, {}, managers)).toEqual({ ...base, ...tools });
    for (const other of ['ssh', 'sh', 'ps', 'systemctl-evil', '/opt/systemd-run-x/run'])
      expect(childEnvironment(other, base, tools, {}, managers)).toEqual(base);
  });

  test("the caller's own env wins over the manager environment", () => {
    const managers = managerEnvironment(FULL);
    expect(
      childEnvironment('systemctl', { PATH: '/p' }, {}, { XDG_RUNTIME_DIR: '/mine' }, managers).XDG_RUNTIME_DIR,
    ).toBe('/mine');
  });
});

describe('XX a fake systemctl child sees the manager names and no secret', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  test('fakes only: never the real systemctl', async () => {
    const dir = await mkdtemp(`${tmpdir()}/manager-env-`);
    roots.push(dir);
    for (const name of ['systemctl', 'systemd-run', 'other']) {
      await writeFile(`${dir}/${name}`, '#!/bin/sh\nenv\n');
      await chmod(`${dir}/${name}`, 0o755);
    }
    const spawn = bunSpawn(
      { PATH: `${dir}:/usr/bin:/bin` },
      undefined,
      toolEnvironment(FULL),
      {},
      managerEnvironment(FULL),
    );
    for (const program of ['systemctl', 'systemd-run']) {
      const out = (await spawn.run(program, [])).stdout;
      expect(out).toContain('XDG_RUNTIME_DIR=/run/user/1000');
      expect(out).toContain('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus');
      for (const leaked of [
        'SSH_AUTH_SOCK',
        'HTTPS_PROXY',
        'GH_TOKEN',
        'FY_TOKEN',
        'ANTHROPIC_API_KEY',
        'XDG_CONFIG_HOME',
      ])
        expect(out).not.toContain(leaked);
    }
    const other = (await spawn.run('other', [])).stdout;
    expect(other).not.toContain('XDG_RUNTIME_DIR');
  });
});
