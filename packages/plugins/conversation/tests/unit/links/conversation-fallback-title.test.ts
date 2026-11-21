import { describe, expect, test } from 'bun:test';
import { deriveTitle, fileTitle, type ScrubText } from '../../../daemon/links/lib/conversation-title.ts';

/**
 * THE FALLBACK TITLE (r11-2b K11): what a conversation is called until the harness writes its own title. It must read as a task:
 * no opening filler, never ending on a word that only joins others, and no joining across a place where a secret was scrubbed.
 *
 * The ten prompts are the owner-gate evidence (`gate-r11-2/evidence/titles-10.json`). Every secret is FAKE.
 */

/** A fake vault that knows one value (masked as the kernel's redaction masks it). */
const VAULT_VALUE = 'fake-vault-value-7f3a9c21d4';
const vault: ScrubText = text => text.split(VAULT_VALUE).join('[redacted:BILLING_KEY]');
const NO_VAULT: ScrubText = text => text;

/** A fake token, spelled in two pieces so no whole literal of one is committed. */
const FAKE_TOKEN = `${'ghp_'}aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6`;

const PROMPTS: readonly (readonly [prompt: string, title: string])[] = [
  [
    'hey can you look at why the deploy script keeps failing on the staging box, I think it is the env file',
    'Deploy Script Keeps Failing',
  ],
  ['Fix the flaky login test in packages/auth, it fails about one in five runs on CI', 'Fix the Flaky Login Test'],
  [
    'please add a dark mode toggle to the settings page and make sure it remembers the choice',
    'Add a Dark Mode Toggle',
  ],
  [`Here is my key ${VAULT_VALUE} use it to call the billing api and list last month invoices`, 'Call the Billing Api'],
  ['what is the difference between a worktree and a clone? explain briefly', 'Difference Between a Worktree'],
  [
    'Refactor the payment retry logic so it uses exponential backoff, and add tests for the three failure modes we saw last week in production',
    'Refactor the Payment Retry Logic',
  ],
  [
    'ok so I want to rename the project folder cards to say Projects, can you do that and open a PR',
    'Rename the Project Folder Cards',
  ],
  [`Use token ${FAKE_TOKEN} to push the branch then write release notes`, 'Push the Branch Then Write'],
  [
    'Investigate the memory leak in the daemon after 6 hours uptime. Start with heap snapshots.',
    'Investigate the Memory Leak',
  ],
  ['hi', 'Hi'],
];

const JOINING_END =
  /(?:^|\s)(?:the|to|a|an|of|between|is|are|and|or|my|at|why|how|what|in|on|for|with|by|it|that|this)$/iu;
const LEADING_FILLER =
  /^(?:i want to|i need to|i'd like to|can you|could you|please|here is my|here's my|hey|ok|so)\b/iu;

describe('the fallback title of the ten gate prompts', () => {
  for (const [prompt, expected] of PROMPTS) {
    test(`“${prompt.slice(0, 40)}…” reads as “${expected}”`, () => {
      const title = deriveTitle(prompt, vault);
      expect(title).toBe(expected);
      expect((title ?? '').length).toBeLessThanOrEqual(60);
      expect(title).not.toMatch(JOINING_END);
      expect(title).not.toMatch(LEADING_FILLER);
      expect(title).not.toContain(VAULT_VALUE);
      expect(title).not.toContain(FAKE_TOKEN);
      expect(title).not.toMatch(/redacted|ghp_|[[\]]/u);
    });
  }
});

describe('where a secret was scrubbed', () => {
  test('the words around the hole are not joined across it', () => {
    const title = deriveTitle(`Use token ${FAKE_TOKEN} to push the branch`, NO_VAULT);
    expect(title).toBe('Push the Branch');
    expect(title).not.toMatch(/Use/u);
  });

  test('a hole at the end leaves the sentence before it', () => {
    expect(deriveTitle(`Fix the flaky login test, here is the key ${FAKE_TOKEN}`, NO_VAULT)).toBe(
      'Fix the Flaky Login Test',
    );
  });

  test('a message that is nothing but the secret and joining words gives no title', () => {
    expect(deriveTitle(`Here is my key ${FAKE_TOKEN}`, NO_VAULT)).toBeUndefined();
  });
});

describe('a title the harness wrote still wins', () => {
  test('the CLI’s own name is used, the first words are not read', () => {
    expect(
      fileTitle({ name: 'Billing invoices', firstMessage: 'what is the difference between a and b' }, NO_VAULT),
    ).toBe('Billing invoices');
  });
});
