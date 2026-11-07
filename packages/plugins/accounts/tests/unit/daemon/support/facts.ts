/** What the Vault saw at a sudo prompt: today's `tests/unit/input-requests/support.ts` fixture (bb89d054d). */
import type { InputTargetFacts } from '@ferretry/core-vault/contract';

export const SESSION = 'mvv6b4qw-49d0158d';

export const FACTS: Extract<InputTargetFacts, { readonly kind: 'terminal' }> = {
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
  foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -v' },
  echo: 'off',
  cursorRow: 1,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: 'a'.repeat(64),
  program: 'sudo',
  canonical: true,
  recognisedConsumer: true,
};
