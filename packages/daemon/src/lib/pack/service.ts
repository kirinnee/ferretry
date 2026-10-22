/**
 * PACK MODE'S APPLICATION SERVICE (docs/pack-mode.md): the view the settings page reads, the
 * recommendation `fy recommend` prints, and `fy new` — admission, the candidate order (the asking
 * ferret's, the guide's, or Jev's), the probe, then the start.
 *
 * A refusal is an ANSWER here, never an exception: a ferret reads the closed code and the attempts
 * from one value and falls back to its next candidate.
 */
import type {
  FleetRuntimeView,
  ModelCatalogView,
  ModelsGuide,
  ModelsGuideFile,
  PackAttempt,
  PackConfig,
  PackNewOutcome,
  PackNewRequest,
  PackRecommendation,
  PackRefusal,
  PackView,
  SessionView,
  StartSessionRequest,
} from '@ferretry/protocol';
import { taskTitleFor } from '@ferretry/protocol';
import { admitChild, type ParentFacts } from './admission.ts';
import { effectiveGuide, fleetModels } from './guide.ts';
import type { PackJevPort } from './jev.ts';
import type { CachedProbe, PackProbeRequest } from './probe.ts';
import { type PackFleetFacts, recommend, runtimeRefusal } from './recommend.ts';
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
  /** Starts the sub-ferret; throws {@link PackStartRefused} when admission refuses it. */
  start(request: StartSessionRequest): Promise<SessionView>;
  jev: PackJevPort;
  /** Jev's spend on Pack mode today (UTC), and recording one more answer's. */
  spend: { today(): Promise<number>; record(usd: number): Promise<void> };
  /** The shipped command name, so every command it prints exists after a rename. */
  readonly bin: string;
}

/** What `start` is given: a candidate the service decided to try. */
interface Choice {
  readonly runtime: FleetRuntimeView;
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

const refused = (refusal: PackRefusal, attempts: readonly PackAttempt[]): PackNewOutcome => ({
  outcome: 'refused',
  refusal,
  attempts,
});

/** What a sub-ferret is told after its brief: who started it, and how its result reaches them. */
export function subFerretFooter(bin: string, parent: string | undefined): string {
  const who = parent === undefined ? 'with `new`' : `by ferret ${parent}`;
  return `\n\n---\nYou are a sub-ferret, started ${who} (Pack mode). When the work is done, finish with \`${bin} signal done "<your result: what you did, what you found, what is left>"\` — that message is what is handed back.`;
}

export class PackService {
  constructor(private readonly ports: PackPorts) {}

  async view(): Promise<PackView> {
    const [settings, catalogs, facts] = await Promise.all([
      this.ports.settings(),
      this.ports.catalogs(),
      this.ports.facts(),
    ]);
    return {
      config: settings.config,
      guide: effectiveGuide(settings.guideFile, catalogs, this.ports.bin),
      models: fleetModels(catalogs, facts.runtimes),
    };
  }

  /**
   * The one-line routing guidance a Pack ferret's system prompt carries (`FY_PACK_ROUTING`), from the
   * guide in effect now — derived at every launch, so a restart hears the latest saved guide.
   */
  async routingShort(): Promise<string | undefined> {
    const [settings, catalogs] = await Promise.all([this.ports.settings(), this.ports.catalogs()]);
    return effectiveGuide(settings.guideFile, catalogs, this.ports.bin).routing?.short;
  }

  /** `undefined` for a guide with no use case at all. */
  async recommend(input: {
    readonly task: string;
    readonly useCase?: string;
  }): Promise<PackRecommendation | undefined> {
    return (await this.recommendWithGuide(input)).recommendation;
  }

  /** The recommendation, and the guide it was made from. */
  private async recommendWithGuide(input: {
    readonly task: string;
    readonly useCase?: string;
  }): Promise<{ readonly recommendation: PackRecommendation | undefined; readonly guide: ModelsGuide }> {
    const [settings, catalogs, facts] = await Promise.all([
      this.ports.settings(),
      this.ports.catalogs(),
      this.ports.facts(),
    ]);
    const labels = new Map(
      catalogs.flatMap(catalog =>
        [...(catalog.claude ?? []), ...(catalog.codex ?? [])].map(
          entry => [`${catalog.id}\u0000${entry.id}`, entry.label] as const,
        ),
      ),
    );
    const guide = effectiveGuide(settings.guideFile, catalogs, this.ports.bin);
    return { recommendation: recommend({ ...input, bin: this.ports.bin }, guide, facts, labels), guide };
  }

  async newChild(request: PackNewRequest): Promise<PackNewOutcome> {
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

    const facts = await this.ports.facts();
    const ordered = request.auto === true ? await this.automatic(request, settings, facts) : this.named(request, facts);
    if ('refusal' in ordered) return refused(ordered.refusal, []);
    return await this.tryInOrder(request, ordered, cwd, config, parent?.id);
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

  /** The guide's ready candidates, in the guide's order or Jev's. */
  private async automatic(
    request: PackNewRequest,
    settings: PackSettings,
    facts: PackFleetFacts,
  ): Promise<
    | { readonly choices: readonly Choice[]; readonly decidedBy: 'guide' | 'jev'; readonly note?: string }
    | { readonly refusal: PackRefusal }
  > {
    const { recommendation, guide } = await this.recommendWithGuide({
      task: request.task,
      ...(request.useCase === undefined ? {} : { useCase: request.useCase }),
    });
    const ready = (recommendation?.candidates ?? []).filter(candidate => candidate.ready);
    const choices = ready.flatMap(candidate => {
      const runtime = facts.runtimes.find(row => row.name === candidate.runtime);
      return runtime === undefined
        ? []
        : [{ runtime, model: candidate.model, effort: request.effort ?? candidate.effort }];
    });
    if (choices.length === 0) {
      const why = recommendation?.candidates[0]?.refusal?.message;
      return {
        refusal: {
          code: 'no_candidate',
          message: `Nothing in the models guide can run here now${why === undefined ? '' : `: ${why}`}`,
          remedy: 'Do the work yourself, or ask the owner to sign a login in.',
        },
      };
    }
    if (settings.config.decision !== 'jev' || choices.length === 1) return { choices, decidedBy: 'guide' };
    const spent = await this.ports.spend.today();
    if (spent >= settings.config.jev.usdPerDay)
      return {
        choices,
        decidedBy: 'guide',
        note: "Jev's daily cap for Pack mode is reached, so the guide's order was used.",
      };
    // Jev decides WITH the owner's guide: its routing prompt, the use case matched, and each login's quota.
    const useCase = guide.useCases.find(entry => entry.id === recommendation?.useCase.id);
    const ranking = await this.ports.jev.rank(
      request.task,
      ready.map(candidate => ({
        model: candidate.model,
        runtime: candidate.runtime ?? '',
        why: candidate.why,
        ...(candidate.quota === undefined || candidate.quota.state === 'unknown'
          ? {}
          : { quota: candidate.quota.summary }),
      })),
      {
        ...(guide.routing === undefined ? {} : { routing: guide.routing.prompt }),
        ...(useCase === undefined ? {} : { useCase: { title: useCase.title, description: useCase.description } }),
      },
    );
    if (ranking.kind === 'failed')
      return {
        choices,
        decidedBy: 'guide',
        note: `Jev could not decide (${ranking.reason}), so the guide's order was used.`,
      };
    await this.ports.spend.record((ranking.inputTokens / 1_000_000) * settings.jevUsdPerMillionInputTokens);
    return { choices: ranking.order.map(index => choices[index] as Choice), decidedBy: 'jev' };
  }

  /** Probes each choice in turn and starts the first that answers. */
  private async tryInOrder(
    request: PackNewRequest,
    ordered: {
      readonly choices: readonly Choice[];
      readonly decidedBy: 'agent' | 'guide' | 'jev';
      readonly note?: string;
    },
    cwd: string,
    config: PackConfig,
    parent: string | undefined,
  ): Promise<PackNewOutcome> {
    const attempts: PackAttempt[] = [];
    let last: PackRefusal | undefined;
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
      try {
        const view = await this.ports.start({
          mode: request.mode ?? 'auto',
          agent: choice.runtime.wrapper,
          prompt: `${request.task}${subFerretFooter(this.ports.bin, parent)}`,
          boardAccess: 'none',
          cwd,
          ...(parent === undefined ? {} : { parent }),
          ...(choice.model === undefined ? {} : { model: choice.model }),
          ...(choice.effort === undefined ? {} : { effort: choice.effort }),
          name: request.name ?? taskTitleFor(request.task, request.useCase ?? 'Sub-ferret'),
        });
        attempts.push({ runtime, ...named, outcome: 'started', probe, probeMs: probed.outcome.ms });
        return {
          outcome: 'started',
          view,
          decidedBy: ordered.decidedBy,
          attempts,
          ...(ordered.note === undefined ? {} : { note: ordered.note }),
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
