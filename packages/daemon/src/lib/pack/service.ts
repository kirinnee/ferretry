/**
 * PACK MODE'S APPLICATION SERVICE (docs/pack-mode.md): the view the settings page reads, what `fy recommend`
 * prints, the routing line a Pack ferret's system prompt carries, and `fy new` — admission, the candidate
 * order (the asking ferret's, the routing prompt's, or Jev's), the probe, then the start.
 *
 * ONE routing prompt drives every decision: the ferret reads it in its system prompt and in `recommend`,
 * `--auto` tries the models it names in its order, and Jev is given it as its guidance.
 *
 * A refusal is an ANSWER here, never an exception: a ferret reads the closed code and the attempts
 * from one value and falls back to its next candidate.
 */
import type {
  FleetRuntimeView,
  ModelCatalogView,
  ModelsGuideFile,
  PackAttempt,
  PackConfig,
  PackFleetModel,
  PackInventory,
  PackModelOption,
  PackNewOutcome,
  PackChildCard,
  PackNewRequest,
  PackRecommendation,
  PackRefusal,
  PackView,
  RoutingPromptView,
  SessionView,
  StartSessionRequestInput,
} from '@ferretry/protocol';
import { formatTaskRef, taskTitleFor } from '@ferretry/protocol';
import type { StartCaller } from '../api/state-homes.ts';
import { cardFooterLine, type Delegation, type DelegationOutcome, type SessionCards } from '../board/index.ts';
import { admitChild, type ParentFacts } from './admission.ts';
import { buildInventory } from './cleanup/inventory.ts';
import { PACK_JEV_LIMITS, type PackJevPort } from './jev.ts';
import type { CachedProbe, PackProbeRequest } from './probe.ts';
import { automaticOrder, availableModels, type PackFleetFacts, runtimeRefusal } from './recommend.ts';
import { defaultPrompt, effectiveRouting, fleetModels, routingLine } from './routing.ts';
import { SCRATCH_REMEDY, scratchMessage } from './scratch.ts';

/** The settings in effect, read fresh for every request. */
export interface PackSettings {
  readonly config: PackConfig;
  readonly guideFile: ModelsGuideFile;
  /** What Jev charges per million input tokens, the price its daily cap counts with. */
  readonly jevUsdPerMillionInputTokens: number;
}

/** A parent as `fy new` needs it: admission's facts, its working folder and its own switch. */
export interface PackParent extends ParentFacts {
  readonly cwd: string;
  /** Its own Pack switch; absent means on. */
  readonly pack?: boolean | undefined;
}

/** Why a start the service asked for was refused by the daemon's own admission, as a code it knows. */
export class PackStartRefused extends Error {
  constructor(readonly refusal: PackRefusal) {
    super(refusal.message);
    this.name = 'PackStartRefused';
  }
}

export interface PackPorts {
  settings(): Promise<PackSettings>;
  catalogs(): Promise<readonly ModelCatalogView[]>;
  facts(): Promise<PackFleetFacts>;
  /** `undefined` when there is no such session. */
  parent(id: string): Promise<PackParent | undefined>;
  /** Whether a folder a caller NAMED is a temporary or scratch one (`./scratch.ts`). */
  scratch(cwd: string): Promise<boolean>;
  probe(request: PackProbeRequest, ttlMs: number): Promise<CachedProbe>;
  /**
   * Starts the sub-ferret; throws {@link PackStartRefused} when admission refuses it. `delegation` is its
   * board card, reserved under the lead's focus card; the start writes it with the session.
   */
  start(
    request: StartSessionRequestInput,
    delegation: Delegation | undefined,
    caller: StartCaller,
  ): Promise<SessionView>;
  /** The lead's side of the sub-ferret's card (`SessionCards.delegate`), taken just before the first start. */
  cards: Pick<SessionCards, 'delegate'>;
  jev: PackJevPort;
  /** Jev's spend on Pack mode today (UTC), and recording one more answer's. */
  spend: { today(): Promise<number>; record(usd: number): Promise<void> };
  /** The shipped command name, so every command it prints exists after a rename. */
  readonly bin: string;
  /** Now, as an instant: when an inventory was taken. */
  now(): string;
}

/** What `start` is given: a candidate the service decided to try. */
interface Choice {
  readonly runtime: FleetRuntimeView;
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

/** Everything one decision reads, read once. */
interface Snapshot {
  readonly settings: PackSettings;
  readonly facts: PackFleetFacts;
  readonly models: readonly PackFleetModel[];
  readonly routing: RoutingPromptView;
  readonly available: readonly PackModelOption[];
}

const refused = (refusal: PackRefusal, attempts: readonly PackAttempt[]): PackNewOutcome => ({
  outcome: 'refused',
  refusal,
  attempts,
});

/**
 * What a sub-ferret is told after its brief: who started it, its board card when it has one
 * (`cardFooterLine`), and how its result reaches them.
 */
export function subFerretFooter(bin: string, parent: string | undefined, card?: string): string {
  const who = parent === undefined ? 'with `new`' : `by ferret ${parent}`;
  const named = card === undefined ? '' : ` ${card}`;
  return `\n\n---\nYou are a sub-ferret, started ${who} (Pack mode).${named} When the work is done, finish with \`${bin} signal done "<your result: what you did, what you found, what is left>"\` — that message is what is handed back.`;
}

/**
 * What `fy new` says about the sub-ferret's card: the one its new session focuses — which the start made —
 * the lead's own when one was made for it, and whatever the board could not do. `undefined` when there is
 * nothing to say (a daemon whose starts make no cards).
 */
export function startedCard(
  view: SessionView,
  delegation: Delegation | undefined,
  notes: readonly string[],
): PackChildCard | undefined {
  const focus = view.config.focusTask;
  const made = focus !== undefined && (delegation === undefined || focus.id === delegation.id);
  const said = [
    ...notes,
    ...(delegation === undefined || made
      ? []
      : [`${formatTaskRef(delegation)} could not be made, so the sub-ferret started without a card.`]),
  ];
  if (!made && said.length === 0) return undefined;
  return {
    ...(made ? { id: focus.id } : {}),
    ...(made && delegation?.project !== undefined ? { project: delegation.project } : {}),
    ...(made && delegation?.parent != null ? { parent: delegation.parent.id } : {}),
    ...(made && delegation?.parentFrom !== undefined ? { parentFrom: delegation.parentFrom } : {}),
    ...(made && delegation?.existing === true ? { existing: true as const } : {}),
    ...(said.length === 0 ? {} : { note: said.join(' ') }),
  };
}

/** How Jev is told what a candidate is: its label and tier, and where the routing prompt names it. */
const candidateWhy = (option: PackModelOption): string =>
  [
    option.modelLabel,
    option.tier === undefined ? undefined : `${option.tier} tier`,
    option.named === undefined ? undefined : `named ${String(option.named)} in the routing prompt`,
    option.effort === undefined ? undefined : `at ${option.effort} effort`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(', ');

export class PackService {
  constructor(private readonly ports: PackPorts) {}

  private async snapshot(): Promise<Snapshot> {
    const [settings, catalogs, facts] = await Promise.all([
      this.ports.settings(),
      this.ports.catalogs(),
      this.ports.facts(),
    ]);
    const models = fleetModels(catalogs, facts.runtimes);
    const routing = effectiveRouting(settings.guideFile, catalogs, facts.runtimes, this.ports.bin);
    return {
      settings,
      facts,
      models,
      routing,
      available: availableModels(facts, models, routing.text, this.ports.bin),
    };
  }

  /** The settings, the routing prompt in effect, the vocabulary and the models usable now. */
  async view(): Promise<Omit<PackView, 'undo' | 'cleanUp'>> {
    const { settings, models, routing, available } = await this.snapshot();
    return { config: settings.config, routing, models, available };
  }

  /** The default routing prompt, rendered from the catalogs in effect, whatever the file says. */
  async defaultPrompt(): Promise<string> {
    const [catalogs, facts] = await Promise.all([this.ports.catalogs(), this.ports.facts()]);
    return defaultPrompt(fleetModels(catalogs, facts.runtimes), this.ports.bin);
  }

  /** What the clean-up ferret is shown (`./cleanup/inventory.ts`): the harness config, names and states only. */
  async inventory(): Promise<PackInventory> {
    const { facts, models, routing } = await this.snapshot();
    return buildInventory({ facts, models, routing, now: facts.now ?? this.ports.now() });
  }

  /**
   * The routing prompt as the one line a Pack ferret's system prompt carries (`FY_PACK_ROUTING`), from the
   * prompt in effect now — derived at every launch, so a restart hears the latest saved prompt.
   */
  async routingLine(): Promise<string> {
    const [settings, catalogs, facts] = await Promise.all([
      this.ports.settings(),
      this.ports.catalogs(),
      this.ports.facts(),
    ]);
    return routingLine(effectiveRouting(settings.guideFile, catalogs, facts.runtimes, this.ports.bin).text);
  }

  /** The routing prompt and the models usable now; `next` is what `--auto` would try first. */
  async recommend(input: { readonly task?: string | undefined }): Promise<PackRecommendation> {
    const { routing, available } = await this.snapshot();
    const first = automaticOrder(available)[0];
    return {
      ...(input.task === undefined ? {} : { task: input.task }),
      routing,
      available,
      ...(first?.command === undefined ? {} : { next: first.command }),
    };
  }

  /** `caller`: who asked, as the boundary decided it — an agent's start is held out of the state home. */
  async newChild(request: PackNewRequest, caller: StartCaller): Promise<PackNewOutcome> {
    const settings = await this.ports.settings();
    const config = settings.config;
    if (!config.enabled)
      return refused(
        { code: 'pack_off', message: 'Pack mode is off on this machine.', remedy: 'Do the work yourself.' },
        [],
      );
    const parent = request.parent === undefined ? undefined : await this.ports.parent(request.parent);
    if (request.parent !== undefined && parent === undefined)
      return refused(
        { code: 'unknown_runtime', message: `There is no ferret ${request.parent} to start a sub-ferret for.` },
        [],
      );
    if (parent?.pack === false)
      return refused(
        { code: 'pack_off', message: `Pack mode is off for ${parent.id}.`, remedy: 'Do the work yourself.' },
        [],
      );
    const admission = parent === undefined ? undefined : admitChild(parent, config.limits);
    if (admission !== undefined) return refused(admission, []);
    // A sub-ferret runs in its PARENT'S folder, so it lands in the parent's project; only a named folder can
    // move it, and a named temporary one is refused unless the caller says it means it.
    const cwd = request.cwd ?? parent?.cwd;
    if (cwd === undefined)
      return refused(
        { code: 'unknown_runtime', message: 'A sub-ferret with no parent must name its working folder (--cwd).' },
        [],
      );
    if (request.cwd !== undefined && request.allowScratch !== true && (await this.ports.scratch(request.cwd)))
      return refused({ code: 'scratch_cwd', message: scratchMessage(request.cwd), remedy: SCRATCH_REMEDY }, []);

    const ordered =
      request.auto === true ? await this.automatic(request) : this.named(request, await this.ports.facts());
    if ('refusal' in ordered) return refused(ordered.refusal, []);
    return await this.tryInOrder(request, ordered, cwd, config, parent?.id, caller);
  }

  /** The one runtime the ferret named, checked before anything is probed. */
  private named(
    request: PackNewRequest,
    facts: PackFleetFacts,
  ): { readonly choices: readonly Choice[]; readonly decidedBy: 'agent' } | { readonly refusal: PackRefusal } {
    const runtime = facts.runtimes.find(
      candidate => candidate.name === request.runtime || candidate.wrapper === request.runtime,
    );
    if (runtime === undefined)
      return {
        refusal: {
          code: 'unknown_runtime',
          message: `There is no runtime ${String(request.runtime)} on this machine.`,
          remedy: `\`${this.ports.bin} recommend "<task>"\` lists the runtimes that can run it.`,
        },
      };
    const refusal = runtimeRefusal(runtime, request.model, facts);
    if (refusal !== undefined) return { refusal };
    return { choices: [{ runtime, model: request.model, effort: request.effort }], decidedBy: 'agent' };
  }

  /** The models usable now, in the routing prompt's order or Jev's. */
  private async automatic(
    request: PackNewRequest,
  ): Promise<
    | { readonly choices: readonly Choice[]; readonly decidedBy: 'routing' | 'jev'; readonly note?: string }
    | { readonly refusal: PackRefusal }
  > {
    const { settings, facts, routing, available } = await this.snapshot();
    const choiceOf = (option: PackModelOption): readonly Choice[] => {
      const runtime = facts.runtimes.find(row => row.name === option.runtime);
      return runtime === undefined ? [] : [{ runtime, model: option.model, effort: request.effort ?? option.effort }];
    };
    const ordered = automaticOrder(available);
    const choices = ordered.flatMap(choiceOf);
    if (choices.length === 0) {
      const why = available[0]?.refusal?.message;
      return {
        refusal: {
          code: 'no_candidate',
          message: `No model a runtime here offers can run now${why === undefined ? '' : `: ${why}`}`,
          remedy: 'Do the work yourself, or ask the owner to sign a login in.',
        },
      };
    }
    if (settings.config.decision !== 'jev') return { choices, decidedBy: 'routing' };
    // Jev chooses among everything ready — the routing prompt's order first — guided by that same prompt.
    const pool = [...ordered, ...available.filter(option => option.ready && !ordered.includes(option))].slice(
      0,
      PACK_JEV_LIMITS.maxCandidates,
    );
    if (pool.length === 1) return { choices, decidedBy: 'routing' };
    const spent = await this.ports.spend.today();
    if (spent >= settings.config.jev.usdPerDay)
      return {
        choices,
        decidedBy: 'routing',
        note: "Jev's daily cap for Pack mode is reached, so the routing prompt's order was used.",
      };
    const ranking = await this.ports.jev.rank(
      request.task,
      pool.map(option => ({
        model: option.model,
        runtime: option.runtime,
        why: candidateWhy(option),
        ...(option.quota.state === 'unknown' ? {} : { quota: option.quota.summary }),
      })),
      { routing: routing.text },
    );
    if (ranking.kind === 'failed')
      return {
        choices,
        decidedBy: 'routing',
        note: `Jev could not decide (${ranking.reason}), so the routing prompt's order was used.`,
      };
    await this.ports.spend.record((ranking.inputTokens / 1_000_000) * settings.jevUsdPerMillionInputTokens);
    return { choices: ranking.order.flatMap(index => choiceOf(pool[index] as PackModelOption)), decidedBy: 'jev' };
  }

  /** Probes each choice in turn and starts the first that answers. */
  private async tryInOrder(
    request: PackNewRequest,
    ordered: {
      readonly choices: readonly Choice[];
      readonly decidedBy: 'agent' | 'routing' | 'jev';
      readonly note?: string;
    },
    cwd: string,
    config: PackConfig,
    parent: string | undefined,
    caller: StartCaller,
  ): Promise<PackNewOutcome> {
    const attempts: PackAttempt[] = [];
    let last: PackRefusal | undefined;
    let card: DelegationOutcome | undefined;
    for (const choice of ordered.choices) {
      const model = choice.model ?? choice.runtime.models?.default;
      const probed = await this.ports.probe(
        {
          wrapper: choice.runtime.wrapper,
          harness: choice.runtime.harness,
          model,
          ...(choice.effort === undefined ? {} : { effort: choice.effort }),
          cwd,
          timeoutMs: config.probe.timeoutSeconds * 1_000,
        },
        config.probe.cacheSeconds * 1_000,
      );
      const runtime = choice.runtime.name;
      const named = model === undefined ? {} : { model };
      const probe = probed.cached ? ('cached' as const) : ('ran' as const);
      if (!probed.outcome.ok) {
        last = {
          code: probed.outcome.code ?? 'probe_failed',
          message: `${runtime} did not answer a "reply OK" check${model === undefined ? '' : ` on ${model}`}: ${probed.outcome.reason}.`,
          remedy: 'Try the next candidate.',
        };
        attempts.push({ runtime, ...named, outcome: 'refused', refusal: last, probe, probeMs: probed.outcome.ms });
        continue;
      }
      // The card is the LEAD's delegation (board-design.md §3.1): reserved once, just before the first start
      // that will run, so a refusal before any start costs the board nothing.
      if (parent !== undefined && card === undefined)
        card = await this.ports.cards.delegate(
          parent,
          {
            brief: request.task,
            name: request.name ?? taskTitleFor(request.task, 'Sub-ferret'),
            card: request.card,
          },
          request.cwd === undefined,
        );
      if (card?.refusal !== undefined) {
        return refused(
          {
            code: 'card_unavailable',
            message: card.refusal,
            remedy: `Name a card you own that is open, or leave --card off to make a new one.`,
          },
          attempts,
        );
      }
      const delegation = card?.delegation;
      try {
        const view = await this.ports.start(
          {
            mode: request.mode ?? 'auto',
            agent: choice.runtime.wrapper,
            prompt: `${request.task}${subFerretFooter(
              this.ports.bin,
              parent,
              delegation === undefined
                ? undefined
                : cardFooterLine(delegation.id, delegation.project, this.ports.bin, delegation.parent),
            )}`,
            cwd,
            ...(parent === undefined ? {} : { parent }),
            ...(choice.model === undefined ? {} : { model: choice.model }),
            ...(choice.effort === undefined ? {} : { effort: choice.effort }),
            name: request.name ?? taskTitleFor(request.task, 'Sub-ferret'),
          },
          delegation,
          caller,
        );
        attempts.push({ runtime, ...named, outcome: 'started', probe, probeMs: probed.outcome.ms });
        const childCard = startedCard(view, delegation, card?.notes ?? []);
        return {
          outcome: 'started',
          view,
          decidedBy: ordered.decidedBy,
          attempts,
          ...(ordered.note === undefined ? {} : { note: ordered.note }),
          ...(childCard === undefined ? {} : { card: childCard }),
        };
      } catch (error) {
        if (!(error instanceof PackStartRefused)) throw error;
        attempts.push({ runtime, ...named, outcome: 'refused', refusal: error.refusal, probe });
        return refused(error.refusal, attempts);
      }
    }
    return refused(last as PackRefusal, attempts);
  }
}
