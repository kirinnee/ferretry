import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { ruleLinkView, RULE_FRAGMENT_KEY } from './features/secure-copy/rule-link-view.tsx';
import { RuleLinkHold } from './lib/rule-link.ts';
import { accountsTab, secureCopyTab, signInApprovalRenderer } from './surfaces.tsx';

/** Where a `#rules/<stage>` link waits between the device view that takes it and the machine's list that shows it. */
const ruleLinks = new RuleLinkHold();

/**
 * Accounts' app half (§2.3), built per machine with that machine's client: the Accounts settings tab and the 2FA seed
 * card (half a), the Secure copy settings tab (paste rules, task plans, standing sign-in rules) and the sign-in-approval
 * cards (half b). Beside them, once for the device (shell contract S3): the `#rules/<stage>?machine=…` link
 * `fy rules add` prints, which the shell takes off the address and hands to Accounts' device view.
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      settings: { accounts: accountsTab(client), 'secure-copy': secureCopyTab(client, ruleLinks) },
      renderers: { 'ask:sign-in-approval': signInApprovalRenderer(client) },
    }),
  }),
  {
    fragments: [{ form: 'keyed', key: RULE_FRAGMENT_KEY }],
    device: { 'rule-link': ruleLinkView(ruleLinks) },
  },
);
