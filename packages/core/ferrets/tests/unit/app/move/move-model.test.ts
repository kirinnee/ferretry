import { describe, expect, it } from 'bun:test';
import { moveCallFailure } from '../../../../app/features/move/call-failure.ts';
import {
  contextWindowForModel,
  LARGE_CONTEXT_WINDOW,
  moveContextDecision,
  moveFailure,
  moveHasRuntimeChange,
  moveModelSuggestions,
  moveTarget,
  modelFromDowngradeError,
  oneMillionVariant,
  onlyAgentJobsBlock,
  SMALL_CONTEXT_WINDOW,
  withoutOneMillionVariant,
} from '../../../../app/features/move/move-model.ts';

/** A refused call as the page reads it: status, code, sentence and (when the client carries it) the body. */
const refused = (message: string, code?: string, body?: unknown) =>
  moveCallFailure({
    message,
    status: 409,
    ...(code === undefined ? {} : { code }),
    ...(body === undefined ? {} : { body }),
  });

describe('move model selection', () => {
  it('uses the daemon model suffix rule for context windows and variants', () => {
    expect(contextWindowForModel('claude-opus-5')).toBe(SMALL_CONTEXT_WINDOW);
    expect(contextWindowForModel(' CLAUDE-OPUS-5[1M] ')).toBe(LARGE_CONTEXT_WINDOW);
    expect(contextWindowForModel('')).toBeUndefined();
    expect(oneMillionVariant(' claude-opus-5 ')).toBe('claude-opus-5[1m]');
    expect(oneMillionVariant('claude-opus-5[1M]')).toBe('claude-opus-5[1M]');
    expect(oneMillionVariant('')).toBe('');
    expect(withoutOneMillionVariant(' claude-opus-5[1m] ')).toBe('claude-opus-5');
  });

  it('offers stable, de-duplicated suggestions around the current model', () => {
    expect(moveModelSuggestions('claude-opus-5')).toEqual(['claude-opus-5', 'claude-opus-5[1m]']);
    expect(moveModelSuggestions(' claude-opus-5[1m] ')).toEqual(['claude-opus-5[1m]', 'claude-opus-5']);
    expect(moveModelSuggestions('')).toEqual([]);
  });

  it('normalises a target and refuses to invent one from a blank account', () => {
    expect(moveTarget('  codex-auto-atomi  ', '  gpt-5.6-terra  ')).toEqual({
      agent: 'codex-auto-atomi',
      model: 'gpt-5.6-terra',
      allowContextDowngrade: false,
    });
    expect(moveTarget('codex-auto-atomi', ' ', true)).toEqual({
      agent: 'codex-auto-atomi',
      allowContextDowngrade: true,
    });
    expect(moveTarget(' ', 'gpt-5.6-terra')).toBeNull();
  });

  it('detects a static downgrade and a conversation that cannot fit, while tolerating unknown defaults', () => {
    expect(
      moveContextDecision({ currentModel: 'claude-opus-5[1m]', contextTokens: 260_000, targetModel: 'claude-opus-5' }),
    ).toEqual({
      currentWindow: LARGE_CONTEXT_WINDOW,
      targetWindow: SMALL_CONTEXT_WINDOW,
      isDowngrade: true,
      conversationTooLarge: true,
    });
    expect(
      moveContextDecision({ currentModel: 'unknown', currentWindow: 400_000, contextTokens: 20_000, targetModel: '' }),
    ).toEqual({ currentWindow: 400_000, isDowngrade: false, conversationTooLarge: false });
    // The ferret summary carries no token count: the downgrade is judged from the names, the size by the daemon.
    expect(moveContextDecision({ currentModel: 'claude-opus-5[1m]', targetModel: 'claude-opus-5' })).toEqual({
      currentWindow: LARGE_CONTEXT_WINDOW,
      targetWindow: SMALL_CONTEXT_WINDOW,
      isDowngrade: true,
      conversationTooLarge: false,
    });
  });

  it('requires an actual account or model change', () => {
    expect(moveHasRuntimeChange('codex-auto-loge', 'gpt-5.6-sol', null)).toBe(false);
    expect(moveHasRuntimeChange('codex-auto-loge', 'gpt-5.6-sol', moveTarget('codex-auto-loge', 'gpt-5.6-sol'))).toBe(
      false,
    );
    // No model asked for, none set: the same account's default is the same runtime.
    expect(moveHasRuntimeChange('codex-auto-loge', '', moveTarget('codex-auto-loge', ''))).toBe(false);
    // No model asked for but one is pinned: asking for the account's default is a real change.
    expect(moveHasRuntimeChange('codex-auto-loge', 'gpt-5.6-sol', moveTarget('codex-auto-loge', ''))).toBe(true);
    expect(moveHasRuntimeChange('codex-auto-loge', 'gpt-5.6-sol', moveTarget('codex-auto-atomi', ''))).toBe(true);
    expect(moveHasRuntimeChange('codex-auto-loge', 'gpt-5.6-sol', moveTarget('codex-auto-loge', 'gpt-5.6-terra'))).toBe(
      true,
    );
  });
});

describe('move refusal classification', () => {
  it('extracts a larger model from both hinted and served downgrade messages', () => {
    expect(modelFromDowngradeError('refusing; use --model claude-opus-5[1m] instead')).toBe('claude-opus-5[1m]');
    expect(
      modelFromDowngradeError(
        'codex-auto-atomi serves gpt-5.6-terra with a 200,000-token window and this session uses more',
      ),
    ).toBe('gpt-5.6-terra[1m]');
    expect(modelFromDowngradeError('no model hint')).toBeNull();
  });

  it.each([
    ['context_downgrade_refused', 'context-downgrade'],
    ['move_refused', 'preflight-refused'],
    ['conversation_unresumable', 'conversation-unresumable'],
    ['unknown_agent', 'unknown-agent'],
    ['agent_unavailable', 'unavailable'],
    ['harness_mismatch', 'wrong-harness'],
    ['unservable_model', 'unservable-model'],
    ['session_unusable', 'unusable'],
    ['not-found', 'not-found'],
    ['invalid_session_id', 'invalid'],
    ['session_move_failed', 'failed'],
    ['unexpected_code', 'other'],
  ] as const)('maps daemon code %s to %s', (code, kind) => {
    const failure = moveFailure(refused(`failure for ${code}`, code));

    expect(failure.kind).toBe(kind);
    expect(failure.code).toBe(code);
    expect(failure.title).not.toBe('');
    expect(failure.guidance).not.toBe('');
  });

  it('keeps an extracted downgrade suggestion and leaves generic failures untyped', () => {
    expect(
      moveFailure(
        refused('codex-auto-atomi serves gpt-5.6-terra with a 200000-token window', 'context_downgrade_refused'),
      ).suggestedModel,
    ).toBe('gpt-5.6-terra[1m]');
    const generic = moveFailure(moveCallFailure(new Error('network gone')));
    expect(generic).toMatchObject({ kind: 'other', message: 'network gone' });
    expect(generic.code).toBeUndefined();
    expect(moveFailure(moveCallFailure('socket closed'))).toMatchObject({ kind: 'other', message: 'socket closed' });
  });
});

describe('a refused downgrade, in plain words', () => {
  it('replaces the daemon’s sentence, which names an API field, with the two windows', () => {
    const failure = moveFailure(
      refused(
        'claude-default serves claude-opus-5-5 with a 200000-token window and this session is running in 1000000. Send allowContextDowngrade to accept that.',
        'context_downgrade_refused',
      ),
    );
    expect(failure.kind).toBe('context-downgrade');
    expect(failure.message).toBe(
      'Moving would give this conversation a smaller window — 200,000 tokens instead of 1,000,000 — so part of it would be cut off.',
    );
    expect(failure.suggestedModel).toBe('claude-opus-5-5[1m]');
  });
});

describe('a refusal the agent can clear by itself', () => {
  const job = (pid: number) => ({
    kind: 'process' as const,
    verdict: 'unknown' as const,
    title: 'A program Ferretry doesn’t recognise is running',
    detail: `bash /tmp/job-${pid}.sh`,
    blocks: true,
    backgroundJob: true as const,
    pid,
  });
  const stranger = { kind: 'process' as const, verdict: 'unknown' as const, title: 'A program', blocks: true };
  const refusal = (items: readonly object[]) => ({
    status: 'waiting',
    turn: 3,
    blockedBy: 'unknown',
    items,
    restartsWithCli: 1,
  });

  it('reads the inventory off a typed refusal and says when only the agent’s own jobs block', () => {
    const body = { error: 'refused', code: 'move_refused', inflight: refusal([job(5100), job(5101)]) };
    const failure = moveFailure(refused('refused', 'move_refused', body));

    expect(failure.kind).toBe('preflight-refused');
    expect(failure.inflight?.items.map(item => item.pid)).toEqual([5100, 5101]);
    expect(onlyAgentJobsBlock(failure.inflight)).toBe(true);
  });

  it('keeps the offer away when anything else blocks, nothing does, or the client carried no inventory', () => {
    const mixed = moveFailure(
      refused('refused', 'move_refused', { error: 'x', code: 'move_refused', inflight: refusal([job(1), stranger]) }),
    );
    const nonBlocking = moveFailure(
      refused('refused', 'move_refused', {
        error: 'x',
        code: 'move_refused',
        inflight: refusal([{ ...job(2), blocks: false }, stranger]),
      }),
    );
    const bare = moveFailure(refused('refused', 'move_refused'));

    expect(onlyAgentJobsBlock(mixed.inflight)).toBe(false);
    expect(onlyAgentJobsBlock(nonBlocking.inflight)).toBe(false);
    expect(bare.inflight).toBeUndefined();
    expect(onlyAgentJobsBlock(bare.inflight)).toBe(false);
    expect(onlyAgentJobsBlock(refusal([]) as never)).toBe(false);
  });
});
