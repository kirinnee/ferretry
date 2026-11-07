import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { accountsTab, signInApprovalRenderer } from './surfaces.tsx';

/**
 * Accounts' app half (§2.3), built per machine with that machine's client. Half a: the Accounts settings tab and the 2FA
 * seed card. ACCOUNTS-B'S SPOTS: `settings['secure-copy']` (a stand-in sentence until b's view lands), the rule views in
 * `features/accounts/sign-in-rules-slot.tsx`, and the non-seed kinds of the sign-in-approval renderer.
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    settings: { accounts: accountsTab(client), 'secure-copy': SecureCopyNotBuilt },
    renderers: { 'ask:sign-in-approval': signInApprovalRenderer(client) },
  }),
});

/** Half b's tab, not ported yet: says so rather than showing an empty list. */
function SecureCopyNotBuilt() {
  return null;
}
