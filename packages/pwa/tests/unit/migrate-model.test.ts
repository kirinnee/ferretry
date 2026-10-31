import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  contextWindowForModel,
  LARGE_CONTEXT_WINDOW,
  migrationContextDecision,
  migrationFailure,
  migrationHasRuntimeChange,
  migrationModelSuggestions,
  migrationTarget,
  modelFromDowngradeError,
  oneMillionVariant,
  onlyAgentJobsBlock,
  SMALL_CONTEXT_WINDOW,
  withoutOneMillionVariant,
} from '../../src/components/migrate-model.ts';

describe('migration model selection', () => {
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
    expect(migrationModelSuggestions('claude-opus-5')).toEqual(['claude-opus-5', 'claude-opus-5[1m]']);
    expect(migrationModelSuggestions(' claude-opus-5[1m] ')).toEqual(['claude-opus-5[1m]', 'claude-opus-5']);
    expect(migrationModelSuggestions('')).toEqual([]);
  });

  it('normalises a target and refuses to invent one from a blank account', () => {
    expect(migrationTarget('  codex-auto-atomi  ', '  gpt-5.6-terra  ')).toEqual({
      agent: 'codex-auto-atomi',
      model: 'gpt-5.6-terra',
      allowContextDowngrade: false,
    });
    expect(migrationTarget('codex-auto-atomi', ' ', true)).toEqual({
      agent: 'codex-auto-atomi',
      allowContextDowngrade: true,
    });
    expect(migrationTarget(' ', 'gpt-5.6-terra')).toBeNull();
  });

  it('detects a static downgrade and a conversation that cannot fit, while tolerating unknown defaults', () => {
    expect(
      migrationContextDecision({
        currentModel: 'claude-opus-5[1m]',
        contextTokens: 260_000,
        targetModel: 'claude-opus-5',
      }),
    ).toEqual({
      currentWindow: LARGE_CONTEXT_WINDOW,
      targetWindow: SMALL_CONTEXT_WINDOW,
      isDowngrade: true,
      conversationTooLarge: true,
    });
    expect(
      migrationContextDecision({
        currentModel: 'unknown',
        currentWindow: 400_000,
        contextTokens: 20_000,
        targetModel: '',
      }),
    ).toEqual({ currentWindow: 400_000, isDowngrade: false, conversationTooLarge: false });
  });

  it('requires an actual account or model change and warns on restricted routing tiers', () => {
    expect(migrationHasRuntimeChange('codex-auto-loge', 'gpt-5.6-sol', '', null)).toBe(false);
    expect(
      migrationHasRuntimeChange(
        'codex-auto-loge',
        'gpt-5.6-sol',
        'gpt-5.6-sol',
        migrationTarget('codex-auto-loge', 'gpt-5.6-sol'),
      ),
    ).toBe(false);
    expect(
      migrationHasRuntimeChange('codex-auto-loge', 'gpt-5.6-sol', '', migrationTarget('codex-auto-loge', '')),
    ).toBe(false);
    expect(
      migrationHasRuntimeChange(
        'codex-auto-loge',
        'gpt-5.6-sol',
        'gpt-5.6-sol',
        migrationTarget('codex-auto-loge', ''),
      ),
    ).toBe(true);
    expect(
      migrationHasRuntimeChange('codex-auto-loge', 'gpt-5.6-sol', '', migrationTarget('codex-auto-atomi', '')),
    ).toBe(true);
    expect(
      migrationHasRuntimeChange(
        'codex-auto-loge',
        'gpt-5.6-sol',
        'gpt-5.6-sol',
        migrationTarget('codex-auto-loge', 'gpt-5.6-terra'),
      ),
    ).toBe(true);
  });
});

describe('migration refusal classification', () => {
  it('extracts a larger model from both historical and current downgrade messages', () => {
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
    ['migration_refused', 'preflight-refused'],
    ['conversation_unresumable', 'conversation-unresumable'],
    ['unknown_agent', 'unknown-agent'],
    ['agent_unavailable', 'unavailable'],
    ['session_unusable', 'unusable'],
    ['not-found', 'not-found'],
    ['invalid_session_id', 'invalid'],
    ['session_migrate_failed', 'failed'],
    ['unknown_route', 'unsupported'],
    ['unexpected_code', 'other'],
  ] as const)('maps daemon code %s to %s', (code, kind) => {
    const failure = migrationFailure(new FyHttpError(`failure for ${code}`, 409, code));

    expect(failure.kind).toBe(kind);
    expect(failure.code).toBe(code);
    expect(failure.title).not.toBe('');
    expect(failure.guidance).not.toBe('');
  });

  it('keeps an extracted downgrade suggestion and leaves generic failures untyped', () => {
    expect(
      migrationFailure(
        new FyHttpError(
          'codex-auto-atomi serves gpt-5.6-terra with a 200000-token window',
          409,
          'context_downgrade_refused',
        ),
      ).suggestedModel,
    ).toBe('gpt-5.6-terra[1m]');
    const generic = migrationFailure(new Error('network gone'));
    expect(generic).toMatchObject({
      kind: 'other',
      message: 'network gone',
    });
    expect(generic.code).toBeUndefined();
    expect(migrationFailure('socket closed')).toMatchObject({ kind: 'other', message: 'socket closed' });
  });
});

describe('a refused downgrade, in plain words', () => {
  it('replaces the daemon’s sentence, which names an API field, with the two windows', () => {
    const failure = migrationFailure(
      new FyHttpError(
        'claude-default serves claude-opus-5-5 with a 200000-token window and this session is running in 1000000. Send allowContextDowngrade to accept that.',
        409,
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
    const body = { error: 'refused', code: 'migration_refused', inflight: refusal([job(5100), job(5101)]) };
    const failure = migrationFailure(new FyHttpError('refused', 409, 'migration_refused', body));

    expect(failure.kind).toBe('preflight-refused');
    expect(failure.inflight?.items.map(item => item.pid)).toEqual([5100, 5101]);
    expect(onlyAgentJobsBlock(failure.inflight)).toBe(true);
  });

  it('keeps the offer away when anything else blocks, nothing does, or the daemon sent no inventory', () => {
    const mixed = migrationFailure(
      new FyHttpError('refused', 409, 'migration_refused', { error: 'x', inflight: refusal([job(1), stranger]) }),
    );
    const nonBlocking = migrationFailure(
      new FyHttpError('refused', 409, 'migration_refused', {
        error: 'x',
        inflight: refusal([{ ...job(2), blocks: false }, stranger]),
      }),
    );
    const older = migrationFailure(new FyHttpError('refused', 409, 'migration_refused'));

    expect(onlyAgentJobsBlock(mixed.inflight)).toBe(false);
    expect(onlyAgentJobsBlock(nonBlocking.inflight)).toBe(false);
    expect(older.inflight).toBeUndefined();
    expect(onlyAgentJobsBlock(older.inflight)).toBe(false);
    expect(onlyAgentJobsBlock(refusal([]) as never)).toBe(false);
  });
});
