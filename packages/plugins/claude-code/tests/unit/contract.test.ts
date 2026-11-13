import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';
import { ITEM_NAME_PATTERN } from '@ferretry/std';
import {
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_HOOKS,
  CLAUDE_CODE_SETTINGS,
  harnessConfigLoosens,
} from '../../contract/index.ts';
import { claudeCodeConformance, fakeClaudeCode } from '../../contract/testing/index.ts';

describe('claude-code contract', () => {
  test('its settings and hooks collections name their items by the one shared item-name pattern, never a copy of it', () => {
    for (const def of [CLAUDE_CODE_SETTINGS, CLAUDE_CODE_HOOKS]) {
      expect((def as unknown as { name: RegExp }).name).toBe(ITEM_NAME_PATTERN);
    }
  });

  test('the fake passes the conformance suite', async () => {
    const result = await claudeCodeConformance(fakeClaudeCode);
    expect(result.ok).toBe(true);
  });

  test('the manifest declares its five routes, the harness take and the start.decide take', () => {
    expect(manifest.actions.routes.map(route => route.key)).toEqual([
      'GET /v1/claude-code/update',
      'POST /v1/claude-code/update',
      'GET /v1/ferrets/:ferretId/prompt',
      'POST /v1/ferrets/:ferretId/permission',
      'POST /v1/ferrets/:ferretId/dialog',
    ]);
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual([
      'harnesses',
      'start.decide',
      'runtimes.components.settings.claude',
      'runtimes.components.hooks.claude',
    ]);
  });

  test('the prompt read is terminal/use, any caller, masked by the kernel guard, uncached and not audited as an act', () => {
    const prompt = manifest.actions.routes.find(route => route.key === 'GET /v1/ferrets/:ferretId/prompt');
    expect(String(prompt?.capability?.capability)).toBe('terminal');
    expect(prompt?.capability?.axis).toBe('use');
    expect(prompt?.minimum).toBe('operator');
    expect(prompt?.caller).toBe('any');
    expect(prompt?.noStore).toBe(true);
    expect(prompt?.guard as unknown).toBe('secrets');
    expect(prompt?.audit as unknown).toEqual({ skip: expect.stringContaining('a read') });
  });

  test('the prompt read goes through Ferrets: this plugin needs the Ferrets port and nothing else', () => {
    expect(Object.keys(manifest.needs ?? {})).toEqual(['ferrets']);
  });

  test('G31 (declaration only) the permission answer is terminal/use, a person act, audited as input and never with the choice', () => {
    const permission = manifest.actions.routes.find(route => route.key === 'POST /v1/ferrets/:ferretId/permission');
    expect(String(permission?.capability?.capability)).toBe('terminal');
    expect(permission?.capability?.axis).toBe('use');
    expect(permission?.caller).toBe('person');
    expect(permission?.audit as unknown).toEqual({ record: 'terminal.input:permission' });
  });

  test('G32 (declaration only) the harness-dialog answer is terminal/use and audited as a dialog', () => {
    const dialog = manifest.actions.routes.find(route => route.key === 'POST /v1/ferrets/:ferretId/dialog');
    expect(String(dialog?.capability?.capability)).toBe('terminal');
    expect(dialog?.capability?.axis).toBe('use');
    expect(dialog?.audit as unknown).toEqual({ record: 'terminal.input:dialog' });
  });

  test('skipping every permission prompt is a loosening; asking again is not', () => {
    const auto = { searchPaths: [], permissionMode: 'auto' as const };
    const skip = { searchPaths: [], permissionMode: 'skip' as const };
    expect(harnessConfigLoosens(auto, skip)).toEqual(['agents now skip every permission prompt']);
    expect(harnessConfigLoosens(skip, auto)).toEqual([]);
    expect(CLAUDE_CODE_CONFIG.axis).toBe('configure');
  });
});
