/**
 * Which runtimes launch on a login: Runtimes' answer to Logins' `logins.used-by` hook. Logins cannot see runtimes, so a
 * login's removal asks here; the answer is read from `config/runtimes/*.yaml` as it is NOW, by name, sorted.
 *
 * Pure apart from the reading it is handed.
 */
import type { LoginChange, LoginRuntimePreview, LoginUsers } from '@ferretry/plugin-logins/contract';
import type { RuntimeFile } from '../../../contract/index.ts';

export function loginUsers(
  runtimes: () => ReadonlyMap<string, RuntimeFile>,
  after?: (change: LoginChange) => Promise<readonly LoginRuntimePreview[]>,
): LoginUsers {
  return {
    ...(after === undefined ? {} : { after }),
    of: loginId =>
      [...runtimes()]
        .filter(([, file]) => file.login === loginId)
        .map(([name]) => name)
        .toSorted((left, right) => left.localeCompare(right)),
  };
}
