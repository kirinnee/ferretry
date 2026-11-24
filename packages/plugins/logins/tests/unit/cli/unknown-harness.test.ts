import { THIRD_HARNESS_KEY } from '@ferretry/core-ferrets/contract/testing';
import { describe, expect, test } from 'bun:test';
import { suggestLoginId } from '../../../cli/lib/commands.ts';
import { renderLoginRow } from '../../../cli/lib/render.ts';
import { login } from './fakes.ts';

/** RUNTIMES PLAN U4b (Logins): the CLI never names a harness it has no row for with Claude's command word. */
describe('the CLI with a harness Logins has no behaviour for', () => {
  test('refuses to suggest a login id from it, and keeps the two shipped harnesses’ ids', () => {
    expect(() => suggestLoginId(THIRD_HARNESS_KEY, 'work', new Set())).toThrow(
      `${THIRD_HARNESS_KEY} is not supported here`,
    );
    expect(suggestLoginId('claude-code', 'Work', new Set(['claude-work']))).toBe('claude-work-2');
    expect(suggestLoginId('codex', undefined, new Set())).toBe('codex-login');
  });

  test('shows such a login under its own key, never as Claude Code', () => {
    const row = renderLoginRow(login({ harness: THIRD_HARNESS_KEY, harnesses: [THIRD_HARNESS_KEY] }), 'fy').join('\n');

    expect(row).toContain(THIRD_HARNESS_KEY);
    expect(row).not.toContain('Claude Code');
  });
});
