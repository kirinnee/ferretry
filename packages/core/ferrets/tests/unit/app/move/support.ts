/** Fixtures for the move page's suites: a ferret summary and a few daemon answers, as the contract spells them. */
import type { FerretId } from '@ferretry/kernel/contract';
import type { ConversionPreview, FerretSummary } from '../../../../contract/index.ts';

export const summaryOf = (over: Partial<Omit<FerretSummary, 'id'>> & { id?: string } = {}): FerretSummary =>
  ({
    name: 'Hadi',
    role: 'lead',
    harness: 'claude-code',
    runner: 'tmux',
    runtime: 'claude-default',
    model: 'claude-opus-5',
    folder: '/work/x',
    state: 'idle',
    createdAt: '2026-11-01T00:00:00.000Z',
    stateAt: '2026-11-01T00:00:00.000Z',
    ...over,
    id: (over.id ?? 'f-1') as FerretId,
  }) as FerretSummary;

export const readyPreview: Extract<ConversionPreview, { kind: 'ready' }> = {
  kind: 'ready',
  targetAgent: 'codex-a',
  targetModel: 'gpt-5.5',
  summary: {
    converter: 1,
    sourceHarness: 'claude',
    targetHarness: 'codex',
    targetVersion: '0.163.0',
    turns: 3,
    keptTurns: 3,
    omittedTurns: 0,
    cutNewest: false,
    messages: 6,
    nativeToolCalls: 0,
    toolCallsAsText: 0,
    attachments: 0,
    dropped: { reasoning: 0, sidechains: 0, internal: 0, compactions: 0 },
    estimatedTokens: 10,
    budgetTokens: 100,
  },
};
