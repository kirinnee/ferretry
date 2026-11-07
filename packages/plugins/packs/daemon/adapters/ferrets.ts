import type { FerretId, FerretsApi, FerretSummary, PackId } from '@ferretry/core-ferrets/contract';
import { PACK_CLEAN_UP_PACK } from '../../contract/index.ts';
import { depthOf, type ParentFacts, runningChildCount } from '../lib/admission.ts';
import type { CleanUpStartRequest } from '../lib/cleanup/service.ts';

/** A ferret that is a person's own terminal is interactive: its helpers are held to the wider limit. */
const isInteractive = (ferret: FerretSummary): boolean =>
  ferret.mode === 'interactive' || (ferret.mode === undefined && ferret.role === 'lead');

/**
 * Pack mode's view of the Ferrets port: a parent as admission needs it (depth, running children) and the start of the
 * clean-up ferret. Helpers are started by Ferrets (`fy new`); Packs only answers `start.decide` for them.
 */
export class PackFerrets {
  constructor(private readonly ferrets: () => FerretsApi) {}

  async depth(ferret: string): Promise<number> {
    return await depthOf(ferret, async id => await this.ferrets().get(id as FerretId));
  }

  async parent(id: string): Promise<ParentFacts | undefined> {
    const ferrets = this.ferrets();
    const summary = await ferrets.get(id as FerretId);
    if (summary === undefined) return undefined;
    const [depth, children] = await Promise.all([this.depth(id), ferrets.list({ parent: id as FerretId })]);
    return { id, interactive: isInteractive(summary), depth, runningChildren: runningChildCount(id, children) };
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
}
