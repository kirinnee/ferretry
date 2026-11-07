/**
 * STAND-IN for a plugin contract this one may not import yet (§2.4: Voice -> Logins is an optional `uses`, but the
 * contract-graph edge `voice→logins` is not on its allow-list). Voice `uses` Logins (§2.3) so that "Voice uses an
 * OpenAI login if you have one"; the token is Logins' (`LoginsPort`, name `logins`). The generator matches ports by
 * name, so this has the same name; replace it with Logins' token when the lead allows the edge. Today's code never
 * reads a login when it cleans up a transcript (`provider: login` is accepted by `voice.yaml` and not yet served), so
 * the daemon half does not call it either.
 */
import { definePort } from '@ferretry/kernel/contract';

export interface LoginsListApi {
  /** The ids of the logins on this machine. Never a credential. */
  list(): Promise<{ readonly logins: readonly { readonly id: string }[] }>;
}
export const LoginsPort = definePort<LoginsListApi>('logins');
