/**
 * The preview stage's one read of the v4 login files: which harness each names, and nothing else.
 *
 * v4 decides a runtime's harness from its login (`runtimeHarness`, `packages/fleet/src/lib/account/scope.ts`), and the
 * preview leaves every login file out because it can hold a credential. The preview stage (run by the owner in
 * `prepare`) therefore reads each `config/logins/<id>.yaml` ONCE, through {@link PickHarness}, a schema that keeps only
 * the `harness` field: any other key, a plain key included, is dropped by the schema and exists nowhere after this
 * function returns. What leaves is a map of login name to `claude` or `codex`. A login that is unreadable, oversize, a
 * link, has no `harness`, or is written with `claude:` / `codex:` halves (it drives both CLIs, so a profile may
 * decide) is left out of the map and its runtimes stay held as unknown. No error text is passed on: a YAML parser's
 * message quotes the line it choked on.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { V4LoginId } from '../src/v4/logins.ts';

/** v4's 256 KiB cap on a config file. */
const MAX_BYTES = 256 * 1024;

/** Keeps only `harness` (and whether either half is written, never its content). Every other key is stripped. */
const PickHarness = z.object({
  harness: z.enum(['claude', 'codex']),
  claude: z
    .unknown()
    .optional()
    .transform(value => value !== undefined),
  codex: z
    .unknown()
    .optional()
    .transform(value => value !== undefined),
});

/** Login name to its one harness, for the logins whose file names exactly one. */
export async function readLoginHarnesses(v4Home: string): Promise<ReadonlyMap<string, 'claude' | 'codex'>> {
  const folder = join(v4Home, 'config', 'logins');
  const found = new Map<string, 'claude' | 'codex'>();
  const entries = await readdir(folder).catch(() => [] as string[]);
  for (const entry of entries.sort()) {
    const id = /^(.+)\.yaml$/u.exec(entry)?.[1];
    if (id === undefined || !V4LoginId.safeParse(id).success) continue;
    const path = join(folder, entry);
    const facts = await lstat(path).catch(() => undefined);
    if (facts === undefined || !facts.isFile() || facts.size > MAX_BYTES) continue;
    try {
      const picked = PickHarness.safeParse(parse(await readFile(path, 'utf8')));
      if (picked.success && !picked.data.claude && !picked.data.codex) found.set(id, picked.data.harness);
    } catch {
      // Unreadable or not YAML: left out, and no part of the error is kept.
    }
  }
  return found;
}
