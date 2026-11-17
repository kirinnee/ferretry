import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildSnapshot } from '@ferretry/kernel/host';
import manifest from '../../manifest.ts';

/** The job keeper's words a ferret reads (`instructions/jobs.md`): what the manifest declares, and what the kernel snapshot makes of it. */
const PACKAGE = join(import.meta.dir, '../..');
const read = (path: string): string | undefined => readFileSync(join(PACKAGE, path), 'utf8');

const declared = manifest.instructions?.find(entry => entry.id === 'jobs');
const TEXT = read('instructions/jobs.md')?.trim() ?? '';

describe('the jobs instruction', () => {
  test('is declared once, for every role, with no harness named so Claude AND Codex both get it', () => {
    expect(manifest.instructions?.filter(entry => entry.id === 'jobs')).toHaveLength(1);
    expect(declared).toEqual({ id: 'jobs', text: 'instructions/jobs.md', when: { role: 'any' } });
  });

  test('is the one short paragraph: it names each verb a ferret needs and stays under 700 characters', () => {
    expect(TEXT.length).toBeLessThan(700);
    expect(TEXT).not.toContain('\n');
    for (const verb of ['job run', 'job logs', 'job wait', 'job attach', 'job ls', 'job stop'])
      expect(TEXT).toContain(`fy ${verb}`);
  });

  test("names Codex's real long-command tool, not only what to avoid", () => {
    expect(TEXT).toContain('Codex: exec_command with a short yield_time_ms');
    expect(TEXT).toContain('Claude: Bash with run_in_background');
  });

  test('the real snapshot built from this manifest and the real file carries it, unfiltered', () => {
    const snapshot = buildSnapshot([manifest], [], (plugin, path) => (plugin === 'terminals' ? read(path) : undefined));
    const entry = snapshot.instructions.find(each => each.id === 'jobs');
    expect(String(entry?.plugin)).toBe('terminals');
    expect(entry?.when).toEqual({ role: 'any' });
    expect(entry?.text.trim()).toBe(TEXT);
  });
});
