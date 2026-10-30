/**
 * The overlay's question hook, run by a real shell the way Claude Code runs a command hook: the
 * `PreToolUse` payload on stdin, the pane's environment around it.
 *
 * It must copy the payload whole into the file the daemon named (`FY_QUESTION_FILE`), replace an older
 * question rather than append to it, and — with no file named, as in a person's own terminal — write
 * nothing and still succeed. Exit 0 and no output are what keep it from ever changing Claude's decision.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { CLAUDE_QUESTION_HOOK_COMMAND } from '../../src/lib/account/fixed-layer.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function hook(stdin: string, env: Record<string, string>) {
  const child = Bun.spawn(['/bin/sh', '-c', CLAUDE_QUESTION_HOOK_COMMAND], {
    env: { PATH: '/usr/bin:/bin', ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe('the question hook command', () => {
  it('should copy the payload whole into the named file, replacing the last question', async () => {
    // Arrange
    const root = await mkdtemp(path.join(tmpdir(), 'fy-question-hook-'));
    roots.push(root);
    const file = path.join(root, 'question-asked.json');
    const first = JSON.stringify({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_1' });
    const second = JSON.stringify({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_2' });

    // Act
    const one = await hook(first, { FY_QUESTION_FILE: file });
    const two = await hook(second, { FY_QUESTION_FILE: file });

    // Assert — silent and successful, the newest payload exactly, and no temporary left behind.
    should([one, two]).deepEqual([
      { stdout: '', stderr: '', code: 0 },
      { stdout: '', stderr: '', code: 0 },
    ]);
    should(await readFile(file, 'utf8')).equal(second);
    should(await readdir(root)).deepEqual(['question-asked.json']);
  });

  it('should write nothing and still succeed where no file is named', async () => {
    // Arrange
    const root = await mkdtemp(path.join(tmpdir(), 'fy-question-hook-'));
    roots.push(root);

    // Act
    const unset = await hook('{"tool_use_id":"toolu_1"}', {});
    const empty = await hook('{"tool_use_id":"toolu_1"}', { FY_QUESTION_FILE: '' });

    // Assert
    should([unset.code, empty.code]).deepEqual([0, 0]);
    should(await readdir(root)).deepEqual([]);
  });

  it('should still succeed when the named file cannot be written', async () => {
    // Act — a folder that does not exist: the question is lost, never the tool call.
    const result = await hook('{"tool_use_id":"toolu_1"}', { FY_QUESTION_FILE: '/nonexistent/fy/question.json' });

    // Assert — silent too: Claude would show a hook's stderr beside the tool call.
    should(result).deepEqual({ stdout: '', stderr: '', code: 0 });
  });
});
