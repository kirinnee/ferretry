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
    account: { id: 'SUDO_BOX', label: 'sudo on kirin-box' },
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

/** A stage whose 240-character summary is clipped before it reaches the flag: the booleans carry the truth. */
export const stagedRule = (extra: Partial<SignInRuleStaged> = {}): SignInRuleStaged =>
  SignInRuleStagedSchema.parse({
    stage: STAGE_ID,
    rule: RULE_ID,
    revision: 1,
    signIn: SITE_SIGN_IN,
    account: { id: 'GITHUB_WORK', label: 'github work' },
    place: sitePlace,
    summary: [`Ferretry types the password into github work for any ferret${'.'.repeat(160)}`],
    fields: ['password'],
    totp: false,
    root: false,
    autoRecipe: false,
    scope: { kind: 'any' },
    expiresAt: EXPIRES,
    stageExpiresAt: STAGE_EXPIRES,
    ...extra,
  });

export const machineStage = (extra: Partial<SignInRuleStaged> = {}): SignInRuleStaged =>
  stagedRule({
    signIn: SUDO_SIGN_IN,
    account: { id: 'SUDO_BOX', label: 'sudo on kirin-box' },
    place: sudoPlace,
    fields: ['password'],
    root: true,
    summary: ['Ferretry types the password into sudo on kirin-box for any ferret'],
    machine: { askedAt: '2026-11-01T09:55:00.000Z' },
    ...extra,
  });

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
