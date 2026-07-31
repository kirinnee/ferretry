import {
  type LearningActionRequest,
  LearningActionRequestSchema,
  type LearningConfig,
  LearningConfigSchema,
  type LearningPatchResponse,
  LearningPatchResponseSchema,
  LearningRunRequestSchema,
  type LearningStatus,
  LearningStatusSchema,
  type ProposalState,
  type ProposalView,
  ProposalViewSchema,
  type RunManifest,
  RunManifestSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { ILearningGateway, LearningApiClient } from './ports.ts';

/** The learning subsystem's read routes. */
export const LEARNING_STATUS_PATH = '/v1/learning/status';
export const LEARNING_CONFIG_PATH = '/v1/learning/config';
export const LEARNING_RUN_PATH = '/v1/learning/run';

/** The proposal board, optionally narrowed to one lifecycle state. */
export function learningProposalsPath(state?: ProposalState): string {
  return state === undefined ? '/v1/learning/proposals' : `/v1/learning/proposals?state=${encodeURIComponent(state)}`;
}

/** One proposal, addressed by id. */
export function learningProposalPath(id: string): string {
  return `/v1/learning/proposals/${encodeURIComponent(id)}`;
}

/** The guidance file one accepted proposal edits. */
export function learningPatchPath(id: string): string {
  return `${learningProposalPath(id)}/patch`;
}

const ProposalListSchema = z.array(ProposalViewSchema);

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Speaks the learning routes through the protocol client.
 *
 * Every response is parsed against a protocol schema, so a daemon answering with an error envelope
 * fails here with a stated reason rather than inside a renderer reading fields off `undefined`.
 */
export class ProtocolLearningGateway implements ILearningGateway {
  constructor(private readonly client: LearningApiClient) {}

  async status(): Promise<LearningStatus> {
    return await this.client.request(LEARNING_STATUS_PATH, LearningStatusSchema);
  }

  async proposals(state?: ProposalState): Promise<readonly ProposalView[]> {
    return await this.client.request(learningProposalsPath(state), ProposalListSchema);
  }

  async act(id: string, request: LearningActionRequest): Promise<ProposalView> {
    const body = LearningActionRequestSchema.parse(request);
    return await this.client.request(learningProposalPath(id), ProposalViewSchema, jsonPost(body));
  }

  async run(spawn: boolean): Promise<RunManifest> {
    const body = LearningRunRequestSchema.parse({ spawn });
    return await this.client.request(LEARNING_RUN_PATH, RunManifestSchema, jsonPost(body));
  }

  async config(): Promise<LearningConfig> {
    return await this.client.request(LEARNING_CONFIG_PATH, LearningConfigSchema);
  }

  /**
   * kteam served this read as a POST, so a plain retrieval could not be cached, retried, or reasoned
   * about as safe. It is a GET here — nothing about it mutates state.
   */
  async patch(id: string): Promise<LearningPatchResponse> {
    return await this.client.request(learningPatchPath(id), LearningPatchResponseSchema);
  }
}
