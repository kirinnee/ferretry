import { FerretsPort, StartDecide } from '@ferretry/core-ferrets/contract';
import { definePlugin, panel, route, screen, settingsTab, verb } from '@ferretry/kernel/manifest';
import { ConversationPort, TurnEnded } from '@ferretry/plugin-conversation/contract';
import { LoginsBudget, LoginsPort } from '@ferretry/plugin-logins/contract';
import {
  BudgetReached,
  INSIGHTS_STATE,
  InsightsChanged,
  LoginPaused,
  LoginResumed,
  PAUSE_TOLD_STATE,
  PAUSES_STATE,
  PRICING_CHANGED_AUDIT,
  PRICING_STATE,
  PRICING_SYNCED_AUDIT,
  PROFILE_STARTED_AUDIT,
  QUOTAS_STATE,
  USAGE_CONFIG,
  USAGE_READ_MODELS,
  USAGE_WORDS,
  UsagePort,
} from './contract/index.ts';

const none = (why: string) => ({ none: why }) as const;

/**
 * Usage (§2.3): knows what each login spent and has left, and pauses spending at your budget.
 *
 * Routes are today's `usage` feed, `analytics`, `analytics-pricing` and `performance` mounts, descriptor fields
 * unchanged (`capability` stays absent: today's are ungoverned beyond their credential minimum). Paths holding the
 * replaced word `analytics` move under `/v1/usage/…` (route path rule, TEAM-RULES); each is one line in
 * `descriptor-parity-changes.tsv`. `GET /v1/usage/budgets` is new: it answers what the credentials list answered about a
 * login's budget standing, now that Logins cannot import Usage.
 *
 * `GET /usage` and `GET /metrics` were `available: publicFeed`; a pure-data manifest cannot hold that function, so both
 * are declared and the handler answers exactly what an unrouted path answers while `publicFeed` (usage.yaml) is off.
 *
 * Nothing here spends a ferret: a pause is read by `start.decide` (a refusal that names the reset), and the only
 * ferrets Usage ever stops are those on a login past its hard limit, after an interrupt, through Ferrets' own stop.
 */
export default definePlugin({
  id: 'usage',
  title: 'Usage',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
  words: USAGE_WORDS,

  needs: { ferrets: FerretsPort, conversation: ConversationPort, logins: LoginsPort },
  provides: { usage: UsagePort },

  actions: {
    routes: [
      route('GET /usage', {
        minimum: 'none',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of the feed, served only while the machine opted in' },
        guard: none('account labels and quota percentages only'),
      }),
      route('GET /metrics', {
        minimum: 'none',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of the feed, served only while the machine opted in' },
        guard: none('account labels and quota percentages only'),
      }),
      route('GET /v1/usage', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of the feed' },
        guard: none('account labels and quota percentages only'),
      }),
      route('GET /v1/usage/budgets', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of budget standing' },
        guard: none(
          'a ferret reads whether its own logins are paused; the owner reads login ids, dollars and reset times',
        ),
      }),
      route('GET /v1/usage/insights', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of the index' },
        guard: none('rows carry labels and working directories of ferrets, never pane or page text'),
      }),
      route('GET /v1/usage/pricing', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of the rate catalog' },
        guard: none('rates only'),
      }),
      route('PATCH /v1/usage/pricing', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { record: PRICING_CHANGED_AUDIT },
        guard: none('rates only'),
      }),
      route('POST /v1/usage/pricing/sync/preview', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a preview changes nothing; it is held in memory for ten minutes' },
        guard: none('rates only'),
      }),
      route('POST /v1/usage/pricing/sync/apply', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { record: PRICING_SYNCED_AUDIT },
        guard: none('rates only'),
      }),
      route('POST /v1/diagnostics/profile', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { record: PROFILE_STARTED_AUDIT },
        guard: none('the report names no content: paths and commands are reduced to their shape'),
      }),
      route('GET /v1/diagnostics/profile/:id', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of a report' },
        guard: none('the report names no content: paths and commands are reduced to their shape'),
      }),
    ],
    cli: [
      verb('usage', {
        summary: 'query the insights index: spend, tokens, duration and outcome rates',
        args: [
          {
            name: 'query',
            help: 'the analytics query; omit it for every session, ungrouped',
            optional: true,
            variadic: true,
          },
        ],
        options: [{ flag: '--json', help: 'print the protocol response instead of the terminal table' }],
      }),
      verb('login budget', {
        summary:
          "show or set a sign-in's daily and weekly spend budget: past the trigger nothing new starts on it, past the hard limit its ferrets are stopped",
        args: [{ name: 'id', help: 'the login' }],
        options: [
          { flag: '--daily-trigger <usd>', help: 'stop routing to it once it spends this much today (or "off")' },
          { flag: '--daily-hard <usd>', help: 'also stop its ferrets once it spends this much today (or "off")' },
          { flag: '--weekly-trigger <usd>', help: 'stop routing to it once it spends this much this week (or "off")' },
          { flag: '--weekly-hard <usd>', help: 'also stop its ferrets once it spends this much this week (or "off")' },
          { flag: '--clear', help: 'remove the whole budget' },
          {
            flag: '--time-zone <zone>',
            help: 'the IANA zone days and weeks are counted in, for every budget on this machine',
          },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '--json', help: 'print the outcome as JSON' },
        ],
      }),
      verb('daemon profile', {
        summary:
          'measure what the daemon spends its time on for a few seconds: CPU, event-loop stalls, hot code, child processes, timers, routes and files',
        args: [],
        options: [
          { flag: '--seconds <n>', help: 'how long to measure (5 to 300; default 30)' },
          {
            flag: '--trace-syscalls',
            help: "also trace the daemon's system calls from outside (strace on Linux, sudo fs_usage on macOS)",
          },
          { flag: '--out <file>', help: 'also write the full report as JSON to this file, to send' },
          { flag: '--json', help: 'print the protocol document instead of the readable report' },
        ],
      }),
    ],
  },

  ui: {
    screens: [
      screen('insights', { path: 'insights', nav: { label: 'Insights', icon: 'chart', order: 70 } }),
      screen('insights-query', { path: 'insights/query' }),
    ],
    panels: [
      // The quota readout in the top bar, and a ferret's own insights next to it.
      panel('top', { id: 'quota', order: 70 }),
      panel('ferret.side', { id: 'insights', order: 70 }),
      // Info › Usage (context, turns, tokens, cost and the login's quota), and the machine home's "Spend today" tile.
      panel('ferret.side', { id: 'usage', order: 65 }),
      panel('daemon.status', { id: 'spend-today', order: 70 }),
      // The account's quota on the composer's context row.
      panel('composer.tools', { id: 'composer-quota', order: 90 }),
    ],
    settings: [
      settingsTab('budgets', { label: 'Budgets', order: 70 }),
      settingsTab('model-pricing', { label: 'Model pricing', order: 71 }),
      settingsTab('performance', { label: 'Performance', order: 72 }),
    ],
  },

  data: {
    state: [PAUSES_STATE, PAUSE_TOLD_STATE, PRICING_STATE, QUOTAS_STATE, INSIGHTS_STATE],
    config: [USAGE_CONFIG],
    readModels: USAGE_READ_MODELS,
    publishes: [LoginPaused, LoginResumed, InsightsChanged, BudgetReached],
  },

  hooks: { takes: [{ hook: StartDecide }, { hook: TurnEnded }, { hook: LoginsBudget, key: 'usage' }] },

  doctor: ['usage-meter'],

  // Provider quota endpoints, each read with the login's own key (never the harness's sign-in files) and only when
  // somebody watches. The owner-configured pricing sources, a LiteLLM key-info host and a Moonshot mainland host are
  // addressed by the owner's own config, not by this list: a declared GAP until the kernel resolves dynamic entries
  // (as it does for Connections' relay host), recorded in the port's report.
  permissions: {
    roots: [],
    network: [
      'api.anthropic.com',
      'chatgpt.com',
      'api.z.ai',
      'www.minimax.io',
      'api.deepseek.com',
      'api.moonshot.ai',
      'openrouter.ai',
      'ai-gateway.vercel.sh',
    ],
    spawn: [],
    secrets: [],
    // The daemon's own system-call count and reaped children's CPU, for `fy daemon profile`: `/proc/self/{io,stat}` only.
    selfCounters: true,
  },
});
