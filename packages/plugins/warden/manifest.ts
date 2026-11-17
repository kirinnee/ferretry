import { BoardPort } from '@ferretry/plugin-board/contract';
import { BrowsersPort } from '@ferretry/plugin-browsers/contract';
import { ConversationPort, TurnEnded } from '@ferretry/plugin-conversation/contract';
import { RuntimesPort } from '@ferretry/plugin-runtimes/contract';
import { TerminalsPort } from '@ferretry/plugin-terminals/contract';
import { VoicePort } from '@ferretry/plugin-voice/contract';
import { appAction, definePlugin, panel, route, screen, settingsTab, verb } from '@ferretry/kernel/manifest';
import { AsksPort } from '@ferretry/core-asks/contract';
import { ACTIONS_ROW_SLOT, FerretChanged, FerretsPort } from '@ferretry/core-ferrets/contract';
import { GatePort } from '@ferretry/core-gate/contract';
import { AccountsPort, LoginsPort, UsagePort } from './contract/others.ts';
import {
  cap,
  WARDEN_CONFIGURED_AUDIT,
  WARDEN_INVESTIGATED_AUDIT,
  WARDEN_LEFT_ALONE_AUDIT,
  WARDEN_RAN_AUDIT,
  WardenActed,
  WardenConfigChanged,
  WardenFlagged,
  WardenPort,
  WARDEN_CONFIG,
  WARDEN_DIALOG_FRAMES,
  WARDEN_DIALOG_RULES,
  WardenDialogRulesClaude,
  WardenDialogRulesCodex,
  WARDEN_JEV_CHECKS,
  WARDEN_REMEMBERED,
  WARDEN_REPORTS,
  WARDEN_STATE,
} from './contract/index.ts';

const warden = cap('use');
const wardenConfigure = cap('configure');
const secrets = 'secrets' as const;

/**
 * Warden (§2.3): watches ferrets for trouble (a flag) and fixes or flags it (a remedy).
 *
 * The routes are today's `warden` mount, field for field. Reads are `authenticated` because a live warden reads its own
 * status to understand what it was sent to triage; running a sweep and changing settings are `operator` because they
 * spend, and a warden that could raise its own cap would escalate its own authority. `guard: 'secrets'` is declared
 * wherever a body can carry text read from a pane (flag details, reports, verdict reasons); today's mount had no such
 * declaration, so the port builds those bodies inside one `Redaction.read` (a new obligation of §7.3, not parity).
 *
 * No `wardenRemedy` on a route: today's mount declares none (the warden acts through its own token class on Ferrets'
 * routes). The remedies it may exercise are minted in `contract/policy.ts`; Ferrets' routes name them when they port.
 * There is no `fy warden` verb today, so none is declared.
 */
export default definePlugin({
  id: 'warden',
  title: 'Warden',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  words: [
    { word: 'flag', means: 'the warden noticing trouble', insteadOf: ['alert'] },
    { word: 'remedy', means: 'what the warden does about it', insteadOf: ['fix (for this)'] },
  ],

  needs: { ferrets: FerretsPort, conversation: ConversationPort, asks: AsksPort },
  /**
   * Optional (D2 #19): Usage and Logins give the auto-move its quota facts (with Runtimes' catalog), and Accounts gives
   * its one owner-hold yes or no (off or silent: a ferret is never moved, because a hold that cannot be checked is a
   * hold); Board as before; Terminals for the liveness look at each ferret's own pane (off:
   * `dead_monitor`, `sus_*` and `agent_frozen` do not run), Browsers to close the browsers left under it (off: that
   * check does not run).
   * Runtimes and Voice are read by the settings tab only (britnee, optional uses): the runtime list for the
   * investigation login and model field (off: the model field is a plain text box) and whether the Jev key is set
   * (off: the key line is hidden). Gate (core, always on) is declared because the app half parses its `GET /v1/grants`
   * answer with Gate's own schema to know whether `warden.use` is open. None of Terminals, Browsers, Runtimes and Voice uses the Warden, so no cycle.
   */
  uses: {
    usage: UsagePort,
    logins: LoginsPort,
    accounts: AccountsPort,
    board: BoardPort,
    terminals: TerminalsPort,
    browsers: BrowsersPort,
    runtimes: RuntimesPort,
    voice: VoicePort,
    gate: GatePort,
  },
  provides: { warden: WardenPort },

  actions: {
    routes: [
      route('GET /v1/warden/status', {
        minimum: 'authenticated',
        caller: 'any',
        capability: warden,
        noStore: true,
        audit: { skip: 'a read of status' },
        guard: secrets,
      }),
      route('GET /v1/warden/verdicts', {
        minimum: 'authenticated',
        caller: 'any',
        capability: warden,
        noStore: true,
        audit: { skip: 'a read of verdicts' },
        guard: secrets,
      }),
      route('GET /v1/warden/report', {
        minimum: 'authenticated',
        caller: 'any',
        capability: warden,
        noStore: true,
        audit: { skip: 'a read of one report' },
        guard: secrets,
      }),
      route('GET /v1/warden/agenda', {
        minimum: 'authenticated',
        caller: 'any',
        capability: warden,
        noStore: true,
        audit: { skip: 'a read of who needs you' },
        guard: secrets,
      }),
      route('POST /v1/warden/run', {
        minimum: 'operator',
        caller: 'any',
        capability: warden,
        noStore: true,
        audit: { record: WARDEN_RAN_AUDIT },
        guard: secrets,
      }),
      route('POST /v1/warden/investigate', {
        minimum: 'operator',
        caller: 'person',
        capability: warden,
        noStore: true,
        audit: { record: WARDEN_INVESTIGATED_AUDIT },
        guard: { none: 'answers a queue position and a sentence' },
      }),
      route('POST /v1/warden/leave', {
        minimum: 'operator',
        caller: 'person',
        capability: wardenConfigure,
        noStore: true,
        audit: { record: WARDEN_LEFT_ALONE_AUDIT },
        guard: { none: 'answers a blessing and a sentence' },
      }),
      route('GET /v1/warden/dialog/rules', {
        minimum: 'operator',
        caller: 'person',
        capability: warden,
        noStore: true,
        audit: { skip: 'a read of the screens Ferretry clears' },
        guard: { none: 'rule names and sentences the owner taught: no pane text' },
      }),
      route('POST /v1/warden/dialog/learn', {
        minimum: 'operator',
        caller: 'person',
        capability: wardenConfigure,
        noStore: true,
        audit: { record: WARDEN_CONFIGURED_AUDIT },
        guard: 'secrets',
      }),
      route('GET /v1/warden/config', {
        minimum: 'operator',
        caller: 'any',
        capability: warden,
        noStore: true,
        audit: { skip: 'a read of settings' },
        guard: { none: 'settings only' },
      }),
      route('PATCH /v1/warden/config', {
        minimum: 'operator',
        caller: 'person',
        capability: wardenConfigure,
        noStore: true,
        audit: { record: WARDEN_CONFIGURED_AUDIT },
        guard: { none: 'settings only' },
      }),
      route('POST /v1/warden/jev-key', {
        minimum: 'operator',
        caller: 'person',
        capability: wardenConfigure,
        noStore: true,
        audit: { record: WARDEN_CONFIGURED_AUDIT },
        guard: { none: 'names a reference, never a value' },
      }),
    ],
    // `fy warden dialog learn`: teach Ferretry the way out of a screen it does not know (docs/harness-dialogs.md).
    cli: [
      verb('warden dialog learn', {
        summary:
          'teach Ferretry a harness screen a ferret is parked on: read its proposed rule, then save it with --confirm',
        args: [{ name: 'ferret', help: 'the ferret parked on the screen (callsign or id)' }],
        options: [
          { flag: '--confirm', help: 'save the rule the last learn of this ferret proposed (your yes)' },
          {
            flag: '--row <number>',
            help: 'press this row instead of the one proposed (a row that grants is held, never saved)',
          },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
    ],
    // Today's ferret Actions menu row ("Ask the Warden to investigate now…"), contributed rather than written in.
    app: [
      appAction('ask-warden', {
        on: 'ferret',
        label: 'Ask the Warden to investigate now…',
        calls: 'POST /v1/warden/investigate',
      }),
    ],
  },

  // Today's PWA drew the pack-health strip and the recent verdicts on the ferrets dashboard (`session-dashboard.tsx`):
  // here they are the dashboard's `daemon.status` panels.
  ui: {
    screens: [screen('warden', { path: 'warden', nav: { label: 'Warden', icon: 'shield', order: 60 } })],
    panels: [
      panel('daemon.status', { id: 'warden-strip', order: 60 }),
      panel('daemon.status', { id: 'warden-verdicts', order: 61 }),
      // Ferrets' own pages: the Warden's word about a ferret in its Info, and its row in the Actions ▾ menu.
      panel('ferret.side', { id: 'ferret-warden', order: 30 }),
      panel(ACTIONS_ROW_SLOT, { id: 'ask-warden-row', order: 90 }),
      // The first-run step's body (Onboarding's steps screen offers this slot): the same view as the Settings tab.
      panel('onboarding.step', { id: 'onboarding-step', order: 60 }),
    ],
    settings: [settingsTab('warden', { group: 'supervision', label: 'Warden', order: 60 })],
  },

  data: {
    state: [WARDEN_STATE, WARDEN_REPORTS, WARDEN_JEV_CHECKS, WARDEN_REMEMBERED, WARDEN_DIALOG_FRAMES],
    config: [WARDEN_CONFIG, WARDEN_DIALOG_RULES],
    readModels: ['flags', 'verdicts', 'agenda', 'config'],
    publishes: [WardenFlagged, WardenActed, WardenConfigChanged],
  },

  // A screen a person taught Ferretry is a screen of their work: its frame is owner-only and pinned by identity.
  privacy: { private: ['dialog-frames'] },

  // The built-in dialog rules are the harness plugins' (`warden.dialog-rules.<harness>`): each takes its hook, this plugin
  // OFFERS them and reads what is provided (the Runtimes' component sources are the same shape).
  hooks: {
    takes: [{ hook: FerretChanged }, { hook: TurnEnded }],
    offers: [{ hook: WardenDialogRulesClaude }, { hook: WardenDialogRulesCodex }],
  },

  onboarding: [{ id: 'warden', title: 'Warden', order: 60 }],
  doctor: ['warden-sweep'],
  // It reads reports and the Jev guard model over the network; it starts wardens (ferrets) through Ferrets, not a process.
  permissions: { roots: [], network: ['api.typesafe.ai'], spawn: [], secrets: ['JEV_API_KEY'] },
});
