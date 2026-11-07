/** XX the non-secret environment git and gh children get (keyring-backed gh, ssh clones, proxies), and never a token. */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { bunSpawn, childEnvironment, TOOL_ENVIRONMENT_NAMES, toolEnvironment } from '../../../host/adapters/process.ts';

const FULL: Record<string, string> = {
  PATH: '/usr/bin',
  HOME: '/home/fy',
  XDG_CONFIG_HOME: '/home/fy/.config',
  XDG_RUNTIME_DIR: '/run/user/1000',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  GH_CONFIG_DIR: '/home/fy/.config/gh',
  SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
  HTTP_PROXY: 'http://proxy:3128',
  HTTPS_PROXY: 'http://proxy:3128',
  NO_PROXY: 'localhost',
  http_proxy: 'http://proxy:3128',
  https_proxy: 'http://proxy:3128',
  no_proxy: 'localhost',
  GH_TOKEN: 'ghp_must_not_pass',
  GITHUB_TOKEN: 'ghp_must_not_pass',
  FY_TOKEN: 'admin',
  ANTHROPIC_API_KEY: 'sk-ant-must-not-pass',
};

describe('XX child environment allow-list for git and gh', () => {
  test('the list is exactly the non-secret names the brief names, proxies in both cases', () => {
    expect([...TOOL_ENVIRONMENT_NAMES].sort()).toEqual(
      [
        'DBUS_SESSION_BUS_ADDRESS',
        'GH_CONFIG_DIR',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'NO_PROXY',
        'SSH_AUTH_SOCK',
        'XDG_CONFIG_HOME',
        'XDG_RUNTIME_DIR',
        'http_proxy',
        'https_proxy',
        'no_proxy',
      ].sort(),
    );
  });

  test('toolEnvironment copies only the allow-listed names that are set, never a token', () => {
    const picked = toolEnvironment(FULL);
    expect(Object.keys(picked).sort()).toEqual([...TOOL_ENVIRONMENT_NAMES].sort());
    for (const secret of ['GH_TOKEN', 'GITHUB_TOKEN', 'FY_TOKEN', 'ANTHROPIC_API_KEY', 'PATH', 'HOME'])
      expect(picked).not.toHaveProperty(secret);
    expect(toolEnvironment({ SSH_AUTH_SOCK: '', GH_TOKEN: 'x', XDG_RUNTIME_DIR: undefined })).toEqual({});
  });

  test('git and gh (by name or by path) get the tool environment; every other program gets only the base', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/fy' };
    const tools = toolEnvironment(FULL);
    expect(childEnvironment('gh', base, tools, {})).toEqual({ ...base, ...tools });
    expect(childEnvironment('/usr/bin/git', base, tools, {})).toEqual({ ...base, ...tools });
    for (const other of ['ssh', 'sh', 'ps', 'github', '/opt/gh-evil/run']) expect(childEnvironment(other, base, tools, {})).toEqual(base);
  });

  test('the caller\'s own env wins over the tool environment', () => {
    const tools = toolEnvironment(FULL);
    expect(childEnvironment('gh', { PATH: '/p' }, tools, { XDG_CONFIG_HOME: '/mine' }).XDG_CONFIG_HOME).toBe('/mine');
  });
});

describe('XX a real git child sees the allow-list and not a token', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  test('a program named git that prints its environment', async () => {
    const dir = await mkdtemp(`${tmpdir()}/tool-env-`);
    roots.push(dir);
    await writeFile(`${dir}/git`, '#!/bin/sh\nenv\n');
    await chmod(`${dir}/git`, 0o755);
    await writeFile(`${dir}/other`, '#!/bin/sh\nenv\n');
    await chmod(`${dir}/other`, 0o755);
    const spawn = bunSpawn({ PATH: `${dir}:/usr/bin:/bin` }, undefined, toolEnvironment(FULL));
    const git = await spawn.run('git', []);
    expect(git.stdout).toContain('SSH_AUTH_SOCK=/run/user/1000/ssh-agent');
    expect(git.stdout).toContain('https_proxy=http://proxy:3128');
    expect(git.stdout).not.toContain('GH_TOKEN');
    expect(git.stdout).not.toContain('GITHUB_TOKEN');
    expect(git.stdout).not.toContain('FY_TOKEN');
    const other = await spawn.run('other', []);
    expect(other.stdout).not.toContain('SSH_AUTH_SOCK');
  });
});
