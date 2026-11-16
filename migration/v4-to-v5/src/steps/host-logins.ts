/**
 * Codex logins v4 kept in the terminal's own sign-in folder (`store: host`).
 *
 * 5.0 cannot start a Codex ferret from a host store (`codex-credential.ts`), so the converter writes such a login with
 * `store: ferretry` under the SAME name and leaves it an empty, private sign-in folder (the Logins step). The owner
 * signs it in once (`fy login signin <name>`). A Claude `store: host` login is NOT touched: 5.0 starts a Claude ferret
 * from the terminal's own sign-in as v4 did, so it stays `store: host`.
 *
 * Nothing under `~/.claude*`, `~/.codex*` or the keychain is read, listed or linked here: the only inputs are the v4
 * home's own `config/logins/<name>.yaml` files.
 */
import { isMap, isScalar, type Document } from 'yaml';
import { listV4Config, readV4Yaml } from '../v4/config.ts';
import type { StepContext } from './index.ts';

/** The sentence the report carries for each converted login (names only). */
export const HOST_CODEX_MOVED = (name: string): string =>
  `${name}: moved to Ferretry's own sign-in; needs one sign-in: fy login signin ${name}`;

/** Whether a v4 login file says `harness: codex` and `store: host` (an absent `store` is v4's default, `ferretry`). */
export function isCodexHostLogin(document: Document): boolean {
  const map = document.contents;
  if (!isMap(map)) return false;
  return map.get('store') === 'host' && map.get('harness') === 'codex';
}

/** Rewrites `store: host` to `store: ferretry` in place, so the owner's comments and key order stay. */
export function moveToFerretryStore(document: Document): void {
  const map = document.contents;
  if (!isMap(map)) return;
  const node = map.get('store', true);
  if (isScalar(node)) node.value = 'ferretry';
}

/** The names of the v4 logins that are Codex `store: host` (sorted). A file that cannot be read fails the caller by path. */
export async function codexHostLogins(ctx: StepContext): Promise<readonly string[]> {
  const names: string[] = [];
  for (const file of (await listV4Config(ctx.v4.home, ctx.v4.configOverrides)).files) {
    if (file.address.kind !== 'login') continue;
    if (isCodexHostLogin(await readV4Yaml(file))) names.push(file.address.name);
  }
  return names.sort();
}
