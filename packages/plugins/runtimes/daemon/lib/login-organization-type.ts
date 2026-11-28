import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import type { RuntimesHarnessKit } from '../../contract/harness-kit.ts';
import { type HarnessKind, kindOrUndefined } from './harness-kind.ts';

/**
 * The organisation type of the login a launch spends, for the Claude channel's default (a harness whose kit says its host login names one). Logins names it for a login it keeps
 * (`launchStores`: its own account file); a login kept by the host (`store: host`) has no file of Logins' to read, so the
 * person's own `~/.claude.json` says ({@link readHost}). An environment login, a Codex login and an unknown id have none.
 * One non-secret field, never a token.
 */
export async function loginOrganizationType(
  logins: Pick<LoginsApi, 'launchStores' | 'get'>,
  readHost: () => Promise<string | undefined>,
  login: string,
  kits: ReadonlyMap<HarnessKind, RuntimesHarnessKit> | undefined,
): Promise<string | undefined> {
  const kept = (await logins.launchStores()).find(store => store.id === login)?.organizationType;
  if (kept !== undefined) return kept;
  const view = await logins.get(login as never);
  return view?.store === 'host' && kits?.get(kindOrUndefined(view.harness) as HarnessKind)?.hostOrganization === true
    ? await readHost()
    : undefined;
}
