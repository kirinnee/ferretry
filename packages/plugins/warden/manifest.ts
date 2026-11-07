import { ConversationPort, TurnEnded } from '@ferretry/plugin-conversation/contract';
import { type ConfigDef, defineConfig, defineState } from '@ferretry/kernel/contract';
import { definePlugin, route, screen, settingsTab } from '@ferretry/kernel/manifest';
import { AsksPort, FerretChanged, FerretsPort } from './contract/core.ts';
import { UsagePort } from './contract/others.ts';
import {
  cap,
  JevChecksFileSchema,
  RememberedFileSchema,
  WARDEN_CONFIGURED_AUDIT,
  WARDEN_INVESTIGATED_AUDIT,
  WARDEN_LEFT_ALONE_AUDIT,
  WARDEN_RAN_AUDIT,
  WardenActed,
  WardenFileSchema,
  WardenFlagged,
  WardenPort,
  WardenStateFileSchema,
  wardenLoosens,
} from './contract/index.ts';

const STATE = defineState({
  name: 'state',
  path: 'state.json',
  store: 'json',
  format: 1,
  schema: WardenStateFileSchema,
});
/** Investigation reports, one markdown file each. Read through the guarded `report` route only. */
const REPORTS = defineState({ name: 'reports', path: 'reports/*', store: 'opaque', format: 1 });
const JEV_CHECKS = defineState({
  name: 'jev-checks',
  path: 'jev-checks/*.json',
  store: 'json',
  format: 1,
  schema: JevChecksFileSchema,
});
/**
 * Blessings ("leave it alone"). A blessing only ever makes the warden hold back, so a damaged file reading as none is
 * the narrower reading the contract allows: the warden judges every ferret again. It grants nothing.
 */
const REMEMBERED = defineState({
  name: 'remembered',
  path: 'remembered.json',
  store: 'json',
  format: 1,
  schema: RememberedFileSchema,
  onDamaged: { narrower: 'reads as no blessings: the warden judges every ferret again' },
});

/** `config/warden.yaml`: loosening edits (a bigger cap, a new act it may take alone, a layer on) wait for the owner. */
const WARDEN_CONFIG = defineConfig({
  file: 'warden.yaml',
  schema: WardenFileSchema,
  axis: 'configure',
  loosens: wardenLoosens,
}) as ConfigDef;

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
  uses: { usage: UsagePort },
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
  },

  ui: {
    screens: [screen('warden', { path: '/warden', nav: { label: 'Warden', icon: 'shield', order: 60 } })],
    settings: [settingsTab('warden', { label: 'Warden', order: 60 })],
  },

  data: {
    state: [STATE, REPORTS, JEV_CHECKS, REMEMBERED],
    config: [WARDEN_CONFIG],
    readModels: ['flags', 'verdicts', 'agenda', 'config'],
    publishes: [WardenFlagged, WardenActed],
  },

  hooks: { takes: [{ hook: FerretChanged }, { hook: TurnEnded }] },

  doctor: ['warden-sweep'],
  // It reads reports and the Jev guard model over the network; it starts wardens (ferrets) through Ferrets, not a process.
  permissions: { roots: [], network: ['api.typesafe.ai'], spawn: [], secrets: ['JEV_API_KEY'] },
});
