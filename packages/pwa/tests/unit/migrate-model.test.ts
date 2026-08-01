import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  contextWindowForModel,
  LARGE_CONTEXT_WINDOW,
  migrationContextDecision,
  migrationFailure,
  migrationHasRuntimeChange,
  migrationModelSuggestions,
  migrationRoutingCaution,
  migrationTarget,
  modelFromDowngradeError,
  oneMillionVariant,
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
    expect(migrationRoutingCaution('claude-auto-mm3')).toContain('Restricted tier');
    expect(migrationRoutingCaution('codex-auto-loge')).toBeNull();
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
