import type { SessionView } from '../../../../daemon/lib/protocol/session.ts';
import type { ConversionPreview, MoveConversation } from '../../../../daemon/lib/protocol/move.ts';
import type { IMoveGateway } from '../../../../cli/lib/move/ports.ts';
import { capturedPresenter } from '../session/controller-doubles.ts';
import { sessionView } from '../session/session-fixtures.ts';

interface MoveCall {
  readonly id: string;
  readonly agent: string;
  readonly model?: string;
  readonly allowContextDowngrade?: boolean;
  readonly forceInflight?: boolean;
  readonly requestId?: string;
  readonly conversation?: MoveConversation;
}

/** A preview of a Claude conversation converting onto Codex, with every count non-zero. */
export const READY_PREVIEW: Extract<ConversionPreview, { readonly kind: 'ready' }> = {
  kind: 'ready',
  targetAgent: 'codex-secondary',
  targetModel: 'gpt-5.6-sol',
  summary: {
    converter: 1,
    sourceHarness: 'claude',
    sourceVersion: '2.1.281',
    targetHarness: 'codex',
    targetVersion: '0.163.0',
    turns: 40,
    keptTurns: 12,
    omittedTurns: 28,
    cutNewest: true,
    messages: 30,
    nativeToolCalls: 9,
    toolCallsAsText: 31,
    attachments: 2,
    dropped: { reasoning: 14, sidechains: 3, internal: 57, compactions: 1 },
    estimatedTokens: 90_000,
    budgetTokens: 154_800,
  },
};

export class RecordingMoveGateway implements IMoveGateway {
  readonly calls: MoveCall[] = [];
  readonly previews: { readonly id: string; readonly agent: string; readonly model?: string }[] = [];

  constructor(
    private readonly response: SessionView = sessionView({
      agent: 'codex-secondary',
      model: 'gpt-5.6-sol',
      runtimeGeneration: 2,
    }),
    private readonly preview: ConversionPreview = READY_PREVIEW,
  ) {}

  conversionPreview(id: string, agent: string, model?: string): Promise<ConversionPreview> {
    this.previews.push({ id, agent, ...(model === undefined ? {} : { model }) });
    return Promise.resolve(this.preview);
  }

  move(
    id: string,
    agent: string,
    model?: string,
    allowContextDowngrade?: boolean,
    requestId?: string,
    forceInflight?: boolean,
    conversation?: MoveConversation,
  ): Promise<SessionView> {
    this.calls.push({
      id,
      agent,
      ...(model === undefined ? {} : { model }),
      ...(allowContextDowngrade === undefined ? {} : { allowContextDowngrade }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(forceInflight === undefined ? {} : { forceInflight }),
      ...(conversation === undefined ? {} : { conversation }),
    });
    return Promise.resolve(this.response);
  }
}

export function moveHarness(gateway = new RecordingMoveGateway()) {
  const { io, presenter } = capturedPresenter();
  return { gateway, io, presenter };
}
