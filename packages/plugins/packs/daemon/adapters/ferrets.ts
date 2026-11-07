import type { FerretId, FerretsApi, FerretSummary, PackId } from '@ferretry/core-ferrets/contract';
import { PACK_CLEAN_UP_PACK, type PackConfig, type PackRefusal } from '../../contract/index.ts';
import { admitChild, depthOf, runningChildCount } from '../lib/admission.ts';
import type { Delegation } from '../lib/cards.ts';
import type { CleanUpStartRequest } from '../lib/cleanup/service.ts';
import { type HelperStarted, type HelperStartRequest, type PackParent, PackStartRefused } from '../lib/service.ts';

/** A ferret that is a person's own terminal is interactive: its helpers are held to the wider limit. */
const isInteractive = (ferret: FerretSummary): boolean =>
  ferret.mode === 'interactive' || (ferret.mode === undefined && ferret.role === 'lead');

/**
 * Pack mode's view of the Ferrets port: a parent as admission needs it (depth, running children, its own switch) and the
 * start of a helper or of the clean-up ferret. A start the daemon's own admission refused is recovered as the closed code
 * a ferret can act on (`PackStartRefused`), never a bare failure sentence.
 */
export class PackFerrets {
  constructor(
    private readonly ferrets: () => FerretsApi,
    private readonly switchOf: (ferret: string) => Promise<boolean | undefined>,
    private readonly limits: () => Promise<PackConfig['limits']>,
  ) {}

  async depth(ferret: string): Promise<number> {
    return await depthOf(ferret, async id => await this.ferrets().get(id as FerretId));
  }

  async parent(id: string): Promise<PackParent | undefined> {
    const ferrets = this.ferrets();
    const summary = await ferrets.get(id as FerretId);
    if (summary === undefined) return undefined;
    const [depth, children, pack] = await Promise.all([
      this.depth(id),
      ferrets.list({ parent: id as FerretId }),
      this.switchOf(id),
    ]);
    return {
      id,
      interactive: isInteractive(summary),
      depth,
      runningChildren: runningChildCount(id, children),
      cwd: summary.folder,
      ...(pack === undefined ? {} : { pack }),
    };
  }

  async start(request: HelperStartRequest, delegation: Delegation | undefined): Promise<HelperStarted> {
    const ferrets = this.ferrets();
    const started = await ferrets.start({
      role: 'helper',
      by: 'pack',
      ...(request.parent === undefined ? {} : { parent: request.parent as FerretId }),
      harness: request.harness,
      runtime: request.runtime,
      folder: request.cwd,
      prompt: request.prompt,
      options: {
        title: request.name,
        mode: request.mode,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        ...(delegation?.existing === true ? { card: delegation.id } : {}),
      },
    });
    if (!started.ok) throw await this.refusal(request, started.error);
    const ferret = await ferrets.get(started.value);
    if (ferret === undefined)
      throw new PackStartRefused({
        code: 'start_failed',
        message: `${request.runtime} did not start: the ferret is gone.`,
      });
    return {
      ferret,
      ...(ferret.card === undefined ? {} : { focusCard: ferret.card }),
      ...(ferret.state === 'stopped' ? { startFailure: '' } : {}),
    };
  }

  /** The hidden builder ferret: started under its own pack id in a Ferretry folder, never in a project. */
  async startBuilder(
    request: CleanUpStartRequest,
  ): Promise<{ readonly id: string; readonly name?: string | undefined }> {
    const ferrets = this.ferrets();
    const started = await ferrets.start({
      role: 'helper',
      by: 'pack',
      pack: (request.pack || PACK_CLEAN_UP_PACK) as PackId,
      harness: request.harness,
      runtime: request.runtime,
      folder: request.cwd,
      prompt: request.prompt,
      options: {
        title: request.name,
        mode: request.mode,
        ...(request.model === undefined ? {} : { model: request.model }),
      },
    });
    if (!started.ok) throw new Error(started.error.reason);
    const ferret = await ferrets.get(started.value);
    return { id: started.value, ...(ferret === undefined ? {} : { name: ferret.name }) };
  }

  async state(ferret: string): Promise<string | undefined> {
    return (await this.ferrets().get(ferret as FerretId))?.state;
  }

  async stop(ferret: string, reason: string): Promise<void> {
    await this.ferrets().stop(ferret as FerretId, 'now', reason);
  }

  /** Why Ferrets said no: its own `refused` is admission's (`start.decide`), so recover which limit it was. */
  private async refusal(
    request: HelperStartRequest,
    failure: { readonly code: string; readonly reason: string },
  ): Promise<PackStartRefused> {
    if (failure.code === 'refused' && request.parent !== undefined) {
      const parent = await this.parent(request.parent);
      const admission = parent === undefined ? undefined : admitChild(parent, await this.limits());
      if (admission !== undefined) return new PackStartRefused(admission);
    }
    const refusal: PackRefusal = {
      code: 'start_failed',
      message: `${request.runtime} did not start: ${failure.reason}`,
      remedy: 'Try the next candidate.',
    };
    return new PackStartRefused(refusal);
  }
}
