import { describe, expect, test } from 'bun:test';
import { SharedDraftSentSchema } from '../../../../daemon/lib/protocol/shared-draft.ts';
import { taskTitleFor } from '../../../../daemon/lib/protocol/task-title.ts';

const sent = (text: unknown) => ({ generation: 'gen-1', epoch: 0, base: 3, text });

describe('what a send takes out of the shared draft', () => {
  test('accepts an edit that retains, deletes and inserts within the size of one draft', () => {
    expect(SharedDraftSentSchema.safeParse(sent([3, 'hello', -2])).success).toBe(true);
  });

  test('accepts inserts that together fill a whole draft exactly', () => {
    expect(SharedDraftSentSchema.safeParse(sent(['a'.repeat(8_000), 'b'.repeat(8_000)])).success).toBe(true);
  });

  test('refuses an edit whose inserts together are longer than a whole draft', () => {
    const answer = SharedDraftSentSchema.safeParse(sent(['a'.repeat(10_000), 'b'.repeat(10_000)]));
    expect(answer.success).toBe(false);
    expect(JSON.stringify(answer.error?.issues)).toContain('an edit inserts at most 16000 characters');
  });

  test('refuses a zero retain, an empty insert and an edit with too many components', () => {
    expect(SharedDraftSentSchema.safeParse(sent([0])).success).toBe(false);
    expect(SharedDraftSentSchema.safeParse(sent([''])).success).toBe(false);
    expect(SharedDraftSentSchema.safeParse(sent(Array.from({ length: 1_025 }, () => 1))).success).toBe(false);
  });
});

describe('the title of a brief nobody named', () => {
  test('is the first heading in Title Case, with small words lowered inside it', () => {
    expect(taskTitleFor('# fix the login bug\n\nlots of detail', 'Task')).toBe('Fix the Login Bug');
  });

  test('skips headings that say nothing about the task and headings with no words in them', () => {
    expect(taskTitleFor('# Assigned task\n## ---\n## Summary\nrefactor the routes please', 'Task')).toBe(
      'Refactor the Routes Please',
    );
  });

  test('skips role-play and read-this-file sentences and takes the first sentence that names work', () => {
    expect(taskTitleFor('You are a Ferretry implementer. Read the brief. Fix the sign in flow.', 'Task')).toBe(
      'Fix the Sign in Flow',
    );
  });

  test('is a label and a short hash when the brief has nothing readable, the same hash for the same brief', () => {
    const brief = '```\n---\n';
    const title = taskTitleFor(brief, 'code-review');
    expect(title).toMatch(/^Code Review [0-9a-z]{4}$/u);
    expect(taskTitleFor(brief, 'code-review')).toBe(title);
    expect(taskTitleFor('```\n---\n\n---', 'code-review')).not.toBe(title);
  });

  test('is Task and a hash when the label itself has no words either', () => {
    expect(taskTitleFor('', '---')).toMatch(/^Task [0-9a-z]{4}$/u);
  });
});
