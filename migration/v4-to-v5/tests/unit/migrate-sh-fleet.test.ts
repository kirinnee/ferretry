import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { advance, DAEMON_UP_SH, makeSandbox, type Sandbox } from './migrate-harness.ts';

/**
 * `start` refuses any entry in the new home that v5 did not make, EXCEPT `fleet/` when it holds nothing but
 * `assets/**` (installed skills and component assets such as a carried hook file, where v5 Runtimes reads them), and
 * every entry there is a regular file or a folder.
 */

setDefaultTimeout(60_000);

const made: Sandbox[] = [];
const box = async (): Promise<Sandbox> => {
  const sb = await makeSandbox();
  made.push(sb);
  return sb;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map(sb => sb.cleanup()));
});

const put = async (sb: Sandbox, rel: string, text = 'x\n'): Promise<void> => {
  const path = join(sb.v4home, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

const readyToStart = async (sb: Sandbox): Promise<void> => {
  await advance(sb, 'install');
  await sb.fake('fy', [
    { match: '--version', run: 'cat "$D/fy.version"' },
    { match: 'config check --json', out: '{"files":1,"issues":[],"pending":[]}' },
    { match: 'daemon start', run: DAEMON_UP_SH },
    { match: 'ps -a --json', run: 'cat "$D/ps.v5.json"' },
  ]);
};

describe('start: the converter-written skill folders under fleet/ are allowed, nothing else is', () => {
  test('fleet holding only assets/skills/** passes, and the daemon starts', async () => {
    const sb = await box();
    await readyToStart(sb);
    await put(sb, 'fleet/assets/skills/review/SKILL.md');
    await put(sb, 'fleet/assets/skills/review/refs/deep/notes.md');
    await put(sb, 'fleet/assets/skills/other/SKILL.md');
    const result = await sb.run('start');
    expect(result.code).toBe(0);
    expect(await sb.notesText()).toContain('# started-v5');
  });

  test('an empty fleet/ and a fleet/assets with no asset pass too', async () => {
    const sb = await box();
    await readyToStart(sb);
    await mkdir(join(sb.v4home, 'fleet', 'assets'), { recursive: true });
    expect((await sb.run('start')).code).toBe(0);
  });

  test('a component asset (a carried hook file) under fleet/assets/components passes', async () => {
    const sb = await box();
    await readyToStart(sb);
    await put(sb, 'fleet/assets/skills/review/SKILL.md');
    await put(sb, 'fleet/assets/components/hooks/compact-before.txt');
    await put(sb, 'fleet/assets/x.txt');
    const result = await sb.run('start');
    expect(result.code).toBe(0);
    expect(await sb.notesText()).toContain('# started-v5');
  });

  test.each([
    ['a file next to assets', 'fleet/other.txt', 'fleet/other.txt'],
    ['another folder under fleet', 'fleet/shared/a/b.txt', 'fleet/shared'],
  ])('%s stops and is named', async (_label, rel, named) => {
    const sb = await box();
    await readyToStart(sb);
    await put(sb, 'fleet/assets/skills/review/SKILL.md');
    await put(sb, rel);
    const result = await sb.run('start');
    expect(result.code).toBe(1);
    expect(result.err).toContain(`unexpected entry '${named}' in the new home`);
    expect((await sb.calls()).filter(line => line === 'fy daemon start')).toEqual([]);
    expect(await sb.notesText()).not.toContain('# starting-v5');
  });

  test.each([
    ['a symlink in a skill', 'fleet/assets/skills/a/link', 'link'],
    ['a symlink in a component asset folder', 'fleet/assets/components/hooks/link', 'link'],
    ['a FIFO in a skill', 'fleet/assets/skills/a/fifo', 'fifo'],
    ['a FIFO under a component asset folder', 'fleet/assets/components/fifo', 'fifo'],
  ])('%s stops and is named, never followed', async (_label, rel, kind) => {
    const sb = await box();
    await readyToStart(sb);
    await put(sb, 'fleet/assets/skills/a/SKILL.md');
    await mkdir(join(sb.v4home, dirname(rel)), { recursive: true });
    if (kind === 'link') await symlink('/etc', join(sb.v4home, rel));
    else {
      const made = Bun.spawnSync(['mkfifo', join(sb.v4home, rel)]);
      expect(made.exitCode).toBe(0);
    }
    const result = await sb.run('start');
    expect(result.code).toBe(1);
    expect(result.err).toContain(`unexpected entry '${rel}' in the new home`);
    expect(result.err).toContain('not a regular file or folder');
    expect((await sb.calls()).filter(line => line === 'fy daemon start')).toEqual([]);
    expect(await sb.notesText()).not.toContain('# starting-v5');
  });

  test('a link in place of fleet or assets is a stop, and no link is followed', async () => {
    for (const rel of ['fleet', 'fleet/assets']) {
      const sb = await box();
      await readyToStart(sb);
      const target = join(sb.root, 'elsewhere');
      await mkdir(join(target, 'assets', 'skills'), { recursive: true });
      await mkdir(join(sb.v4home, dirname(rel)), { recursive: true });
      await symlink(target, join(sb.v4home, rel));
      const result = await sb.run('start');
      expect({ rel, code: result.code }).toEqual({ rel, code: 1 });
      expect(result.err).toContain('not a plain folder');
    }
  });

  test('another top-level entry still stops with its own name', async () => {
    const sb = await box();
    await readyToStart(sb);
    await put(sb, 'fleet/assets/skills/review/SKILL.md');
    await put(sb, 'surprise/a.txt');
    const result = await sb.run('start');
    expect(result.code).toBe(1);
    expect(result.err).toContain("unexpected entry 'surprise' in the new home");
  });
});
