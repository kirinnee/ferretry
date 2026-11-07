import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';
import { CLAUDE_CODE_CONFIG, harnessConfigLoosens } from '../../contract/index.ts';
import { claudeCodeConformance, fakeClaudeCode } from '../../contract/testing/index.ts';

describe('claude-code contract', () => {
  test('the fake passes the conformance suite', async () => {
    const result = await claudeCodeConformance(fakeClaudeCode);
    expect(result.ok).toBe(true);
  });

  test('the manifest declares its four routes and the harness take', () => {
    expect(manifest.actions.routes.map(route => route.key)).toEqual([
      'GET /v1/claude-code/update',
      'POST /v1/claude-code/update',
      'POST /v1/ferrets/:ferretId/permission',
      'POST /v1/ferrets/:ferretId/dialog',
    ]);
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual(['harnesses']);
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
