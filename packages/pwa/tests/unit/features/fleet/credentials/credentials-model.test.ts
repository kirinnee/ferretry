import { describe, expect, it } from 'bun:test';
import type { FleetCredentialList } from '@ferretry/protocol';
import {
  credentialEmail,
  credentialExplanation,
  credentialName,
  credentialsOf,
  credentialUse,
  finishSignInLabel,
  HARNESS_COMMANDS,
  HARNESS_SHORT,
  HARNESSES,
  hasSharedEmails,
  labelsError,
  nextCredentialId,
  otherHarness,
  plural,
  sameEmailLogin,
  signedInSentence,
  signInCoverage,
  slotBadge,
  terminalBadge,
  type UsageBar,
  usageBars,
  usageBarText,
} from '../../../../../src/features/fleet/credentials/credentials-model.ts';
import { CREDENTIALS, credential, NOW, withStatus } from '../account-support.ts';

const byId = (id: string) => {
  const found = CREDENTIALS.credentials.find(entry => entry.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

const listOf = (...credentials: ReturnType<typeof credential>[]): FleetCredentialList => ({
  ...CREDENTIALS,
  credentials,
});

describe('harness names', () => {
  it('names each harness for a person, a sentence and a terminal', () => {
    expect(HARNESSES).toEqual(['claude', 'codex']);
    expect(HARNESS_SHORT).toEqual({ claude: 'Claude', codex: 'Codex' });
    expect(HARNESS_COMMANDS).toEqual({ claude: 'claude', codex: 'codex' });
  });

  it('finds the other harness', () => {
    expect(otherHarness('claude')).toBe('codex');
    expect(otherHarness('codex')).toBe('claude');
  });

  it('pluralises with the default and a custom plural', () => {
    expect(plural(1, 'runtime')).toBe('1 runtime');
    expect(plural(0, 'runtime')).toBe('0 runtimes');
    expect(plural(3, 'runtime')).toBe('3 runtimes');
    expect(plural(2, 'person', 'people')).toBe('2 people');
    expect(plural(1, 'person', 'people')).toBe('1 person');
  });
});

describe('how a login is named', () => {
  it('uses the email, or says which harness has not told us one', () => {
    expect(credentialEmail(credential({ id: 'a' }))).toBe('you@example.com');
    expect(credentialEmail(credential({ id: 'a', harness: 'claude', email: undefined }))).toBe('Claude Code login');
    expect(credentialEmail(credential({ id: 'a', harness: 'codex', email: undefined }))).toBe('Codex login');
  });

  it('adds the label in brackets when there is one', () => {
    expect(credentialName(credential({ id: 'a', label: 'work' }))).toBe('you@example.com (work)');
    expect(credentialName(credential({ id: 'a' }))).toBe('you@example.com');
    expect(credentialName(credential({ id: 'a', email: undefined, label: 'work' }))).toBe('Claude Code login (work)');
  });

  it('says how many runtimes use it', () => {
    expect(credentialUse(credential({ id: 'a' }))).toBe('Not used yet');
    expect(credentialUse(credential({ id: 'a', usedBy: ['one'] }))).toBe('Used by 1 runtime');
    expect(credentialUse(credential({ id: 'a', usedBy: ['one', 'two', 'three'] }))).toBe('Used by 3 runtimes');
  });
});

describe('badges', () => {
  it('says a login is shared with the terminal, with that harness command', () => {
    expect(terminalBadge(credential({ id: 'a', sharedWithTerminal: true }))).toBe(
      'Shared with claude in your terminal',
    );
    expect(terminalBadge(credential({ id: 'a', harness: 'codex', sharedWithTerminal: true }))).toBe(
      'Shared with codex in your terminal',
    );
    expect(terminalBadge(credential({ id: 'a' }))).toBeNull();
  });

  it('says where an empty slot was copied from', () => {
    expect(slotBadge(credential({ id: 'a', clonedFrom: 'studio-mac' }))).toBe('Copied slot from studio-mac');
    expect(slotBadge(credential({ id: 'a' }))).toBeNull();
  });
});

describe('credentialExplanation', () => {
  it('explains an empty slot that a clone made', () => {
    expect(
      credentialExplanation(credential({ id: 'a', clonedFrom: 'studio-mac', ...withStatus('needs_sign_in') })),
    ).toBe(
      'Empty slot. It was copied from studio-mac without the login itself. Sign in once and every runtime that uses it can launch.',
    );
  });

  it('otherwise gives the daemon’s own sentence', () => {
    const needsSignIn = credential({ id: 'a', ...withStatus('needs_sign_in') });
    expect(credentialExplanation(needsSignIn)).toBe(needsSignIn.status.explanation);
    const cloned = credential({ id: 'a', clonedFrom: 'studio-mac' });
    expect(credentialExplanation(cloned)).toBe('Ready. Checked a few minutes ago.');
  });
});

describe('sign-in words', () => {
  it('counts the runtimes one sign-in finishes', () => {
    expect(finishSignInLabel(credential({ id: 'a' }))).toBe('Finish sign-in');
    expect(finishSignInLabel(credential({ id: 'a', usedBy: ['one'] }))).toBe('Finish sign-in');
    expect(finishSignInLabel(credential({ id: 'a', usedBy: ['one', 'two', 'three'] }))).toBe(
      'Finish sign-in for 3 runtimes',
    );
  });

  it('says what a sign-in covers on a machine', () => {
    expect(signInCoverage(credential({ id: 'a' }), 'studio-mac')).toBe(
      'The login is kept on studio-mac. Nothing uses it yet.',
    );
    expect(signInCoverage(credential({ id: 'a', usedBy: ['one'] }), 'studio-mac')).toBe(
      'The login is kept on studio-mac. Every runtime that uses it (1 runtime) can launch once it is done.',
    );
    expect(signInCoverage(credential({ id: 'a', usedBy: ['one', 'two'] }), 'studio-mac')).toBe(
      'The login is kept on studio-mac. Every runtime that uses it (2 runtimes) can launch once it is done.',
    );
  });

  it('says how many runtimes can launch after a sign-in', () => {
    expect(signedInSentence(0)).toBe('Signed in.');
    expect(signedInSentence(1)).toBe('Signed in. 1 runtime can launch now.');
    expect(signedInSentence(3)).toBe('Signed in. 3 runtimes can launch now.');
  });
});

describe('usage bars', () => {
  const bars = (usage: ReturnType<typeof credential>['usage']): readonly UsageBar[] | null =>
    usageBars(credential({ id: 'a', usage }), NOW);

  it('draws both windows with whole percents, reset times and a warning at 80%', () => {
    expect(usageBars(byId('claude-personal'), NOW)).toEqual([
      { label: '5h', percent: 38, resets: 'resets in 2h', high: false },
      { label: 'Week', percent: 83, resets: 'resets in 3d', high: true },
    ]);
  });

  it('rounds, caps at 100% and treats exactly 80% as high', () => {
    expect(bars({ fiveHour: { usedPercent: 79.6 }, weekly: { usedPercent: 250 } })).toEqual([
      { label: '5h', percent: 80, resets: null, high: true },
      { label: 'Week', percent: 100, resets: null, high: true },
    ]);
    expect(bars({ fiveHour: { usedPercent: 79.4 }, weekly: { usedPercent: 0 } })).toEqual([
      { label: '5h', percent: 79, resets: null, high: false },
      { label: 'Week', percent: 0, resets: null, high: false },
    ]);
  });

  it('keeps an unmeasured window as "not measured", never as zero', () => {
    expect(bars({ fiveHour: { usedPercent: 10 }, weekly: {} })).toEqual([
      { label: '5h', percent: 10, resets: null, high: false },
      { label: 'Week', percent: null, resets: null, high: false },
    ]);
  });

  it('says "resets now" for a reset that is due', () => {
    expect(
      bars({
        fiveHour: { usedPercent: 50, resetsAt: '2026-10-13T07:00:00.000Z' },
        weekly: { usedPercent: 50, resetsAt: 'not a date' },
      }),
    ).toEqual([
      { label: '5h', percent: 50, resets: 'resets now', high: false },
      { label: 'Week', percent: 50, resets: null, high: false },
    ]);
  });

  it('returns nothing when neither window was measured', () => {
    expect(bars({ fiveHour: {}, weekly: {} })).toBeNull();
    expect(usageBars(byId('codex'), NOW)).toBeNull();
  });

  it('words each bar so its direction cannot be misread', () => {
    expect(usageBarText({ label: '5h', percent: null, resets: null, high: false })).toBe('5h: not measured yet');
    expect(usageBarText({ label: '5h', percent: 38, resets: null, high: false })).toBe('5h: 38% used');
    expect(usageBarText({ label: 'Week', percent: 83, resets: 'resets in 3d', high: true })).toBe(
      'Week: 83% used · resets in 3d',
    );
  });
});

describe('lists of logins', () => {
  it('filters by harness in the order the daemon listed them', () => {
    expect(credentialsOf(CREDENTIALS, 'claude').map(entry => entry.id)).toEqual(['claude-personal', 'claude-work']);
    expect(credentialsOf(CREDENTIALS, 'codex').map(entry => entry.id)).toEqual(['codex']);
    expect(credentialsOf(listOf(), 'claude')).toEqual([]);
  });

  it('knows when emails are shared, from a flag or from the logins themselves', () => {
    expect(hasSharedEmails(CREDENTIALS)).toBe(true);
    expect(hasSharedEmails(listOf(credential({ id: 'a', needsLabel: true })))).toBe(true);
    expect(
      hasSharedEmails(listOf(credential({ id: 'a', email: 'a@x.test' }), credential({ id: 'b', email: 'b@x.test' }))),
    ).toBe(false);
    expect(
      hasSharedEmails(listOf(credential({ id: 'a', email: undefined }), credential({ id: 'b', email: undefined }))),
    ).toBe(false);
    expect(hasSharedEmails(listOf())).toBe(false);
  });

  it('does not call one email on two harnesses shared', () => {
    expect(
      hasSharedEmails(
        listOf(
          credential({ id: 'a', email: 'a@x.test' }),
          credential({ id: 'b', harness: 'codex', email: 'a@x.test' }),
        ),
      ),
    ).toBe(false);
  });

  it('finds another login of this harness with the same email', () => {
    const one = credential({ id: 'one' });
    const two = credential({ id: 'two' });
    const list = listOf(one, credential({ id: 'cx', harness: 'codex' }), two);
    expect(sameEmailLogin(list, one)?.id).toBe('two');
    expect(sameEmailLogin(listOf(one), one)).toBeUndefined();
    expect(sameEmailLogin(listOf(one, credential({ id: 'cx', harness: 'codex' })), one)).toBeUndefined();
    expect(sameEmailLogin(listOf(one, credential({ id: 'x', email: 'other@x.test' })), one)).toBeUndefined();
    const unknown = credential({ id: 'u', email: undefined });
    expect(sameEmailLogin(listOf(unknown, credential({ id: 'v', email: undefined })), unknown)).toBeUndefined();
  });
});

describe('labelsError', () => {
  it('asks for both labels, and for two different ones', () => {
    expect(labelsError('', 'work')).toBe('Give each login a label.');
    expect(labelsError('home', '   ')).toBe('Give each login a label.');
    expect(labelsError(' work ', 'work')).toBe('Use two different labels.');
    expect(labelsError('home', 'work')).toBeNull();
  });
});

describe('nextCredentialId', () => {
  it('uses the bare harness name when it is free', () => {
    expect(nextCredentialId(null, 'claude')).toBe('claude');
    expect(nextCredentialId(listOf(), 'codex')).toBe('codex');
    expect(nextCredentialId(listOf(credential({ id: 'claude-2' })), 'claude')).toBe('claude');
  });

  it('numbers past every id this machine already has', () => {
    expect(nextCredentialId(listOf(credential({ id: 'claude' })), 'claude')).toBe('claude-2');
    expect(
      nextCredentialId(
        listOf(credential({ id: 'claude' }), credential({ id: 'claude-2' }), credential({ id: 'claude-3' })),
        'claude',
      ),
    ).toBe('claude-4');
    expect(nextCredentialId(CREDENTIALS, 'codex')).toBe('codex-2');
  });
});
