import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSnapshot } from '@ferretry/kernel/host';
import type { Manifest } from '@ferretry/kernel/manifest';
import should from 'should';
import { homeText } from '../../../daemon/lib/harness/launch.ts';

/**
 * F4316: the job keeper's words reach a Claude ferret through the ACTIVE launch path, never a wrapper: a plugin manifest's
 * `instructions` entry -> the kernel snapshot (`buildSnapshot`, text read from the real `instructions/jobs.md`) -> the
 * launch's instruction list -> the memory file Claude reads (`homeText().memory`). Terminals owns the entry (its own unit
 * test pins the declaration); this proves a Claude home built from it carries the words for auto and interactive ferrets,
 * lead and helper alike.
 */

const JOBS_FILE = join(import.meta.dir, '../../../../terminals/instructions/jobs.md');
const TERMINALS = {
  id: 'terminals',
  instructions: [{ id: 'jobs', text: 'instructions/jobs.md', when: { role: 'any' } }],
} as unknown as Manifest;
const snapshot = buildSnapshot([TERMINALS], [], () => readFileSync(JOBS_FILE, 'utf8'));
const JOBS = readFileSync(JOBS_FILE, 'utf8').trim();

// Claude's two permission modes: `auto` is the unattended ferret, `skip` the interactive one.
const MODES = [
  ['auto', 'auto'],
  ['interactive', 'skip'],
] as const;
const ROLES = ['lead', 'helper'] as const;

describe('the Claude home a launch writes', () => {
  for (const [mode, permissionMode] of MODES)
    for (const role of ROLES)
      it(`should carry the jobs words for a ${mode} ${role}`, () => {
        // Arrange — the entries a launch gives this ferret: `role: any`, no harness named, so every ferret.
        const instructions = snapshot.instructions.filter(
          entry => entry.when.role === undefined || entry.when.role === 'any' || entry.when.role === role,
        );

        // Act
        const { memory } = homeText({
          folder: '/work/repo',
          permissionMode,
          instructions,
          parts: [],
          settings: new Map(),
          hooks: new Map(),
        });

        // Assert
        should(memory).containEql(JOBS);
        should(memory).containEql('`fy job run --name <x> -- <cmd>`');
      });
});
