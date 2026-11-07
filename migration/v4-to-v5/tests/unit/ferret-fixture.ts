import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4Paths } from '../../src/v4/layout.ts';
import { v5Writer } from '../../src/v5/write.ts';

export const AT = '2026-11-01T00:00:00.000Z';
export const RUNTIME = '11111111-1111-4111-8111-111111111111';
export const FAKE_HASH = 'a'.repeat(64);

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fy-f-'));
  const from = join(root, 'v4');
  const to = join(root, 'v5');
  await mkdir(from, { mode: 0o700 });
  const put = async (path: string, value: unknown) => {
    const target = join(from, path);
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, JSON.stringify(value), { mode: 0o600 });
  };
  const session = async (id = 'f1', extra: Record<string, unknown> = {}) => {
    await put(`state/sessions/${id}/config.json`, {
      id,
      name: id,
      agent: 'codex-work',
      harness: 'codex',
      cwd: '/work/project',
      tmuxSession: `fy-${id}`,
      createdAt: AT,
      updatedAt: AT,
      ...extra,
    });
  };
  const pane = async (id = 'f1') =>
    put(`state/sessions/${id}/terminal-pane.json`, {
      daemonId: 'daemon1',
      sessionId: id,
      tmuxSession: `fy-${id}`,
      paneId: '%12',
      pid: 100,
      processStartTicks: 1,
    });
  return {
    root,
    from,
    to,
    put,
    session,
    pane,
    ctx: (dryRun = false) => ({ v4: v4Paths(from), v5: v5Writer(to, { dryRun }), dryRun }),
    clean: () => rm(root, { recursive: true, force: true }),
  };
}
