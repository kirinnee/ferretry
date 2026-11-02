/** Fake standing sign-in rules for tests and screenshots: every one is parsed by the protocol's own schema. */

import {
  type Place,
  type SignInRuleList,
  SignInRuleListSchema,
  type SignInRuleStaged,
  SignInRuleStagedSchema,
  type SignInRuleSuggestionView,
  SignInRuleSuggestionViewSchema,
  type SignInRuleView,
  SignInRuleViewSchema,
  signInRuleWords,
} from '@ferretry/protocol';

export const RULE_ID = `sr_${'a'.repeat(24)}`;
const RULE_ID_2 = `sr_${'b'.repeat(24)}`;
export const STAGE_ID = `srs_${'c'.repeat(24)}` as const;
const SUGGESTION_ID = 'srg_dddddddddddddddd';
export const SITE_SIGN_IN = 'si_0000000000000001';
const SUDO_SIGN_IN = 'si_0000000000000003';
const CREATED = '2026-10-30T09:00:00.000Z';
const EXPIRES = '2026-11-29T09:00:00.000Z';
const STAGE_EXPIRES = '2026-11-01T10:00:00.000Z';

export const sitePlace: Place = { kind: 'site', domains: ['github.com'], match: [] };
export const sudoPlace: Place = { kind: 'terminal', tool: 'sudo', host: 'kirin-box' };

const usage = { count: 0 };
const device = { deviceId: 'fy_device_id_AAAAAAAAAAAAAAAAAAAAAA', device: 'Kirin’s phone' };

export const pageRule = (extra: Partial<SignInRuleView> = {}): SignInRuleView =>
  SignInRuleViewSchema.parse({
    id: RULE_ID,
    revision: 1,
    signIn: SITE_SIGN_IN,
    account: { id: 'GITHUB_WORK', label: 'github work' },
    username: 'kirin@atomi.cloud',
    place: sitePlace,
    fields: ['username', 'password'],
    totp: false,
    scope: { kind: 'any' },
    createdAt: CREATED,
    expiresAt: EXPIRES,
    status: 'active',
    usage,
    flags: [],
    approvedWith: device,
    ...extra,
  });

export const codeRule = (): SignInRuleView =>
  pageRule({ fields: ['username', 'password', 'totp'], totp: true, flags: ['one-factor'], uses: 5, remaining: 4 });

export const terminalRule = (extra: Partial<SignInRuleView> = {}): SignInRuleView =>
  SignInRuleViewSchema.parse({
    id: RULE_ID_2,
    revision: 1,
    signIn: SUDO_SIGN_IN,
    account: { id: 'SUDO_BOX', label: 'kirin' },
    username: 'kirin',
    place: sudoPlace,
    fields: ['password'],
    totp: false,
    scope: { kind: 'any' },
    createdAt: CREATED,
    expiresAt: '2026-11-02T09:00:00.000Z',
    status: 'active',
    usage,
    flags: ['root'],
    approvedWith: device,
    ...extra,
  });

export const suspendedRule = (): SignInRuleView =>
  pageRule({ status: 'suspended', suspended: { at: '2026-10-31T09:00:00.000Z', because: 'place-changed' } });

/** What the daemon resolves for a stage's words that the stage itself does not carry: the username and the pinned 2FA key. */
export interface StageWordFacts {
  readonly username?: string;
  readonly codeKey?: string;
}

/**
 * A stage as the daemon makes it: its `does` and `rows` are the protocol's own `signInRuleWords` of the same fields, so
 * they end with when the rule stops and how many uses it has. A test that wants odd words passes `does` or `rows`.
 */
export const stagedRule = (extra: Partial<SignInRuleStaged> = {}, facts: StageWordFacts = {}): SignInRuleStaged => {
  const base = {
    stage: STAGE_ID,
    rule: RULE_ID,
    revision: 1,
    signIn: SITE_SIGN_IN,
    account: { id: 'GITHUB_WORK', label: 'github work' },
    place: sitePlace,
    fields: ['password'],
    totp: false,
    root: false,
    autoRecipe: false,
    scope: { kind: 'any' },
    expiresAt: EXPIRES,
    stageExpiresAt: STAGE_EXPIRES,
    ...extra,
  } as const;
  const words = signInRuleWords({
    ...base,
    ...(facts.username === undefined ? {} : { username: facts.username }),
    ...(facts.codeKey === undefined ? {} : { codeKey: facts.codeKey }),
  });
  return SignInRuleStagedSchema.parse({ ...base, does: extra.does ?? words.does, rows: extra.rows ?? words.rows });
};

/** A terminal stage lasts a day, the most a daemon stages for sudo without a longer pick, and never past 7. */
export const machineStage = (
  extra: Partial<SignInRuleStaged> = {},
  facts: StageWordFacts = { username: 'kirin' },
): SignInRuleStaged =>
  stagedRule(
    {
      signIn: SUDO_SIGN_IN,
      account: { id: 'SUDO_BOX', label: 'kirin' },
      place: sudoPlace,
      fields: ['password'],
      root: true,
      expiresAt: '2026-11-02T09:55:00.000Z',
      machine: { askedAt: '2026-11-01T09:55:00.000Z' },
      ...extra,
    },
    facts,
  );

export const ruleList = (extra: Partial<SignInRuleList> = {}): SignInRuleList =>
  SignInRuleListSchema.parse({ health: 'ok', rules: [], stages: [], ...extra });

export const suggestion = (extra: Partial<SignInRuleSuggestionView> = {}): SignInRuleSuggestionView =>
  SignInRuleSuggestionViewSchema.parse({
    id: SUGGESTION_ID,
    signIn: SITE_SIGN_IN,
    surface: 'page',
    host: 'github.com',
    why: 'I sign in here on every task.',
    agenda: 'A12',
    raisedAt: '2026-11-01T09:50:00.000Z',
    expiresAt: '2026-11-02T09:50:00.000Z',
    ...extra,
  });
