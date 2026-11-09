/**
 * The preview stage's one read of the v4 login files: which harness each names, and nothing else.
 *
 * v4 decides a runtime's harness from its login (`runtimeHarness`, `packages/fleet/src/lib/account/scope.ts`), and the
 * preview leaves every login file out because it can hold a credential. The preview stage (run by the owner in
 * `prepare`) therefore reads each `config/logins/<id>.yaml` ONCE and takes two facts from it: the `harness` scalar, and
 * whether BOTH `claude:` and `codex:` halves are written (the login then drives both CLIs, so a runtime's profile may
 * decide). The document is never turned into plain data: the two facts are read from their nodes, so nothing else of
 * the file is ever in a variable. A login that is unreadable (any YAML error or warning, a link, a folder, a FIFO, a
 * hard link, oversize), or has no `harness`, is left out of the map and its runtimes stay held as unknown. Nothing is
 * printed and no error text is kept: the YAML library's warnings are silenced (`logLevel: 'silent'`), because they quote
 * the text they choked on.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isScalar } from 'yaml';
import type { LoginHarness } from '../src/steps/preview-hold.ts';
import { readPlainText, strictYamlMap } from '../src/v4/config.ts';
import { V4LoginId } from '../src/v4/logins.ts';

/** v4's 256 KiB cap on a config file. */
const MAX_BYTES = 256 * 1024;

/** A folder that is really a folder: not a link (v4 itself ignores a linked `logins/`). */
const realFolder = async (path: string): Promise<boolean> =>
  (await lstat(path).catch(() => undefined))?.isDirectory() === true;

/** Login name to its harness, for the logins whose file names one. */
export async function readLoginHarnesses(v4Home: string): Promise<ReadonlyMap<string, LoginHarness>> {
  const found = new Map<string, LoginHarness>();
  const config = join(v4Home, 'config');
  const folder = join(config, 'logins');
  if (!(await realFolder(config)) || !(await realFolder(folder))) return found;
  const entries = await readdir(folder).catch(() => [] as string[]);
  for (const entry of entries.sort()) {
    const id = /^(.+)\.yaml$/u.exec(entry)?.[1];
    if (id === undefined || !V4LoginId.safeParse(id).success) continue;
    const text = await readPlainText(join(folder, entry), MAX_BYTES);
    const document = text === undefined ? undefined : strictYamlMap(text);
    if (document === undefined) continue;
    const harness = document.get('harness', true);
    const value = isScalar(harness) ? harness.value : undefined;
    if (value !== 'claude' && value !== 'codex') continue;
    // Only a login of the environment store has halves (v4 `hasHalves`).
    const store = document.get('store', true);
    const halves = isScalar(store) && store.value === 'environment';
    found.set(id, { harness: value, both: halves && document.has('claude') && document.has('codex') });
  }
  return found;
}
