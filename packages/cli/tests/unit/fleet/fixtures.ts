import type { IFleetOutput, IRecommendationGateway } from '../../../src/lib/fleet/ports';
import type { RecommendationRequest, TeamRecommendation } from '../../../src/lib/fleet/wire';

export const ACCOUNT_ID = '00000000-0000-4000-8000-00000000c1a0';

/** Captures what a controller printed. */
export class CapturingOutput implements IFleetOutput {
  readonly lines: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export function recommendation(overrides: Partial<TeamRecommendation> = {}): TeamRecommendation {
  return {
    task: 'port the remaining CLI command groups',
    classification: 'implementation',
    reasoning: 'a long, many-checkpoint port benefits from a high-context implementer',
    roles: [
      {
        role: 'implementer',
        why: 'the work is mostly writing modules with tests',
        primary: {
          agent: 'sol',
          accountId: ACCOUNT_ID,
          model: 'gpt-5.6',
          tradeoff: 'expensive, but holds the whole unit',
          score: 0.91,
        },
        alternatives: [
          { agent: 'terra', accountId: ACCOUNT_ID, model: 'gpt-5.6', tradeoff: 'cheaper, shorter context', score: 0.7 },
        ],
      },
    ],
    exclusions: [],
    warnings: [],
    ...overrides,
  };
}

/** A recommender recording what it was asked. */
export class RecordingRecommendationGateway implements IRecommendationGateway {
  readonly requests: RecommendationRequest[] = [];

  constructor(private readonly value: TeamRecommendation = recommendation()) {}

  recommend(request: RecommendationRequest): Promise<TeamRecommendation> {
    this.requests.push(request);
    return Promise.resolve(this.value);
  }
}
