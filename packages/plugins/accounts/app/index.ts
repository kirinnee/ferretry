import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { accountsTab, secureCopyTab, signInApprovalRenderer } from './surfaces.tsx';

/**
 * Accounts' app half (§2.3), built per machine with that machine's client: the Accounts settings tab and the 2FA seed
 * card (half a), the Secure copy settings tab (paste rules, task plans, standing sign-in rules) and the sign-in-approval
 * cards (half b).
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    settings: { accounts: accountsTab(client), 'secure-copy': secureCopyTab(client) },
    renderers: { 'ask:sign-in-approval': signInApprovalRenderer(client) },
  }),
});
