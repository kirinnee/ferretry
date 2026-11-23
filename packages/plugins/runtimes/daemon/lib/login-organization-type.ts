import { isKind } from './harness-kind.ts';
import type { LoginsApi } from '@ferretry/plugin-logins/contract';

/**
 * The organisation type of the login a launch spends, for the Claude channel's default. Logins names it for a login it keeps
 * (`launchStores`: its own account file); a login kept by the host (`store: host`) has no file of Logins' to read, so the
 * person's own `~/.claude.json` says ({@link readHost}). An environment login, a Codex login and an unknown id have none.
 * One non-secret field, never a token.
 */
export async function loginOrganizationType(
  logins: Pick<LoginsApi, 'launchStores' | 'get'>,
  readHost: () => Promise<string | undefined>,
  login: string,
): Promise<string | undefined> {
  const kept = (await logins.launchStores()).find(store => store.id === login)?.organizationType;
  if (kept !== undefined) return kept;
  const view = await logins.get(login as never);
  return view?.store === 'host' && isKind(view.harness, 'claude') ? await readHost() : undefined;
}
