import { expect, test } from 'bun:test';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { autoPermissionModeRefusal } from '../../../daemon/adapters/update-ports.ts';
import { lifecyclePart } from '../../../daemon/harness/parts/lifecycle.ts';

function host(stdout: string, exitCode: number | null = 0) {
  const runs: { program: string; args: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];
  const spawn = {
    run: async (program, args, options) => {
      runs.push({ program, args, env: options?.env as Readonly<Record<string, string>> });
      return { exitCode, stdout, stderr: '' };
    },
  } as SpawnPort;
  return { spawn, runs };
}

test('the installed binary reports Auto among its permission choices, including wrapped help', async () => {
  const h = host(
    '  --permission-mode <mode>\n    (choices: "default", "auto", "bypassPermissions")\n  --other option\n',
  );
  expect(await autoPermissionModeRefusal(h.spawn, '/synthetic/claude')).toBeUndefined();
  expect(h.runs[0]).toMatchObject({
    program: '/synthetic/claude',
    args: ['--help'],
    env: { HOME: '/nonexistent/fy-harness-probe', HTTPS_PROXY: 'http://127.0.0.1:9', DISABLE_AUTOUPDATER: '1' },
  });
});

test('an installed binary without Auto refuses with the remedy, never downgrades permissions', async () => {
  const h = host('--permission-mode <mode> (choices: "default", "bypassPermissions")\n--auto-update thing');
  expect(await autoPermissionModeRefusal(h.spawn, '/synthetic/claude')).toContain('does not accept Auto mode');
  const similar = host('--permission-mode <mode> (choices: "auto-edits", "default")');
  expect(await autoPermissionModeRefusal(similar.spawn, '/synthetic/claude')).toContain('does not accept Auto mode');
});

test('a failed, timed-out or uninterpretable capability read rejects', async () => {
  for (const h of [host('', 1), host('', null), host('Auto mode is great'), host('--permission-mode <mode>')])
    await expect(autoPermissionModeRefusal(h.spawn, '/synthetic/claude')).rejects.toThrow();
});

test('the harness reads its own permission mode and configured binary; Skip needs no Auto probe', async () => {
  let mode = 'skip';
  let located = 0;
  const h = host('--permission-mode <mode> (choices: "default")');
  const harness = lifecyclePart({
    deps: {
      config: { file: () => ({ permissionMode: mode }) },
      location: {
        locate: async () => {
          located++;
          return { outcome: 'located', path: '/configured/claude' };
        },
      },
      spawn: h.spawn,
    },
  } as never);
  expect(await harness.autoLaunchRefusal()).toBeUndefined();
  expect(located).toBe(0);
  mode = 'auto';
  expect(await harness.autoLaunchRefusal()).toContain('does not accept Auto mode');
  expect(h.runs[0]?.program).toBe('/configured/claude');
});
