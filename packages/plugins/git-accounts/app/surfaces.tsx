import { AccountsSurface } from './features/accounts/accounts-surface.tsx';
import type { GitAccountsClient } from './shell.tsx';

/** Settings › ‹machine› › GitHub accounts, bound to that machine's client. */
export function accountsTab(client: GitAccountsClient) {
  return function AccountsTab() {
    return <AccountsSurface client={client} />;
  };
}
