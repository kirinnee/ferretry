import { AUDIT_KINDS } from '@ferretry/core-gate/contract';
import { FerretsPort, LaunchParts, StartDecide } from '@ferretry/core-ferrets/contract';
import { definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { CONVERSATION_ROW_SLOT, ConversationPort } from '@ferretry/plugin-conversation/contract';
import { RuntimesPort } from '@ferretry/plugin-runtimes/contract';
import {
  PACK_REPLACED,
  PACK_RUNS,
  PACK_SWITCHES,
  PACKS,
  PACKS_CONFIG,
  PACKS_WORDS,
  PacksPort,
  packConfigure,
  packUse,
  UsagePort,
} from './contract/index.ts';

/**
 * Packs (§2.3): leads start helpers on the right model, within limits.
 *
 * Routes are today's `pack` mount, descriptor for descriptor. Two paths moved: the three per-ferret ones
 * (`/v1/sessions/:sessionId/…` renamed `/v1/ferrets/:ferretId/…`, §1.4) and `…/subtree`, whose word is the lead's PACK now
 * (§1.2), so `GET /v1/ferrets/:ferretId/pack` is the pack table and `PATCH` on the same path is the ferret's own switch.
 * `POST /v1/recommend` (R-0321, the account recommender) is still declared by Runtimes on this base, at that path; the
 * placement lists it with Packs, so where it lives is the lead's to settle (ports-pending). `fy new` is Ferrets' verb and
 * `fy wait` Conversation's: Packs starts no helper and waits on none.
 *
 * `guard: 'secrets'` on the three routes that carry text a ferret wrote (a result, a pack table's last lines, a Clean up
 * run's rewrite): their bodies are built inside one `Redaction.read` (§7.3), and a rewrite is masked before it is kept. The other answers are model ids, runtime and login NAMES,
 * readiness and quota; the routing prompt is the owner's words.
 *
 * It shapes a start only through `start.decide` (admission: depth and how many children a parent may have, whichever
 * command started the child) and `launch.parts` (the `FY_PACK` switch and the routing line a launch carries, which
 * Ferrets cannot ask a plugin's port for). Usage and Runtimes are optional: with them off there are no recommendations.
 */
export default definePlugin({
  id: PACKS,
  title: 'Packs',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
  words: PACKS_WORDS,

  needs: { ferrets: FerretsPort },
  // Conversation is optional: the Pack card is drawn in its transcript, and with Conversation off there is no transcript.
  uses: { usage: UsagePort, runtimes: RuntimesPort, conversation: ConversationPort },
  provides: { packs: PacksPort },

  actions: {
    routes: [
      route('GET /v1/pack', {
        minimum: 'operator',
        caller: 'any',
        capability: packUse,
        noStore: true,
        audit: { skip: 'a read of settings and the models usable now' },
        guard: { none: 'settings, the routing prompt, model ids and quota words; no pane text' },
      }),
      route('GET /v1/pack/inventory', {
        minimum: 'operator',
        caller: 'any',
        capability: packUse,
        noStore: true,
        audit: { skip: 'a read of what Clean up is shown' },
        guard: { none: 'runtime and login names, readiness and quota; never a credential' },
      }),
      route('POST /v1/pack/routing/clean-up', {
        minimum: 'operator',
        caller: 'person',
        capability: packUse,
        noStore: true,
        audit: { record: AUDIT_KINDS['session.opened'] },
        guard: { none: 'answers a run id and a sentence' },
      }),
      route('GET /v1/pack/routing/jobs/:jobId', {
        minimum: 'operator',
        caller: 'any',
        capability: packUse,
        noStore: true,
        audit: { skip: 'a read of one run' },
        guard: 'secrets',
      }),
      route('POST /v1/pack/routing/accept', {
        minimum: 'operator',
        caller: 'person',
        capability: packConfigure,
        noStore: true,
        audit: { record: AUDIT_KINDS['fleet.configured'] },
        guard: { none: 'answers a sentence' },
      }),
      route('POST /v1/pack/routing/undo', {
        minimum: 'operator',
        caller: 'person',
        capability: packConfigure,
        noStore: true,
        audit: { record: AUDIT_KINDS['fleet.configured'] },
        guard: { none: 'answers a sentence' },
      }),
      route('POST /v1/pack/recommend', {
        minimum: 'operator',
        caller: 'any',
        capability: packUse,
        noStore: true,
        audit: { skip: 'a read: it starts nothing' },
        guard: { none: 'the routing prompt and model ids; no pane text' },
      }),
      route('GET /v1/ferrets/:ferretId/result', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of what a finished ferret reported' },
        guard: 'secrets',
      }),
      route('GET /v1/ferrets/:ferretId/pack', {
        minimum: 'operator',
        caller: 'any',
        capability: packUse,
        noStore: true,
        audit: { skip: 'a read of a lead’s pack table' },
        guard: 'secrets',
      }),
      route('PATCH /v1/ferrets/:ferretId/pack', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { skip: 'not recorded today (docs/audit.md has no pack row)' },
        guard: { none: 'a ferret summary and one sentence' },
      }),
    ],
    cli: [
      verb('recommend [task...]', {
        summary: 'the routing prompt and the models that can run a piece of work here now (Pack mode)',
      }),
      verb('pack [id]', {
        summary:
          'a table of every live ferret in a pack: model, state, card and its last line (defaults to the calling ferret)',
      }),
      verb('guide', { summary: 'the routing prompt Pack mode picks helper models with' }),
      verb('guide show', {
        summary: 'the routing prompt in effect, where it came from, and whether a clean-up can be undone',
      }),
      verb('guide inventory', {
        summary: 'what Clean up is shown: every runtime, its models, readiness and quota, and every model',
      }),
      verb('guide clean-up', {
        summary:
          'have a short-lived ferret rewrite the routing prompt to fit (one model run), then review it as a diff',
      }),
      verb('guide write', {
        summary: 'have a short-lived ferret write the routing prompt from a short idea (one model run), then review it',
      }),
      verb('guide accept <run>', {
        summary: 'write a run’s checked rewrite as the routing prompt (undo puts the old one back)',
      }),
      verb('guide undo', { summary: 'put back the routing prompt the last accepted clean-up replaced' }),
    ],
  },

  ui: {
    screens: [],
    // Settings › Agents › Pack mode: the switch, who decides, the limits, the probe and the routing prompt.
    settings: [settingsTab('pack', { label: 'Pack mode', order: 40 })],
    // A parent's view of the helpers it started, beside the ferret.
    panels: [
      panel('ferret.side', { id: 'helpers', order: 40 }),
      // The Pack card, beside a transcript row that holds a Pack command (Conversation's `conversation.row` slot).
      panel(CONVERSATION_ROW_SLOT, { id: 'pack-call', order: 40 }),
    ],
  },

  data: {
    state: [PACK_RUNS, PACK_REPLACED, PACK_SWITCHES],
    config: [PACKS_CONFIG],
    readModels: ['view', 'recommend', 'routingLine', 'instructed', 'result', 'table'],
  },

  hooks: { takes: [{ hook: StartDecide }, { hook: LaunchParts }] },

  // No root, host or secret: a finished ferret's summary is read through Ferrets (`FerretsApi.summary`), Clean up refuses
  // to start while no folder for its ferret is handed to Pack mode, and the probe and the clean-up ferret run through
  // Runtimes and Ferrets.
  // Jev's ranking went with `fy new` (it ranked only `new --auto`), so nothing here calls out or spends.
  permissions: { roots: [], network: [], spawn: [], secrets: [] },
});
