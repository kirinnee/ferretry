import { BoardPort } from '@ferretry/plugin-board/contract';
import { BrowsersPort } from '@ferretry/plugin-browsers/contract';
import { ConversationPort, TurnEnded } from '@ferretry/plugin-conversation/contract';
import { RuntimesPort } from '@ferretry/plugin-runtimes/contract';
import { TerminalsPort } from '@ferretry/plugin-terminals/contract';
import { VoicePort } from '@ferretry/plugin-voice/contract';
import { appAction, definePlugin, panel, route, screen, settingsTab } from '@ferretry/kernel/manifest';
import { AsksPort } from '@ferretry/core-asks/contract';
import { FerretChanged, FerretsPort } from '@ferretry/core-ferrets/contract';
import { UsagePort } from './contract/others.ts';
import {
  cap,
  WARDEN_CONFIGURED_AUDIT,
  WARDEN_INVESTIGATED_AUDIT,
  WARDEN_LEFT_ALONE_AUDIT,
  WARDEN_RAN_AUDIT,
  WardenActed,
  WardenFlagged,
  WardenPort,
  WARDEN_CONFIG,
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
   * Optional (D2 #19): Usage and Board as before; Terminals for the liveness look at each ferret's own pane (off:
   * `dead_monitor`, `sus_*` and `agent_frozen` do not run), Browsers to close the browsers left under it (off: that
   * check does not run).
   * Runtimes and Voice are read by the settings tab only (britnee, optional uses): the runtime list for the
   * investigation login and model field (off: the model field is a plain text box) and whether the Jev key is set
   * (off: the key line is hidden). None of Terminals, Browsers, Runtimes and Voice uses the Warden, so no cycle.
   */
  uses: {
    usage: UsagePort,
    board: BoardPort,
    terminals: TerminalsPort,
    browsers: BrowsersPort,
    runtimes: RuntimesPort,
    voice: VoicePort,
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
    ],
    settings: [settingsTab('warden', { label: 'Warden', order: 60 })],
  },

  data: {
    state: [WARDEN_STATE, WARDEN_REPORTS, WARDEN_JEV_CHECKS, WARDEN_REMEMBERED],
    config: [WARDEN_CONFIG],
    readModels: ['flags', 'verdicts', 'agenda', 'config'],
    publishes: [WardenFlagged, WardenActed],
  },

  hooks: { takes: [{ hook: FerretChanged }, { hook: TurnEnded }] },

  doctor: ['warden-sweep'],
  // It reads reports and the Jev guard model over the network; it starts wardens (ferrets) through Ferrets, not a process.
  permissions: { roots: [], network: ['api.typesafe.ai'], spawn: [], secrets: ['JEV_API_KEY'] },
});
