import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const SEAM = /from\s+'[^']*host\/fs\.ts'/u;

/** Every non-test source file of Terminals that imports the host-fs seam. */
function importers(): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'tests') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/u.test(entry.name) && SEAM.test(readFileSync(path, 'utf8'))) found.push(relative(ROOT, path));
    }
  };
  walk(ROOT);
  return found.sort();
}

describe('the Terminals host-fs seam', () => {
  test('only the pinned adapters reach it, so a new file that wants raw fs access is noticed', () => {
    // The seam hands free-path readFile/open/readdir to its importers and the banned-globals check cannot see an
    // import of it. A new importer must be added here on purpose, with a reviewer looking at what it reads.
    expect(importers()).toEqual(
      [
        'daemon/adapters/cgroups/disk-scheduler.ts',
        'daemon/adapters/cgroups/fleet-memory.ts',
        'daemon/adapters/cgroups/host-facts.ts',
        'daemon/adapters/cgroups/proc-placements.ts',
        'daemon/adapters/cgroups/service-weights.ts',
        'daemon/adapters/session/processes/listening.ts',
        'daemon/adapters/session/processes/output-file.ts',
        'daemon/adapters/session/processes/process-incarnation.ts',
        'daemon/adapters/session/processes/process-tree.ts',
        'daemon/adapters/system/executable-code-programs.ts',
        'daemon/adapters/system/kernel-program-proof.ts',
        'daemon/adapters/system/profile-program.ts',
        'daemon/adapters/system/replaceable-file.ts',
        'daemon/adapters/terminal/system-login-shell.ts',
        'daemon/adapters/tmux/harness-launch-guard.ts',
        'daemon/index.ts',
        'daemon/processes.ts',
      ].sort(),
    );
  });
});
