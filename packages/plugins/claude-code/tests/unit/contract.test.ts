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
    const auto = { searchPaths: [], permissionMode: 'auto' as const, questionTool: false };
    const skip = { searchPaths: [], permissionMode: 'skip' as const, questionTool: false };
    expect(harnessConfigLoosens(auto, skip)).toEqual(['agents now skip every permission prompt']);
    expect(harnessConfigLoosens(skip, auto)).toEqual([]);
    expect(CLAUDE_CODE_CONFIG.axis).toBe('configure');
  });

  test('any change of the binary or the search paths is held (code execution); the file is judged by that rule', () => {
    // What the file is judged by (the plugin's own def), not a helper the contract exports.
    const held = CLAUDE_CODE_CONFIG.loosens;
    const base = { searchPaths: ['/a', '/b'], permissionMode: 'auto' as const, questionTool: false };
    const binary = (path: string) => ({ ...base, binary: path });
    expect(held(base, base)).toEqual([]);
    expect(held(undefined, { searchPaths: [], permissionMode: 'auto', questionTool: false })).toEqual([]);
    expect(held(base, binary('/x'))).toEqual(['agents now launch a different Claude Code program (binary changed)']);
    expect(held(binary('/x'), binary('/y'))).toHaveLength(1);
    expect(held(binary('/x'), base)).toHaveLength(1);
    // A first document that names a binary AND search paths changes both: each is said.
    expect(held(undefined, binary('/x'))).toHaveLength(2);
    expect(held(undefined, { ...binary('/x'), searchPaths: [] })).toHaveLength(1);
    const searched = (paths: string[]) => ({ ...base, searchPaths: paths });
    const dirs = ['agents now look for the Claude Code program in different directories (searchPaths changed)'];
    expect(held(base, searched(['/a']))).toEqual(dirs);
    expect(held(base, searched(['/b', '/a']))).toEqual(dirs);
    expect(held(base, searched(['/a /b']))).toEqual(dirs);
    expect(held(undefined, searched(['/a']))).toEqual(dirs);
    expect(held(base, { ...base, permissionMode: 'skip', binary: '/x' })).toHaveLength(2);
    expect(held({ ...base, permissionMode: 'skip' }, base)).toEqual([]);
  });
});
