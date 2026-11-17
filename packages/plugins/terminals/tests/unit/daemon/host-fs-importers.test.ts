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
    // job-files.ts reads only a job's own log and exit record (open/readFile/stat on paths the state port handed out);
    // harness-ancestry.ts reads /proc/<pid>/{stat,cmdline} to find the harness an attachment sits under;
    // executable-identity.ts reads /proc/<pid>/{exe,cmdline,cwd} (and stats files) to prove WHICH file an attachment runs.
    expect(importers()).toEqual(
      [
        'daemon/adapters/cgroups/disk-scheduler.ts',
        'daemon/adapters/cgroups/fleet-memory.ts',
        'daemon/adapters/cgroups/host-facts.ts',
        'daemon/adapters/cgroups/proc-placements.ts',
        'daemon/adapters/cgroups/service-weights.ts',
        'daemon/adapters/jobs/executable-identity.ts',
        'daemon/adapters/jobs/harness-ancestry.ts',
        'daemon/adapters/jobs/job-files.ts',
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
        // Reads only `/proc/<pid>/stat` of this daemon and its parents (the pids a descendant signal never reaches), and sends the one signal.
        'daemon/adapters/tmux/pane-process-host.ts',
        'daemon/index.ts',
        'daemon/processes.ts',
      ].sort(),
    );
  });
});
