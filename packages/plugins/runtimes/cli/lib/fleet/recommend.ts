import type { IFleetOutput, IRecommendationGateway } from './ports.ts';
import { renderRecommendation } from './render.ts';

/** Flags that shape a recommendation. */
export interface FleetRecommendOptions {
  readonly json?: boolean;
  /** commander's `--no-usage` sets this false; absent means probe. */
  readonly usage?: boolean;
}

/** The collaborators `fy fleet recommend` is wired with. */
export interface RecommendControllerDeps {
  readonly recommendations: IRecommendationGateway;
  readonly out: IFleetOutput;
  /** The shipped command name, so every hint names a command that exists after a rename. */
  readonly binaryName: string;
}

/** Drives `fy fleet recommend`: the daemon owns the routing catalog, so this only asks and prints. */
export class RecommendController {
  constructor(private readonly deps: RecommendControllerDeps) {}

  async recommend(words: readonly string[], options: FleetRecommendOptions): Promise<void> {
    const task = words.join(' ').replaceAll(/\s+/gu, ' ').trim();
    if (task === '') throw new Error(`describe the task: ${this.deps.binaryName} fleet recommend "<what needs doing>"`);
    const recommendation = await this.deps.recommendations.recommend({ task, usage: options.usage !== false });
    this.deps.out.success(
      options.json === true ? JSON.stringify(recommendation, null, 2) : renderRecommendation(recommendation),
    );
  }
}
