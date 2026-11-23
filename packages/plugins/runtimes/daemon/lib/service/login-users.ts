/**
 * Which runtimes launch on a login: Runtimes' answer to Logins' `logins.used-by` hook. Logins cannot see runtimes, so a
 * login's removal asks here; the answer is read from `config/runtimes/*.yaml` as it is NOW, by name, sorted.
 *
 * Pure apart from the reading it is handed.
 */
import type { LoginChange, LoginRuntimePreview, LoginUsers, LoginView } from '@ferretry/plugin-logins/contract';
import type { RuntimeFile } from '../../../contract/index.ts';

export function loginUsers(
  runtimes: () => ReadonlyMap<string, RuntimeFile>,
  after?: (change: LoginChange) => Promise<readonly LoginRuntimePreview[]>,
  /** The runtime list `runtime ls` shows (files plus derived), made from the logins it is handed. */
  listing?: (logins: readonly LoginView[]) => Promise<readonly { readonly id: string; readonly login: string }[]>,
): LoginUsers {
  return {
    ...(after === undefined ? {} : { after }),
    ...(listing === undefined
      ? {}
      : {
          listed: async logins => {
            const listed = await listing(logins);
            return Object.fromEntries(
              logins.map(login => [
                login.id,
                listed
                  .filter(runtime => runtime.login === login.id)
                  .map(runtime => runtime.id)
                  .toSorted((left, right) => left.localeCompare(right)),
              ]),
            );
          },
        }),
    of: loginId =>
      [...runtimes()]
        .filter(([, file]) => file.login === loginId)
        .map(([name]) => name)
        .toSorted((left, right) => left.localeCompare(right)),
  };
}
