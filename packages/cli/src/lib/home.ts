import { isAbsolute, join } from 'node:path';

/** The daemon's home: `FY_HOME` when the operator pinned one, else `~/.<product>`. Pure. */
export function resolveHome(userHome: string, fyHome: string | undefined, product: string): string {
  if (!isAbsolute(userHome)) throw new Error('the user home directory is not an absolute path');
  if (fyHome === undefined || fyHome.trim() === '') return join(userHome, `.${product}`);
  if (!isAbsolute(fyHome.trim())) throw new Error('FY_HOME must be an absolute path');
  return fyHome.trim();
}

/** Where Gate keeps the admin token (§7.1 `state/gate/admin-token`). */
export const adminTokenPath = (home: string): string => join(home, 'state', 'gate', 'admin-token');

/** Where the daemon records the address it bound (`config/daemon.json`), the one daemon document this client reads. */
export const daemonConfigPath = (home: string): string => join(home, 'config', 'daemon.json');
