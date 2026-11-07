import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import {
  type AgentLessonToolResult,
  AgentLessonToolResultSchema,
  type LessonsActionRequest,
  LessonsActionRequestSchema,
  type LessonsApplyPreview,
  LessonsApplyPreviewSchema,
  LessonsApplyRequestSchema,
  type LessonsConfig,
  type LessonsGlobalDocument,
  LessonsGlobalDocumentSchema,
  LessonsGlobalWriteSchema,
  LessonsConfigSchema,
  type LessonsPatchResponse,
  LessonsPatchResponseSchema,
  LessonsRunRequestSchema,
  type LessonsScanEstimate,
  LessonsScanEstimateSchema,
  type LessonsScanProgress,
  LessonsScanProgressSchema,
  type LessonsScanRequest,
  LessonsScanRequestSchema,
  type LessonsStatus,
  LessonsStatusSchema,
  type ProposalState,
  type ProposalView,
  ProposalViewSchema,
  type RunManifest,
  RunManifestSchema,
} from '../../contract/index.ts';
import type { ILessonsGateway } from './ports.ts';

const ProposalListSchema = z.array(ProposalViewSchema);

/**
 * Speaks the lesson routes through the generated client. Every response is parsed against a wire schema, so a daemon
 * answering with an error envelope fails here with a stated reason rather than inside a renderer reading fields off
 * `undefined`.
 */
export class ClientLessonsGateway implements ILessonsGateway {
  constructor(private readonly client: Pick<PluginClient, 'call'>) {}

  async status(): Promise<LessonsStatus> {
    return LessonsStatusSchema.parse(await this.client.call('GET /v1/lessons/status'));
  }

  async proposals(state?: ProposalState): Promise<readonly ProposalView[]> {
    return ProposalListSchema.parse(
      await this.client.call('GET /v1/lessons/proposals', state === undefined ? {} : { query: { state } }),
    );
  }

  async act(id: string, request: LessonsActionRequest): Promise<ProposalView> {
    return ProposalViewSchema.parse(
      await this.client.call('POST /v1/lessons/proposals/:id', {
        params: { id },
        body: LessonsActionRequestSchema.parse(request),
      }),
    );
  }

  async run(spawn: boolean): Promise<RunManifest> {
    return RunManifestSchema.parse(
      await this.client.call('POST /v1/lessons/run', { body: LessonsRunRequestSchema.parse({ spawn }) }),
    );
  }

  async config(): Promise<LessonsConfig> {
    return LessonsConfigSchema.parse(await this.client.call('GET /v1/lessons/config'));
  }

  /** A GET: nothing about it mutates state. */
  async patch(id: string): Promise<LessonsPatchResponse> {
    return LessonsPatchResponseSchema.parse(
      await this.client.call('GET /v1/lessons/proposals/:id/patch', { params: { id } }),
    );
  }

  /** A GET, like `patch`: reading what Apply would write spends nothing and writes nothing. */
  async applyPreview(id: string): Promise<LessonsApplyPreview> {
    return LessonsApplyPreviewSchema.parse(
      await this.client.call('GET /v1/lessons/proposals/:id/apply-preview', { params: { id } }),
    );
  }

  async apply(id: string, etag: string): Promise<ProposalView> {
    return ProposalViewSchema.parse(
      await this.client.call('POST /v1/lessons/proposals/:id/apply', {
        params: { id },
        body: LessonsApplyRequestSchema.parse({ etag }),
      }),
    );
  }

  async scanEstimate(request: LessonsScanRequest): Promise<LessonsScanEstimate> {
    return LessonsScanEstimateSchema.parse(
      await this.client.call('POST /v1/lessons/scan/estimate', { body: LessonsScanRequestSchema.parse(request) }),
    );
  }

  async scan(request: LessonsScanRequest): Promise<LessonsScanProgress> {
    return LessonsScanProgressSchema.parse(
      await this.client.call('POST /v1/lessons/scan', { body: LessonsScanRequestSchema.parse(request) }),
    );
  }

  async globalDocument(): Promise<LessonsGlobalDocument> {
    return LessonsGlobalDocumentSchema.parse(await this.client.call('GET /v1/lessons/global'));
  }

  async writeGlobalDocument(text: string, etag: string): Promise<LessonsGlobalDocument> {
    return LessonsGlobalDocumentSchema.parse(
      await this.client.call('PUT /v1/lessons/global', { body: LessonsGlobalWriteSchema.parse({ text, etag }) }),
    );
  }

  async suggest(rule: string, scope: string): Promise<AgentLessonToolResult> {
    return AgentLessonToolResultSchema.parse(
      await this.client.call('POST /v1/lessons/suggest', { body: { tool: 'lessons.suggest', rule, scope } }),
    );
  }
}
