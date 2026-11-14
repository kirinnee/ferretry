import { AskSources, AsksPort, type SourceKey } from '@ferretry/core-asks/contract';
import { GatePort } from '@ferretry/core-gate/contract';
import { accountDefaultsDifferences } from './contract/defaults-differences.ts';
import { AccessPort, DevicesChanged, StepUpStages } from '@ferretry/plugin-access/contract';
import { BrowsersPort } from '@ferretry/plugin-browsers/contract';
import { FerretsChanged, FerretsPort } from '@ferretry/core-ferrets/contract';
import { BoardPort } from '@ferretry/plugin-board/contract';
import { ProjectsPort } from '@ferretry/plugin-projects/contract';
import {
  InputPhoneApprovals,
  InputSecureCopies,
  RedactionSources,
  SealedDocumentsPort,
  VaultPort,
} from '@ferretry/core-vault/contract';
import { LOGIN_SECRETS } from './contract/routes/sealed.ts';
import { AgentControlPort, type ConfigDef, defineConfig, defineState } from '@ferretry/kernel/contract';
import { definePlugin, renderer, route, settingsTab, tool, verb } from '@ferretry/kernel/manifest';
import {
  ACCOUNTS_WORDS,
  AccountsConfigSchema,
  AccountsPort,
  AUDIT,
  CONFIGURE,
  GUARD_NONE,
  NARROW,
  NARROW_CONFIGURE,
  SignInApprovalRefSchema,
  SignInsChanged,
  SKIP_BY_SERVICE,
  SKIP_READ,
  SKIP_UNRECORDED,
  USE,
} from './contract/index.ts';

/** Every Accounts tool is a ferret's call, kept as one `agent.tool` entry; none answers a value. */
const TOOL = { minimum: 'authenticated', caller: 'any', audit: { record: AUDIT.agentTool } } as const;
const NO_VALUE = { none: 'ids, places and card state only; a saved value never leaves the Vault' } as const;

/**
 * Accounts (§2.3): your website accounts — saved sign-ins, one-tap fill, 2FA codes, standing rules and login recipes.
 * Off: every sign-in asks you to type; saved values stay sealed in the Vault and stay masked.
 *
 * Routes copied from today's `runtime/mounts/secrets.ts` (the `/v1/accounts` half; the `/v1/secrets/logins` routes
 * and the `secret entry` verbs are removed by S84), `sign-in-rules.ts`, `secure-copy.ts`, `task-plans.ts` and the
 * phone-approval routes of `input-requests.ts`.
 */
export default definePlugin({
  id: 'accounts',
  title: 'Accounts',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view', 'item'],
  words: ACCOUNTS_WORDS,

  /** `sealed`: the passwords and 2FA seeds, in Accounts' own sealed document (`login-secrets.json`). */
  needs: { vault: VaultPort, asks: AsksPort, sealed: SealedDocumentsPort, gate: GatePort },
  /** Optional: a revoked or expired device's standing sign-in rules are suspended (P124, S119). */
  /**
   * `browsers`: the address of a page a ferret names (`account_hint` by page). `ferrets`: where a ferret works, which
   * orders its sign-in cards (I184); its project is the Board's (`projectOf`), named by Projects. All optional: without them,
   * today's behaviour without the read.
   */
  uses: {
    access: AccessPort,
    browsers: BrowsersPort,
    ferrets: FerretsPort,
    board: BoardPort,
    projects: ProjectsPort,
    /** "What agents may control": a command copy needs the Terminals switch, as any terminal act does. */
    agentControl: AgentControlPort,
  },
  provides: { accounts: AccountsPort },

  actions: {
    routes: [
      route('GET /v1/accounts', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.secrets,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/accounts/:id', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('PUT /v1/accounts/:id', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/accounts/:id/apart', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/accounts/:id/factors', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/accounts/:id/factors/:factor', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('PATCH /v1/accounts/:id/factors/:factor', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/accounts/:id/factors/seed', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/accounts/:id/factors/seed/:stage', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/accounts/:id/factors/seed/:stage', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/accounts/:id/factors/seed/:stage/commit', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/accounts/:id/factors/seed/:stage/confirm-in-app', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/accounts/:id/merge', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/accounts/:id/rename', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/accounts/:id/sign-in-rules/revoke', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.secrets,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('POST /v1/accounts/:id/sign-ins', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('PUT /v1/accounts/defaults', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW_CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/accounts/hint', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.secrets,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/accounts/look-alike', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/accounts/seed-stages/:stage', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/accounts/sign-ins/:signIn', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('PUT /v1/accounts/sign-ins/:signIn', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/accounts/sign-ins/:signIn/recipe/proposals/:proposalId', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: { record: AUDIT.secretsChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/copy-plans', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/copy-rules', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/copy-rules', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/copy-rules/:ruleId', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.terminal,
        noStore: true,
        audit: { record: AUDIT.securityChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/copy-rules/settings', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('PUT /v1/copy-rules/settings', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: { record: AUDIT.securityChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/copy-rules/settings/stages', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('POST /v1/copy-rules/settings/stages/:stage/commit', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.terminal,
        noStore: true,
        audit: { record: AUDIT.securityChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/copy-rules/stages', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/copy-rules/stages', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/copy-rules/stages/:stage', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('GET /v1/copy-rules/stages/:stage', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/copy-rules/stages/:stage/bind', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('POST /v1/copy-rules/stages/:stage/commit', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.terminal,
        noStore: true,
        audit: { record: AUDIT.securityChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/phone-approvals', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/ferrets/:ferretId/copies', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/copy-plans/:planId/approve', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.terminal,
        noStore: true,
        audit: { record: AUDIT.securityChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/ferrets/:ferretId/phone-approvals/:approvalId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/phone-approvals/:approvalId/refuse', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('GET /v1/ferrets/:ferretId/task-plans/:planId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/task-plans/:planId/approval', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.terminal,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/ferrets/:ferretId/task-plans/:planId/approval/:stage', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('GET /v1/ferrets/:ferretId/task-plans/:planId/approval/:stage', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/task-plans/:planId/approval/:stage/commit', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.terminal,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/task-plans/:planId/approval/:stage/confirm-in-app', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.terminal,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('POST /v1/ferrets/:ferretId/task-plans/:planId/revoke', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.terminal,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('GET /v1/sign-in-rules', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.secrets,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/sign-in-rules/:id', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.secrets,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('POST /v1/sign-in-rules/:id/narrow', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.secrets,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('GET /v1/sign-in-rules/eligibility', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.secrets,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/sign-in-rules/stages', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/sign-in-rules/stages/:stage', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.secrets,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('GET /v1/sign-in-rules/stages/:stage', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.secrets,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/sign-in-rules/stages/:stage/bind', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('POST /v1/sign-in-rules/stages/:stage/commit', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('POST /v1/sign-in-rules/stages/:stage/confirm-in-app', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.secrets,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('GET /v1/sign-in-rules/suggestions', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.secrets,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/sign-in-rules/suggestions/:sid', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.secrets,
        noStore: true,
        audit: SKIP_BY_SERVICE,
        guard: GUARD_NONE,
      }),
      route('GET /v1/accounts/plans', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.terminal,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
    ],
    agentTools: [
      tool('account_hint', {
        ...TOOL,
        capability: USE.secrets,
        guard: NO_VALUE,
        summary: 'list the saved sign-ins for a place',
      }),
      // SECURE COPY (docs/secure-copy.md): a value moves page/command → secure clipboard → terminal / page field / named
      // secret without entering the agent's context. Each tool parses its own call (the strict schemas are the contract's
      // `CopyCaptureSchema`, `SecurePasteInputSchema`, …) and answers a handle, a name, an origin, a length and a state.
      tool('secure_copy', {
        ...TOOL,
        capability: USE.terminal,
        guard: NO_VALUE,
        summary: "seal a command's stdout or a page element as sealed:<name>; you see its length, never the value",
      }),
      tool('secure_list', {
        ...TOOL,
        capability: USE.terminal,
        guard: NO_VALUE,
        summary: 'list the copies this session holds',
      }),
      tool('secure_discard', { ...TOOL, capability: USE.terminal, guard: NO_VALUE, summary: 'let go of a copy now' }),
      tool('secure_paste', {
        ...TOOL,
        capability: USE.terminal,
        guard: NO_VALUE,
        summary: 'ask the owner to paste sealed:<name> into a terminal, a page field or a saved secret',
      }),
      // AFTER MERGE (lizzette 2026-11-11: M2 moves after merge): account_propose and task_plan are declared here again once
      // each is built. Until then they are NOT listed, because the CLI builds the agents' MCP tool list from this array and
      // a listed tool that answers "not built" is a lie (docs/design/rebuild-parity.tsv T-0002, T-0043: still open).
    ],
    cli: [
      verb('copy ls', {
        summary: 'list the secure copies a session holds',
        args: [],
        options: [
          { flag: '-s, --session <id>', help: 'the session' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('copy rules ls', {
        summary: 'list the rules',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('copy rules add', {
        summary: 'make a paste rule: approve a route in advance',
        args: [],
        options: [
          { flag: '--from <source>', help: 'command:<program>, browser:<origin> or clipboard:<origin>' },
          { flag: '--to <destination>', help: 'terminal:<program>, browser:<origin> or secret:<NAME>' },
          { flag: '-s, --session <id>', help: 'only this session (default: any)' },
          { flag: '--count <n>', help: 'how many pastes it allows (default: no count)' },
          { flag: '--expires <time>', help: 'how long it lasts, like 30m, 2h or 7d (default: no expiry)' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('copy rules profile', {
        summary: 'let paste rules match programs in your own profile (on), or only ones the system installed (off)',
        args: [
          {
            name: 'state',
            help: 'on: a program from ~/.nix-profile, which any ferret can change, may match; off (the default)',
          },
        ],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('copy rules rm', {
        summary: 'end a paste rule',
        args: [{ name: 'id', help: 'the rule, by the start of its id' }],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('copy plan ls', {
        summary: 'list the plans, line by line',
        args: [],
        options: [
          { flag: '-s, --session <id>', help: 'only this session' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('copy plan approve', {
        summary: 'allow the numbered lines of a plan; no numbers declines it',
        args: [
          { name: 'id', help: 'the plan, by the start of its id' },
          { name: 'lines', help: 'the line numbers to allow, as listed', optional: true, variadic: true },
        ],
        options: [
          {
            flag: '--pick <line=account>',
            help: 'which account signs in on a line with several (a handle or si_…) (default: [])',
          },
          {
            flag: '--totp <line>',
            help: 'also let Ferretry type the 2FA code on this line (needs --i-understand-one-factor) (default: [])',
          },
          {
            flag: '--i-understand-one-factor',
            help: 'I understand this makes the sign-in one factor, with no one to approve a code.',
          },
          { flag: '--open', help: "open the plan's card in this machine's browser to confirm with your passkey" },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('copy plan revoke', {
        summary: 'end the numbered lines of a plan (all when none is named)',
        args: [
          { name: 'id', help: 'the plan, by the start of its id' },
          { name: 'lines', help: 'the line numbers to end', optional: true, variadic: true },
        ],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('plan ls', {
        summary: 'list the plans, line by line',
        args: [],
        options: [
          { flag: '-s, --session <id>', help: 'only this session' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('plan approve', {
        summary: 'allow the numbered lines of a plan; no numbers declines it',
        args: [
          { name: 'id', help: 'the plan, by the start of its id' },
          { name: 'lines', help: 'the line numbers to allow, as listed', optional: true, variadic: true },
        ],
        options: [
          {
            flag: '--pick <line=account>',
            help: 'which account signs in on a line with several (a handle or si_…) (default: [])',
          },
          {
            flag: '--totp <line>',
            help: 'also let Ferretry type the 2FA code on this line (needs --i-understand-one-factor) (default: [])',
          },
          {
            flag: '--i-understand-one-factor',
            help: 'I understand this makes the sign-in one factor, with no one to approve a code.',
          },
          { flag: '--open', help: "open the plan's card in this machine's browser to confirm with your passkey" },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('plan revoke', {
        summary: 'end the numbered lines of a plan (all when none is named)',
        args: [
          { name: 'id', help: 'the plan, by the start of its id' },
          { name: 'lines', help: 'the line numbers to end', optional: true, variadic: true },
        ],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('rules ls', {
        summary: 'list the rules and the ones waiting for a passkey',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('rules add', {
        summary: 'stage a rule for a sign-in; you approve it with your passkey in the app',
        args: [{ name: 'sign-in', help: 'the sign-in, as si_… (see `fy account site ls`)' }],
        options: [
          { flag: '--username', help: 'also type the username (default: the password only)' },
          { flag: '--totp', help: 'also let Ferretry type the 2FA code (needs --i-understand-one-factor)' },
          {
            flag: '--i-understand-one-factor',
            help: 'say "I understand this makes the sign-in one factor, with no one to approve a code."',
          },
          { flag: '--scope <scope>', help: 'any ferret (default), project:<uuid> or session:<id>' },
          {
            flag: '--expires <time>',
            help: 'how long it lasts, like 12h or 7d (default: 30 days for a page, 1 day for a terminal)',
          },
          { flag: '--uses <n>', help: 'at most this many fills (at least 1)' },
          { flag: '--open', help: "open the rule's page in this machine's browser to confirm with your passkey" },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('rules resume', {
        summary: 'approve a suspended rule again, with a new passkey',
        args: [{ name: 'rule', help: 'the rule, by the start of its id' }],
        options: [
          { flag: '--totp', help: 'also let Ferretry type the 2FA code (needs --i-understand-one-factor)' },
          {
            flag: '--i-understand-one-factor',
            help: 'say "I understand this makes the sign-in one factor, with no one to approve a code."',
          },
          { flag: '--open', help: "open the rule's page in this machine's browser to confirm with your passkey" },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('rules renew', {
        summary: 'approve a rule again for a new period, with a new passkey',
        args: [{ name: 'rule', help: 'the rule, by the start of its id' }],
        options: [
          { flag: '--totp', help: 'also let Ferretry type the 2FA code (needs --i-understand-one-factor)' },
          {
            flag: '--i-understand-one-factor',
            help: 'say "I understand this makes the sign-in one factor, with no one to approve a code."',
          },
          {
            flag: '--expires <time>',
            help: 'how long it lasts, like 12h or 7d (default: 30 days for a page, 1 day for a terminal)',
          },
          { flag: '--uses <n>', help: 'at most this many fills (at least 1)' },
          { flag: '--open', help: "open the rule's page in this machine's browser to confirm with your passkey" },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('rules widen', {
        summary: 'give a rule more (the username, the 2FA code, who, time or uses), with a new passkey',
        args: [{ name: 'rule', help: 'the rule, by the start of its id' }],
        options: [
          { flag: '--username', help: 'also type the username' },
          { flag: '--totp', help: 'also let Ferretry type the 2FA code (needs --i-understand-one-factor)' },
          {
            flag: '--i-understand-one-factor',
            help: 'say "I understand this makes the sign-in one factor, with no one to approve a code."',
          },
          { flag: '--scope <scope>', help: 'who may use it: any, project:<uuid> or session:<id>' },
          { flag: '--expires <time>', help: 'how long it lasts from now, like 7d (default: it ends when it did)' },
          { flag: '--uses <n>', help: 'at most this many fills (at least 1) (default: the uses it has left)' },
          { flag: '--open', help: "open the rule's page in this machine's browser to confirm with your passkey" },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('rules narrow', {
        summary: 'take something away from a rule: the 2FA code, time or uses; no passkey',
        args: [{ name: 'rule', help: 'the rule, by the start of its id' }],
        options: [
          { flag: '--drop-totp', help: 'stop typing the 2FA code' },
          { flag: '--expires <time>', help: 'end it this long from now, like 2h' },
          { flag: '--uses <n>', help: 'lower the cap on fills' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('rules rm', {
        summary: 'revoke a rule now, or every rule of an account; no passkey',
        args: [{ name: 'rule', help: 'the rule, by the start of its id', optional: true }],
        options: [
          { flag: '--account <account>', help: 'revoke every standing rule of this account instead' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('account ls', {
        default: true,
        summary: 'list the accounts, with their 2FA keys and sign-ins',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol document instead of the human listing' }],
      }),
      verb('account add', {
        summary: 'save a new account; type the password with echo off',
        args: [{ name: 'id', help: 'the account’s id: a short name you choose' }],
        options: [
          { flag: '--label <text>', help: 'the name you read it by, e.g. "sudo on kirin-box"' },
          { flag: '--username <text>', help: 'the username (plain text, shown on cards)' },
          { flag: '--no-password', help: 'save it without a password for now' },
          { flag: '--domain <host>', help: 'where the sign-in happens, e.g. accounts.google.com (repeatable)' },
          { flag: '--for <host>', help: 'what it is for, e.g. app.vercel.com (repeatable)' },
          { flag: '--tool <program>', help: 'terminal: the program asking, e.g. sudo, ssh' },
          { flag: '--host <machine>', help: 'terminal: the machine it runs on' },
          { flag: '--dest <machine>', help: 'terminal: where ssh, scp or sftp go' },
          { flag: '--method <kind>', help: 'how it signs in: password, google, github, microsoft, apple, sso' },
          { flag: '--sso-name <text>', help: 'with --method sso: the provider as its button says it, e.g. Okta' },
          { flag: '--via <id>', help: "with a provider method: the provider's account, e.g. GOOGLE_KIRIN" },
        ],
      }),
      verb('account edit', {
        summary: 'change the fields named; the rest are kept',
        args: [{ name: 'id', help: 'the account to change' }],
        options: [
          { flag: '--label <text>', help: 'a new label' },
          { flag: '--username <text>', help: 'a new username' },
          { flag: '--no-username', help: 'remove the username' },
          { flag: '--password', help: 'replace the password (typed at a hidden prompt)' },
          { flag: '--totp', help: '(moved) a 2FA seed is saved with `account factor add <id> --totp`' },
        ],
      }),
      verb('account rename', {
        summary: 'change a handle; the values follow it',
        args: [
          { name: 'id', help: 'the account to rename' },
          { name: 'new-id', help: 'its new id' },
        ],
      }),
      verb('account rm', {
        summary: 'delete an account with its sign-ins and 2FA keys',
        args: [{ name: 'id', help: 'the account to remove' }],
        options: [{ flag: '-y, --yes', help: 'do not ask first' }],
      }),
      verb('account merge', {
        summary: 'fold the account FROM into KEEP: its sign-ins and 2FA keys move, then it is gone',
        args: [
          { name: 'keep', help: 'the account to keep' },
          { name: 'from', help: 'the account folded into it' },
        ],
        options: [{ flag: '-y, --yes', help: 'do not ask first' }],
      }),
      verb('account apart', {
        summary: 'say two accounts are different, so look-alike and merge hints stop pairing them',
        args: [
          { name: 'id', help: 'the account that holds the two looks-alike accounts' },
          { name: 'other', help: 'the account it is deliberately not the same as' },
        ],
      }),
      verb('account look-alike', {
        summary: 'groups of accounts with the same username and password (handles only), which may be one account',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol document instead' }],
      }),
      verb('account hint', {
        summary: 'what a ferret is told about signing in to a site: label, method, domains, username; never a value',
        args: [{ name: 'site', help: 'the website the sign-in is for' }],
        options: [{ flag: '--json', help: 'print the protocol document instead' }],
      }),
      verb('account default set', {
        summary: 'use ACCOUNT for KEY: a site host, or --project / --folder',
        args: [
          { name: 'key', help: 'which default to set (a site or a kind of sign-in)' },
          { name: 'account', help: 'the account that becomes the default' },
        ],
        options: [
          { flag: '--project <name>', help: 'KEY is a board project' },
          { flag: '--folder <path>', help: 'KEY is a folder' },
        ],
      }),
      verb('account default rm', {
        summary: 'stop using a default for KEY',
        args: [{ name: 'key', help: 'which default to clear' }],
        options: [
          { flag: '--project <name>', help: 'KEY is a board project' },
          { flag: '--folder <path>', help: 'KEY is a folder' },
        ],
      }),
      verb('account site ls', {
        default: true,
        summary: 'list the sign-ins (one account, or all), each with its si_ id',
        args: [{ name: 'account', help: 'the account whose sign-in sites to list', optional: true }],
        options: [{ flag: '--json', help: 'print the sign-ins as JSON instead' }],
      }),
      verb('account site add', {
        summary: 'add a place this account signs in',
        args: [{ name: 'account', help: 'the account the sign-in site belongs to' }],
        options: [
          { flag: '--domain <host>', help: 'where the sign-in happens, e.g. accounts.google.com (repeatable)' },
          { flag: '--for <host>', help: 'what it is for, e.g. app.vercel.com (repeatable)' },
          { flag: '--tool <program>', help: 'terminal: the program asking, e.g. sudo, ssh' },
          { flag: '--host <machine>', help: 'terminal: the machine it runs on' },
          { flag: '--dest <machine>', help: 'terminal: where ssh, scp or sftp go' },
          { flag: '--method <kind>', help: 'how it signs in: password, google, github, microsoft, apple, sso' },
          { flag: '--sso-name <text>', help: 'with --method sso: the provider as its button says it, e.g. Okta' },
          { flag: '--via <id>', help: "with a provider method: the provider's account, e.g. GOOGLE_KIRIN" },
          {
            flag: '--auto-apply-recipe <on|off>',
            help: "let a ferret's recipe proposal for this sign-in apply without asking",
          },
        ],
      }),
      verb('account site edit', {
        summary: 'change the parts named; the rest are kept',
        args: [{ name: 'sign-in', help: 'the sign-in to change' }],
        options: [
          { flag: '--domain <host>', help: 'REPLACE where the sign-in happens, e.g. accounts.google.com (repeatable)' },
          { flag: '--for <host>', help: 'REPLACE what it is for, e.g. app.vercel.com (repeatable)' },
          { flag: '--tool <program>', help: 'terminal: REPLACE the program asking, e.g. sudo, ssh' },
          { flag: '--host <machine>', help: 'terminal: REPLACE the machine it runs on' },
          { flag: '--dest <machine>', help: 'terminal: REPLACE where ssh, scp or sftp go' },
          { flag: '--method <kind>', help: 'how it signs in: password, google, github, microsoft, apple, sso' },
          { flag: '--sso-name <text>', help: 'with --method sso: the provider as its button says it, e.g. Okta' },
          { flag: '--via <id>', help: "with a provider method: the provider's account, e.g. GOOGLE_KIRIN" },
          { flag: '--no-via', help: 'sign in via no account' },
          {
            flag: '--auto-apply-recipe <on|off>',
            help: "let a ferret's recipe proposal for this sign-in apply without asking",
          },
        ],
      }),
      verb('account site rm', {
        summary: 'remove a sign-in; the account stays',
        args: [{ name: 'sign-in', help: 'the sign-in to remove' }],
        options: [{ flag: '-y, --yes', help: 'do not ask first' }],
      }),
      verb('account site recipe show', {
        default: true,
        summary: 'the recipe, what was seen when it was typed, and each waiting proposal as a change',
        args: [{ name: 'sign-in', help: 'the sign-in whose recipe to show' }],
        options: [{ flag: '--json', help: 'print the sign-in as JSON instead' }],
      }),
      verb('account site recipe set', {
        summary: 'replace the recipe with Markdown from a file, or from standard input with --file -',
        args: [{ name: 'sign-in', help: 'the sign-in to give a recipe' }],
        options: [{ flag: '--file <path>', help: 'the Markdown file, or - for standard input' }],
      }),
      verb('account site recipe clear', {
        summary: 'remove the recipe',
        args: [{ name: 'sign-in', help: 'the sign-in whose recipe to clear' }],
      }),
      verb('account site recipe approve', {
        summary: "make a ferret's proposal the recipe",
        args: [
          { name: 'sign-in', help: 'the sign-in whose recipe to approve' },
          { name: 'proposal-id', help: 'the proposal to approve' },
        ],
      }),
      verb('account site recipe decline', {
        summary: "turn a ferret's proposal down; the recipe stays as it is",
        args: [
          { name: 'sign-in', help: 'the sign-in whose recipe to decline' },
          { name: 'proposal-id', help: 'the proposal to decline' },
        ],
      }),
      verb('account factor ls', {
        default: true,
        summary: 'list the 2FA keys (one account, or all), each with its tf_ id',
        args: [{ name: 'account', help: 'the account whose 2FA keys to list', optional: true }],
        options: [{ flag: '--json', help: 'print the keys as JSON instead' }],
      }),
      verb('account factor add', {
        summary: 'add a 2FA key: --totp saves a seed (confirmed with your passkey), the others hold no value',
        args: [{ name: 'account', help: 'the account the 2FA key belongs to' }],
        options: [
          {
            flag: '--totp',
            help: 'a TOTP key Ferretry makes codes from (typed at a hidden prompt, then confirmed in the app)',
          },
          { flag: '--authenticator', help: 'a TOTP app only you hold: Ferretry stores no seed, you type its codes' },
          { flag: '--sms', help: 'a code by text message' },
          { flag: '--ends-with <digits>', help: 'with --sms: the last 2 to 4 digits of the number' },
          { flag: '--email', help: 'a code by email' },
          { flag: '--to <address>', help: 'with --email: where it arrives, as it is shown' },
          { flag: '--push', help: 'an approval on your phone' },
          { flag: '--app <name>', help: 'with --push: okta-verify, microsoft-authenticator, google, duo, other' },
          { flag: '--security-key', help: 'a hardware key you tap' },
          { flag: '--label <text>', help: 'what you call it, e.g. "Authy backup" (required, except with --totp)' },
          {
            flag: '-s, --session <id>',
            help: "with --totp: the session whose card in the app's Inbox confirms it (defaults to the current session; at your own terminal, your most recently active one)",
          },
          { flag: '--i-understand-totp', help: 'with --totp: skip the typed "yes" after the 2FA warning' },
        ],
      }),
      verb('account factor rm', {
        summary: 'remove a 2FA key; for one whose seed Ferretry holds, the seed goes with it',
        args: [
          { name: 'account', help: 'the account the 2FA key belongs to' },
          { name: 'factor', help: 'the 2FA key to remove' },
        ],
        options: [{ flag: '-y, --yes', help: 'do not ask first' }],
      }),
    ],
  },

  ui: {
    settings: [
      settingsTab('accounts', { group: 'sites', label: 'Accounts', order: 40 }),
      settingsTab('secure-copy', { group: 'sites', label: 'Secure copy', order: 41 }),
    ],
    renderers: [renderer('ask', { source: 'sign-in-approval' })],
  },

  /** Never reached by a ferret, through any root: the sealed login secrets and the account records (`PrivacyDecl`). */
  privacy: {
    private: ['login-secrets.json', 'accounts.json'],
  },
  data: {
    state: [
      /** The index only: every value is sealed in the Vault under its sealed name. */
      defineState({ name: 'accounts', path: 'accounts.json', store: 'json', format: 1, mode: 0o600 }),
      /** The values themselves, sealed by the Vault (`LOGIN_SECRETS`). */
      LOGIN_SECRETS.state,
      defineState({ name: 'sign-in-rules', path: 'sign-in-rules.json', store: 'json', format: 1 }),
      defineState({ name: 'copy-rules', path: 'copy-rules.json', store: 'json', format: 1 }),
      defineState({ name: 'copy-plans', path: 'copy-plans/*.json', store: 'json', format: 1 }),
    ],
    config: [
      defineConfig({
        file: 'accounts.yaml',
        schema: AccountsConfigSchema,
        axis: 'configure',
        loosens: (before, after) => accountDefaultsDifferences(before ?? {}, after),
      }) as ConfigDef,
    ],
    readModels: ['sign-ins'],
    publishes: [SignInsChanged],
    /** A revoked or idle-expired device's standing rules are suspended (P124); Access's event, read through its contract. */
    subscribes: [DevicesChanged, FerretsChanged],
  },

  hooks: {
    takes: [
      { hook: RedactionSources, key: 'source' },
      /** The Vault's `push: true` raise and `input_wait` on a `pa_` id are answered here: an approval is a sign-in's. */
      { hook: InputPhoneApprovals, key: 'phone' },
      /** The Vault's paste draws on the copies, the owner's paste rules and the takeover check, all Accounts'. */
      { hook: InputSecureCopies, key: 'copy' },
      { hook: AskSources, key: 'sign-in-approval' satisfies string as SourceKey, schema: SignInApprovalRefSchema },
      /** Access issues a passkey challenge for a staged act only through the plugin that staged it (G83): each act is Accounts'. */
      { hook: StepUpStages, key: 'add-2fa-key' },
      { hook: StepUpStages, key: 'approve-task-plan' },
      { hook: StepUpStages, key: 'approve-sign-in-rule' },
      { hook: StepUpStages, key: 'approve-paste-rule' },
    ],
  },
});
