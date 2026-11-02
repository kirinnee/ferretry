import { describe, it } from 'bun:test';
import should from 'should';
import { TWO_FACTOR_STAGE_TTL_SECONDS } from '../../src/lib/accounts.ts';
import { durationWords, timesWords } from '../../src/lib/common.ts';
import {
  AUTOMATED_CODE_ACK_WORDS,
  AUTOMATED_CODE_WARNING,
  LOGIN_ONE_FACTOR_WARNING,
  LOGIN_TOTP_WARNING,
} from '../../src/lib/login-entries.ts';
import { PAIRING_CODE_LIFETIME_WORDS, PAIRING_CODE_TTL_SECONDS } from '../../src/lib/pairing.ts';
import {
  DAY_SECONDS,
  SIGN_IN_RULE_AUTO_RECIPE_WARNING,
  SIGN_IN_RULE_DEFAULT_DAYS,
  SIGN_IN_RULE_HISTORY_TAPS,
  SIGN_IN_RULE_INELIGIBLE_WORDS,
  SIGN_IN_RULE_MAX_DAYS,
  SIGN_IN_RULE_TERMINAL_DEFAULT_DAYS,
  SIGN_IN_RULE_TERMINAL_MAX_DAYS,
  SIGN_IN_RULE_TOTP_WARNING,
  ruleDeepLink,
  ruleDeepLinkFragment,
  ruleDeepLinkFromFragment,
  signInRuleDayChoices,
  signInRuleLifetime,
  signInRuleSurfaceOf,
} from '../../src/lib/sign-in-rules.ts';
import { PASSKEY_CHALLENGE_TTL_SECONDS } from '../../src/lib/step-up.ts';
import {
  agendaDeepLinkFragment,
  agendaDeepLinkFromFragment,
  STILL_ASKED_ITEMS,
  stillAskedFor,
  TASK_PLAN_FIRST_FILL_WORDS,
  type TaskPlanCandidate,
  taskPlanLineFirstFill,
  taskPlanRootBadge,
  taskPlanRootHost,
  taskPlanRootWords,
} from '../../src/lib/task-plan.ts';

/** One source per fact (credentials consistency audit, PR 1): each sentence and number has one owner here. */

const STAGE = `srs_${'2'.repeat(24)}`;
const MACHINE = `fy_daemon_${'a'.repeat(43)}`;

describe('one source per fact: durations and counts in words', () => {
  it('should say a span from its constant, in minutes when it is whole minutes', () => {
    should(durationWords(120)).equal('two minutes');
    should(durationWords(60)).equal('one minute');
    should(durationWords(90)).equal('90 seconds');
    should(durationWords(1)).equal('one second');
    should(durationWords(900)).equal('15 minutes');
  });

  it('should say a count of times', () => {
    should(timesWords(1)).equal('once');
    should(timesWords(2)).equal('twice');
    should(timesWords(3)).equal('3 times');
  });

  it('should build the pairing code life and the 2FA stage life from their owners', () => {
    should(PAIRING_CODE_LIFETIME_WORDS).equal(durationWords(PAIRING_CODE_TTL_SECONDS));
    should(PAIRING_CODE_LIFETIME_WORDS).equal('two minutes');
    should(TWO_FACTOR_STAGE_TTL_SECONDS).equal(PASSKEY_CHALLENGE_TTL_SECONDS);
  });

  it('should say the history a rule needs from the number of taps', () => {
    should(SIGN_IN_RULE_INELIGIBLE_WORDS['no-history']).equal(
      `Sign in yourself ${timesWords(SIGN_IN_RULE_HISTORY_TAPS)} from the app first`,
    );
    should(SIGN_IN_RULE_INELIGIBLE_WORDS['no-history']).equal('Sign in yourself twice from the app first');
  });
});

describe('one source per fact: the code and recipe warnings', () => {
  it('should give a plan line and a rule the same one-factor sentence, never the key-saving one', () => {
    should(SIGN_IN_RULE_TOTP_WARNING).equal(AUTOMATED_CODE_WARNING);
    should(AUTOMATED_CODE_WARNING).not.equal(LOGIN_TOTP_WARNING);
    should(AUTOMATED_CODE_WARNING).not.equal(LOGIN_ONE_FACTOR_WARNING);
    should(AUTOMATED_CODE_ACK_WORDS).equal(
      'I understand this makes the sign-in one factor, with no one to approve a code.',
    );
  });

  it('should call the saved secret a 2FA key, never a seed, where a person reads it', () => {
    should(LOGIN_TOTP_WARNING).containEql('2FA key');
    should(LOGIN_TOTP_WARNING).not.containEql('seed');
  });

  it('should carry the auto-recipe line, word for word', () => {
    should(SIGN_IN_RULE_AUTO_RECIPE_WARNING).equal(
      'This sign-in applies its recipe by itself, so the form it fills is one a ferret may have written.',
    );
  });
});

describe('one source per fact: rule lifetimes and surfaces', () => {
  it('should export the day and build each surface’s choices from its default and its most', () => {
    should(DAY_SECONDS).equal(86_400);
    should(signInRuleLifetime('page').defaultDays).equal(SIGN_IN_RULE_DEFAULT_DAYS);
    should(signInRuleLifetime('terminal').defaultDays).equal(SIGN_IN_RULE_TERMINAL_DEFAULT_DAYS);
    should(signInRuleDayChoices('terminal')).deepEqual([
      SIGN_IN_RULE_TERMINAL_DEFAULT_DAYS,
      SIGN_IN_RULE_TERMINAL_MAX_DAYS,
    ]);
    should(signInRuleDayChoices('page')).deepEqual([7, SIGN_IN_RULE_DEFAULT_DAYS, SIGN_IN_RULE_MAX_DAYS]);
    for (const surface of ['page', 'terminal'] as const)
      for (const days of signInRuleDayChoices(surface))
        should(days * DAY_SECONDS).be.belowOrEqual(signInRuleLifetime(surface).maxSeconds);
  });

  it('should decide a rule’s surface from its place, once', () => {
    should(signInRuleSurfaceOf({ kind: 'site' })).equal('page');
    should(signInRuleSurfaceOf({ kind: 'terminal' })).equal('terminal');
  });
});

describe('one source per fact: the links the CLI prints and the app reads', () => {
  it('should round-trip a rule link, with and without its machine', () => {
    // Arrange
    const plain = ruleDeepLinkFragment(STAGE as never);
    const onMachine = ruleDeepLinkFragment(STAGE as never, MACHINE as never);

    // Act / Assert
    should(plain).equal(`#rules/${STAGE}`);
    should(ruleDeepLinkFromFragment(plain)).deepEqual({ stage: STAGE });
    should(ruleDeepLinkFromFragment(onMachine)).deepEqual({ stage: STAGE, machine: MACHINE });
    should(ruleDeepLink('https://ferretry.pages.dev//', STAGE as never)).equal(
      `https://ferretry.pages.dev/#rules/${STAGE}`,
    );
  });

  it('should read no rule from any other fragment', () => {
    for (const fragment of [
      '#rules/',
      '#rules/not-a-stage',
      `#rules/${STAGE}/more`,
      `#rules/${STAGE}?machine=not-a-daemon`,
      `#agenda/${STAGE}`,
      '#rules/%E0%A4%A',
      '',
    ])
      should(ruleDeepLinkFromFragment(fragment)).be.null();
  });

  it('should round-trip an agenda link, and read nothing else', () => {
    should(agendaDeepLinkFromFragment(agendaDeepLinkFragment('A12', 'mvx-1'))).deepEqual({
      id: 'A12',
      sessionId: 'mvx-1',
    });
    should(agendaDeepLinkFromFragment(agendaDeepLinkFragment('A12'))).deepEqual({ id: 'A12' });
    should(agendaDeepLinkFromFragment(`#rules/${STAGE}`)).be.null();
    should(agendaDeepLinkFromFragment('#agenda/%E0%A4%A')).be.null();
  });
});

describe('one source per fact: task-plan words', () => {
  const candidate = (signIn: string, history: boolean): TaskPlanCandidate => ({
    signIn: signIn as TaskPlanCandidate['signIn'],
    account: { id: 'GITHUB_KIRINNEE', label: 'GitHub' },
    place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
    can: { username: false, password: true, totp: false },
    history,
  });
  const line = {
    flags: ['no-history'] as const,
    candidates: [candidate('si_000000000000000a', true), candidate('si_000000000000000b', false)],
  };

  it('should key the first-fill line on the picked account, and on the line flag while none is', () => {
    should(TASK_PLAN_FIRST_FILL_WORDS).startWith('First time Ferretry fills this sign-in');
    should(taskPlanLineFirstFill(line)).be.true();
    should(taskPlanLineFirstFill(line, 'si_000000000000000a' as never)).be.false();
    should(taskPlanLineFirstFill(line, 'si_000000000000000b' as never)).be.true();
    should(taskPlanLineFirstFill({ ...line, flags: [] })).be.false();
  });

  it('should say root on the one host a line types at', () => {
    should(taskPlanRootHost([{ kind: 'terminal', tool: 'sudo', host: 'kirin-box' }])).equal('kirin-box');
    should(
      taskPlanRootHost([
        { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
        { kind: 'terminal', tool: 'su', host: 'pebox' },
      ]),
    ).be.undefined();
    should(taskPlanRootWords('kirin-box')).equal('this gives the ferret root on kirin-box');
    should(taskPlanRootBadge(undefined)).equal('root on this machine');
  });

  it('should list what a plan and a rule still ask, from one list', () => {
    const plan = stillAskedFor('plan').map(item => item.what);
    const rule = stillAskedFor('rule').map(item => item.what);
    const shared = STILL_ASKED_ITEMS.filter(item => item.for === 'both').map(item => item.what);
    for (const what of shared) {
      should(plan).containEql(what);
      should(rule).containEql(what);
    }
    should(rule).not.containEql('A paste that would replace a secret the store already holds');
    should(plan).not.containEql('A sign-in whose form changed since you approved it');
  });
});
