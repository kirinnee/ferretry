/**
 * A v4-shaped home with the links v4 writes ITSELF: its provisioner's per-account links
 * (`packages/fleet/src/adapters/file-provisioner.ts`, "a credential link is the planner's own") inside
 * `fleet/homes/<account>/`, its shared-history links (`file-shared-history.ts`) inside `fleet/shared/`, and a wrapper
 * link in `fleet/bin/`. Every link points at a TRIPWIRE: a stand-in for the terminal's own sign-in folders (a fake
 * `.codex` and `.claude` holding FAKE canary files, and a fake `.claude.json`) in a temp home. Nothing here is real.
 */
import { chmod, mkdir, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
export const TRIPWIRE_CANARY = 'FAKE-TRIPWIRE-CANARY-NOT-A-TOKEN';

/** The tripwire's files, relative to its home. */
const TRIPWIRE_FILES = [
  '.codex/auth.json',
  '.codex/sessions/rollout.jsonl',
  '.claude/.credentials.json',
  '.claude/projects/p/log.jsonl',
  '.claude.json',
] as const;
const TRIPWIRE_FOLDERS = ['.codex/sessions', '.codex', '.claude/projects/p', '.claude/projects', '.claude'] as const;

export interface Tripwire {
  /** What the tripwire looked like before the run: per file its times and mode, per folder its listing. */
  readonly before: string;
  /** Looks the same snapshot again (folders opened for the look, closed again). */
  readonly snapshot: () => Promise<string>;
  /** Opens every tripwire folder again so the temp tree can be removed (also safe to call twice). */
  readonly restore: () => Promise<void>;
  /** Locks every folder (mode 000): any access through a link now fails with EACCES. */
  readonly lock: () => Promise<void>;
}

/** Writes the tripwire's files (mode 000) and returns its controls; NOT locked yet. */
export async function plantTripwire(home: string): Promise<Tripwire> {
  for (const folder of ['.codex/sessions', '.claude/projects/p']) await mkdir(join(home, folder), { recursive: true });
  for (const file of TRIPWIRE_FILES) {
    await writeFile(join(home, file), TRIPWIRE_CANARY, { mode: 0o600 });
    await chmod(join(home, file), 0o000);
  }
  const open = async (): Promise<void> => {
    for (const folder of [...TRIPWIRE_FOLDERS].reverse()) await chmod(join(home, folder), 0o700).catch(() => undefined);
  };
  const lock = async (): Promise<void> => {
    await open();
    for (const folder of TRIPWIRE_FOLDERS) await chmod(join(home, folder), 0o000);
  };
  const snapshot = async (): Promise<string> => {
    await open();
    try {
      const lines: string[] = [];
      for (const file of TRIPWIRE_FILES) {
        const facts = await stat(join(home, file));
        lines.push(`${file} atime=${facts.atimeMs} mtime=${facts.mtimeMs} ctime=${facts.ctimeMs} mode=${facts.mode}`);
      }
      for (const folder of TRIPWIRE_FOLDERS)
        lines.push(`${folder}/ ${(await readdir(join(home, folder))).sort().join(',')}`);
      return lines.join('\n');
    } finally {
      await lock();
    }
  };
  // The snapshot is taken with the folders open, then they are locked for the run.
  const before = await snapshot();
  return { before, snapshot, restore: open, lock };
}

/**
 * Lays v4's own links into the v4 home `from` and returns their paths. `tripwireHome` holds the tripwire folders.
 * The account is known to `fleet/manifest.json`, so the harness-homes step really walks its folder.
 */
export async function provisionerLinks(from: string, tripwireHome: string): Promise<readonly string[]> {
  const links: string[] = [];
  const link = async (target: string, at: string): Promise<void> => {
    await mkdir(join(at, '..'), { recursive: true, mode: 0o700 });
    await symlink(join(tripwireHome, target), at);
    links.push(at);
  };
  const account = join(from, 'fleet/homes/acct1');
  await mkdir(join(account, 'projects'), { recursive: true, mode: 0o700 });
  await writeFile(join(account, 'projects/own.jsonl'), '{"fake":"own transcript"}\n', { mode: 0o600 });
  // The provisioner: a per-account link to the terminal's own sign-in (store: host), whole folders and a file.
  await link('.codex', join(account, '.codex'));
  await link('.claude', join(account, '.claude'));
  await link('.claude.json', join(account, '.claude.json'));
  await link('.codex/auth.json', join(account, 'nested/session.json'));
  // Shared history: pooled session folders and a file, linked into the shared pool.
  await mkdir(join(from, 'fleet/shared/claude'), { recursive: true, mode: 0o700 });
  await mkdir(join(from, 'fleet/shared/codex'), { recursive: true, mode: 0o700 });
  await link('.claude/projects', join(from, 'fleet/shared/claude/projects'));
  await link('.codex/sessions', join(from, 'fleet/shared/codex/sessions'));
  await link('.codex/sessions/rollout.jsonl', join(from, 'fleet/shared/codex/history.jsonl'));
  // A wrapper link.
  await link('.codex', join(from, 'fleet/bin/codex-wrapper'));
  await writeFile(
    join(from, 'fleet/manifest.json'),
    JSON.stringify({ version: 1, accounts: [{ id: ACCOUNT_ID, kind: 'codex', home: account }] }),
    { mode: 0o600 },
  );
  return links.sort();
}
