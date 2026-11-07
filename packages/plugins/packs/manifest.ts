import { FerretsPort, LaunchParts, StartDecide } from '@ferretry/core-ferrets/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import type { ConfigDef } from '@ferretry/kernel/contract';
import { definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { RuntimesPort } from '@ferretry/plugin-runtimes/contract';
import {
  PACK_JEV_SPEND,
  PACK_REPLACED,
  PACK_RUNS,
  PACK_SWITCHES,
  PACKS,
  PACKS_CONFIG,
  PACKS_WORDS,
  PackHelperStarted,
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
 * `POST /v1/recommend` (the account recommender) is Runtimes' (`POST /v1/runtimes/recommend`).
 *
 * `guard: 'secrets'` on the two routes that carry text a ferret wrote (a result, a pack table's last lines): their
 * bodies are built inside one `Redaction.read` (§7.3). The other answers are model ids, runtime and login NAMES,
 * readiness and quota; the routing prompt is the owner's words.
 *
 * It takes `start.decide` (admission: depth and how many children a parent may have, whichever command started the
 * child) and `launch.parts` (the `FY_PACK` switch and the routing line a launch carries, which Ferrets cannot ask a
 * plugin's port for). Usage and Runtimes are optional: with them off a ferret can still start a helper by hand, there are
 * no recommendations.
 */
export default definePlugin({
  id: PACKS,
  title: 'Packs',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
  words: PACKS_WORDS,

  // Vault: Jev's key is spent through `authorizeFetch` (one named secret on one request, never read).
  needs: { ferrets: FerretsPort, vault: VaultPort },
  uses: { usage: UsagePort, runtimes: RuntimesPort },
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
        audit: { skip: 'not recorded today (docs/audit.md has no pack row); the run is its own record' },
        guard: { none: 'answers a run id and a sentence' },
      }),
      route('GET /v1/pack/routing/jobs/:jobId', {
        minimum: 'operator',
        caller: 'any',
        capability: packUse,
        noStore: true,
        audit: { skip: 'a read of one run' },
        guard: { none: 'the rewrite the owner asked for; no pane text' },
      }),
      route('POST /v1/pack/routing/accept', {
        minimum: 'operator',
        caller: 'person',
        capability: packConfigure,
        noStore: true,
        audit: { skip: 'not recorded today (docs/audit.md has no pack row); the previous prompt is kept for one undo' },
        guard: { none: 'answers a sentence' },
      }),
      route('POST /v1/pack/routing/undo', {
        minimum: 'operator',
        caller: 'person',
        capability: packConfigure,
        noStore: true,
        audit: { skip: 'not recorded today (docs/audit.md has no pack row)' },
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
      route('POST /v1/pack/new', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'the start is recorded as the ferret it starts; a refusal is an answer' },
        guard: { none: 'a ferret summary and the attempts made; the brief is not echoed' },
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
      verb('new [words...]', {
        summary: 'start a helper on a chosen model (Pack mode; `fy wait <id>` collects its result)',
      }),
      verb('wait <id>', {
        summary:
          'block until a ferret settles and print its result; exits 0 completed, 1 ended, 3 needs a human, 69 daemon lost, 124 timeout',
      }),
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
    // Settings › Agents › Pack mode: the switch, who decides, the limits, the probe, Jev's cap and the routing prompt.
    settings: [settingsTab('pack', { label: 'Pack mode', order: 40 })],
    // A parent's view of the helpers it started, beside the ferret.
    panels: [panel('ferret.side', { id: 'helpers', order: 40 })],
  },

  data: {
    state: [PACK_RUNS, PACK_REPLACED, PACK_JEV_SPEND, PACK_SWITCHES],
    config: [PACKS_CONFIG as unknown as ConfigDef],
    readModels: ['view', 'recommend', 'routingLine', 'instructed', 'result', 'table'],
    publishes: [PackHelperStarted],
  },

  hooks: { takes: [{ hook: StartDecide }, { hook: LaunchParts }] },

  // Jev ranks the models usable now through Vault's `authorizeFetch`: one named secret on one request to its one host.
  // The probe and the clean-up ferret run through Runtimes and Ferrets, not a process of Packs.
  permissions: { roots: ['agent-homes'], network: ['api.typesafe.ai'], spawn: [], secrets: ['JEV_API_KEY'] },
});
