import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import type { PackCredentialFacts, PackQuotaSource, PaneLimit } from '../../contract/index.ts';

/**
 * What Packs reads about each login's sign-in, quota and budget: the Logins port's own list, whose rows already carry
 * them (`LoginView`), so Packs asks the plugin that owns the facts and no second port that merely shares a name.
 *
 * GAP (declared): which logins the PANES prove out of quota (a spend limit only the harness announces) is derived inside
 * Usage from ferret session documents and Usage's port offers no read of it, so none is reported here: a login that is
 * out of quota on a pane only is still offered until its own windows or budget say otherwise.
 */
export class LoginQuotaFacts implements PackQuotaSource {
  constructor(private readonly logins: () => LoginsApi | undefined) {}

  async credentials(): Promise<readonly PackCredentialFacts[]> {
    return (await this.logins()?.list())?.logins ?? [];
  }

  async paneLimits(): Promise<ReadonlyMap<string, PaneLimit>> {
    return new Map();
  }
}
