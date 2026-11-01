import { describe, it } from 'bun:test';
import {
  DAEMON_FEATURES,
  SIGN_IN_RULE_HONEST_LIMIT,
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_TERMINAL_HONEST_LIMIT,
  type SignInRuleDraft,
  type SignInRuleNarrow,
  type SignInRuleStaged,
  type SignInRuleStageState,
  type SignInRuleView,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import {
  PASTE_RULE_POINTER,
  RULES_FERRET_REFUSAL,
  RulesController,
  ruleWarnings,
} from '../../../src/lib/rules/controller';
import type { IRulesGateway, RulesPorts } from '../../../src/lib/rules/ports';

const STAGE = `srs_${'a'.repeat(24)}`;
const RULE = `sr_${'b'.repeat(24)}`;
const TERMINAL_RULE = `sr_${'c'.repeat(24)}`;
const SIGN_IN = `si_${'1'.repeat(16)}`;
const RED = (text: string): string => `<red>${text}</red>`;

const SITE_VIEW = {
  id: RULE,
  revision: 1,
  signIn: SIGN_IN,
  account: { id: 'GITHUB_WORK', label: 'work github' },
  place: { kind: 'site', domains: ['github.com'], match: [] },
  fields: ['password'],
  totp: false,
  scope: { kind: 'any' },
  createdAt: '2026-11-01T12:00:00.000Z',
  expiresAt: '2026-12-01T12:00:00.000Z',
  status: 'active',
  usage: { count: 0 },
  flags: [],
  approvedWith: { deviceId: `pd_${'1'.repeat(24)}` },
} as unknown as SignInRuleView;

const TERMINAL_VIEW = {
  ...SITE_VIEW,
  id: TERMINAL_RULE,
  place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
  flags: ['root'],
} as unknown as SignInRuleView;

const stagedOf = (overrides: Partial<SignInRuleStaged> = {}): SignInRuleStaged =>
  ({
    stage: STAGE,
    rule: RULE,
    revision: 1,
    signIn: SIGN_IN,
    account: SITE_VIEW.account,
    place: SITE_VIEW.place,
    summary: ['Sign in as GITHUB_WORK at github.com'],
    fields: ['password'],
    totp: false,
    root: false,
    autoRecipe: false,
    scope: { kind: 'any' },
    expiresAt: '2026-12-01T12:00:00.000Z',
    stageExpiresAt: '2026-11-01T12:02:00.000Z',
    ...overrides,
  }) as SignInRuleStaged;

/** Every call the CLI makes, by name: a commit would show up here, and the type has no such method. */
class SpyGateway implements IRulesGateway {
  readonly calls: string[] = [];
  readonly drafts: SignInRuleDraft[] = [];
  readonly narrowed: { readonly rule: string; readonly narrow: SignInRuleNarrow }[] = [];
  readonly revoked: string[] = [];
  rules: SignInRuleView[] = [SITE_VIEW, TERMINAL_VIEW];
  staged: SignInRuleStaged = stagedOf();
  views: (SignInRuleStageState | 'gone')[] = ['waiting', 'approved'];
  reported: string[] = [DAEMON_FEATURES.signInRules, DAEMON_FEATURES.signInRulesTerminal];

  async list() {
    this.calls.push('list');
    return { health: 'ok' as const, rules: this.rules, stages: [] };
  }
  async eligibility(signIn: string) {
    this.calls.push('eligibility');
    return { signIn, eligible: true as const };
  }
  async stage(draft: SignInRuleDraft) {
    this.calls.push('stage');
    this.drafts.push(draft);
    return this.staged;
  }
  async confirmInApp() {
    this.calls.push('confirmInApp');
    return this.staged;
  }
  async view() {
    this.calls.push('view');
    const state = this.views.shift() ?? 'waiting';
    if (state === 'gone') throw new FyHttpError('gone', 404, 'stage_not_found');
    return { ...this.staged, state };
  }
  async drop() {
    this.calls.push('drop');
  }
  async narrow(rule: string, narrow: SignInRuleNarrow) {
    this.calls.push('narrow');
    this.narrowed.push({ rule, narrow });
    return SITE_VIEW;
  }
  async revoke(rule: string) {
    this.calls.push('revoke');
    this.revoked.push(rule);
  }
  async features() {
    this.calls.push('features');
    return this.reported;
  }
}

function rig(overrides: Partial<RulesPorts> = {}) {
  const gateway = new SpyGateway();
  const said: string[] = [];
  const warned: string[] = [];
  const opened: string[] = [];
  let now = Date.parse('2026-11-01T12:00:00.000Z');
  const slept: number[] = [];
  const controller = new RulesController({
    gateway,
    out: { success: message => void said.push(message), diagnostic: message => void warned.push(message) },
    ownSessionId: undefined,
    agentCredential: undefined,
    sleep: async ms => {
      slept.push(ms);
      now += ms;
    },
    nowMs: () => now,
    red: RED,
    appOrigin: 'https://app.example',
    openLink: async url => {
      opened.push(url);
      return true;
    },
    ...overrides,
  });
  return { gateway, controller, said, warned, opened, slept };
}

describe('fy rules (controller)', () => {
  it('should refuse every command inside a ferret pane or with an agent credential, before any call', async () => {
    for (const caller of [{ ownSessionId: 's1' }, { agentCredential: 'cap' }]) {
      const { controller, gateway } = rig(caller);
      for (const run of [
        async () => await controller.list({}),
        async () => await controller.add(SIGN_IN, {}),
        async () => await controller.resume(RULE, {}),
        async () => await controller.renew(RULE, {}),
        async () => await controller.narrow(RULE, { dropTotp: true }),
        async () => await controller.remove(RULE, {}),
      ])
        await run().then(
          () => should.fail('', '', 'a ferret got through'),
          (error: unknown) => should((error as Error).message).equal(RULES_FERRET_REFUSAL),
        );
      should(gateway.calls).eql([]);
    }
  });

  it('should list rules with their warnings drawn from the flags', async () => {
    const { controller, said } = rig();
    await controller.list({});
    const text = said.join('\n');
    should(text).containEql(RULE).and.containEql('github.com');
    should(text).containEql(RED(SIGN_IN_RULE_ROOT_WARNING));
    should(text).containEql(SIGN_IN_RULE_TERMINAL_HONEST_LIMIT);
    should(text).containEql(SIGN_IN_RULE_HONEST_LIMIT);
  });

  it('should render the root warning and the residual sentence from the structured root flag, not the summary', () => {
    const lines = ruleWarnings({ root: true, totp: false }, RED);
    should(lines).containEql(RED(SIGN_IN_RULE_ROOT_WARNING));
    should(lines).containEql(SIGN_IN_RULE_TERMINAL_HONEST_LIMIT);
    should(ruleWarnings({ root: false, totp: false }, RED)).eql([SIGN_IN_RULE_HONEST_LIMIT]);
  });

  it('should print the red root warning on a staged terminal rule even when its summary says nothing of root', async () => {
    const { controller, gateway, said } = rig();
    gateway.staged = stagedOf({
      root: true,
      place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
      summary: ['Type the password at the prompt'],
    });
    await controller.add(SIGN_IN, {});
    const text = said.join('\n');
    should(text).containEql(RED(SIGN_IN_RULE_ROOT_WARNING));
    should(text).containEql(SIGN_IN_RULE_TERMINAL_HONEST_LIMIT);
  });

  it('should drop a terminal stage and stage nothing while the daemon does not report terminal rules', async () => {
    const { controller, gateway } = rig();
    gateway.reported = [DAEMON_FEATURES.signInRules];
    gateway.staged = stagedOf({ root: true, place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' } });
    await controller.add(SIGN_IN, {}).then(
      () => should.fail('', '', 'a terminal rule was offered'),
      (error: unknown) => should((error as Error).message).containEql('terminal rules'),
    );
    should(gateway.calls).containEql('drop').and.not.containEql('confirmInApp');
  });

  it('should stage nothing while the daemon does not report sign-in rules', async () => {
    const { controller, gateway } = rig();
    gateway.reported = [];
    await controller.add(SIGN_IN, {}).then(
      () => should.fail('', '', 'staged'),
      (error: unknown) => should((error as Error).message).containEql('does not report them yet'),
    );
    should(gateway.calls).not.containEql('stage');
  });

  it('should stage, print the app link, wait and report Approved, never committing', async () => {
    const { controller, gateway, said, slept } = rig();
    await controller.add(SIGN_IN, { scope: 'any', expires: '7d', uses: '5' });
    should(gateway.drafts).eql([
      { signIn: SIGN_IN, fields: ['password'], scope: { kind: 'any' }, lifetimeSeconds: 7 * 86_400, uses: 5 },
    ]);
    should(gateway.calls).eql(['features', 'stage', 'confirmInApp', 'view', 'view']);
    should(said.join('\n')).containEql(`https://app.example/#rules/${STAGE}`);
    should(said[said.length - 1]).startWith('Approved.');
    should(slept).eql([1_000]);
    should(Object.keys(Object.getPrototypeOf(gateway)).filter(name => /commit/iu.test(name))).eql([]);
  });

  it('should report Denied, and Timed out when the stage vanishes or the wait runs out', async () => {
    const denied = rig();
    denied.gateway.views = ['denied'];
    await denied.controller.add(SIGN_IN, {});
    should(denied.said[denied.said.length - 1]).startWith('Denied.');

    const gone = rig();
    gone.gateway.views = ['gone'];
    await gone.controller.add(SIGN_IN, {});
    should(gone.said[gone.said.length - 1]).startWith('Timed out.');

    const slow = rig();
    slow.gateway.views = Array.from({ length: 500 }, () => 'waiting' as const);
    await slow.controller.add(SIGN_IN, {});
    should(slow.said[slow.said.length - 1]).startWith('Timed out.');
    should(slow.slept.reduce((sum, ms) => sum + ms, 0)).be.within(120_000, 130_000);
  });

  it('should open the link with --open and say so when no browser opens', async () => {
    const { controller, opened, said } = rig();
    await controller.add(SIGN_IN, { open: true });
    should(opened).eql([`https://app.example/#rules/${STAGE}`]);
    should(said.join('\n')).containEql('Opened it in your browser.');

    const none = rig({ openLink: async () => false });
    await none.controller.add(SIGN_IN, { open: true });
    should(none.said.join('\n')).containEql('Could not open a browser here');
  });

  it('should print no link without an app address', async () => {
    const { controller, said } = rig({ appOrigin: undefined });
    await controller.add(SIGN_IN, { open: true });
    should(said.join('\n')).containEql('nowhere to open').and.not.containEql('#rules/');
  });

  it('should require --i-understand-one-factor with --totp, before anything is staged', async () => {
    const { controller, gateway } = rig();
    await controller.add(SIGN_IN, { totp: true }).then(
      () => should.fail('', '', 'a code was staged'),
      (error: unknown) => should((error as Error).message).containEql('--i-understand-one-factor'),
    );
    await controller.add(SIGN_IN, { iUnderstandOneFactor: true }).then(
      () => should.fail('', '', 'staged'),
      (error: unknown) => should((error as Error).message).containEql('goes with --totp'),
    );
    should(gateway.calls).eql([]);
    await controller.add(SIGN_IN, { totp: true, iUnderstandOneFactor: true, username: true });
    should(gateway.drafts[0]).eql({
      signIn: SIGN_IN,
      fields: ['username', 'password'],
      totp: true,
      totpAcknowledged: true,
    });
  });

  it('should refuse a name that is not a sign-in id', async () => {
    const { controller, gateway } = rig();
    await controller.add('github', {}).then(
      () => should.fail('', '', 'staged'),
      (error: unknown) => should((error as Error).message).containEql('si_'),
    );
    should(gateway.calls).eql([]);
  });

  it('should renew a rule as the same rule with a new lifetime, and resume only a suspended one', async () => {
    const { controller, gateway } = rig();
    await controller.renew(RULE.slice(0, 8), { expires: '2d' });
    should(gateway.drafts[0]).eql({
      signIn: SIGN_IN,
      fields: ['password'],
      scope: { kind: 'any' },
      lifetimeSeconds: 2 * 86_400,
      replaces: RULE,
    });
    await controller.resume(RULE, {}).then(
      () => should.fail('', '', 'resumed an active rule'),
      (error: unknown) => should((error as Error).message).containEql('not suspended'),
    );
    gateway.rules = [
      {
        ...SITE_VIEW,
        status: 'suspended',
        suspended: { at: '2026-11-01T11:00:00.000Z', because: 'drift' },
      } as unknown as SignInRuleView,
    ];
    await controller.resume(RULE, {});
    should(gateway.drafts[1]?.replaces).equal(RULE);
  });

  it('should drop the code on a renew unless it is asked for again, and say so', async () => {
    const { controller, gateway, said } = rig();
    gateway.rules = [
      { ...SITE_VIEW, fields: ['password', 'totp'], totp: true, flags: ['one-factor'] } as unknown as SignInRuleView,
    ];
    await controller.renew(RULE, {});
    should(gateway.drafts[0]?.totp).equal(undefined);
    should(said.join('\n')).containEql('drops the code');
    await controller.renew(RULE, { totp: true, iUnderstandOneFactor: true });
    should(gateway.drafts[1]).containEql({ totp: true, totpAcknowledged: true });
  });

  it('should narrow without a passkey, from now', async () => {
    const { controller, gateway } = rig();
    await controller.narrow(RULE, { dropTotp: true, expires: '2h', uses: '3' });
    should(gateway.narrowed).eql([
      { rule: RULE, narrow: { dropTotp: true, expiresAt: '2026-11-01T14:00:00.000Z', uses: 3 } },
    ]);
    await controller.narrow(RULE, {}).then(
      () => should.fail('', '', 'narrowed nothing'),
      (error: unknown) => should((error as Error).message).containEql('narrow the code'),
    );
  });

  it('should end a rule by the start of its id, and point a paste rule id to fy copy rules rm', async () => {
    const { controller, gateway } = rig();
    await controller.remove(RULE.slice(0, 10), {});
    should(gateway.revoked).eql([RULE]);
    await controller.remove('a1b2c3d4', {}).then(
      () => should.fail('', '', 'revoked'),
      (error: unknown) => should((error as Error).message).equal(PASTE_RULE_POINTER),
    );
    should(PASTE_RULE_POINTER).containEql('fy copy rules rm');
    should(gateway.revoked).eql([RULE]);
  });
});
