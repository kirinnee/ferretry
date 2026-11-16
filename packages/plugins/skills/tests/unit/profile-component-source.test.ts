/**
 * Skills' answer to Runtimes' profile component source: the `skills` components a profile layer names, projected from
 * this plugin's own items (names of skills), live.
 */
import { describe, expect, it } from 'bun:test';
import type { SkillsItem } from '../../contract/index.ts';
import { skillsComponentSource } from '../../daemon/lib/profile-component-source.ts';

describe('the skills profile component source', () => {
  it('lists items in name order and reads one as its parsed projection', async () => {
    const held = new Map<string, SkillsItem>([
      ['writing', { items: ['edit', 'outline'] } as SkillsItem],
      ['review', { items: ['review'], harness: 'claude-code' } as SkillsItem],
    ]);
    const source = skillsComponentSource(() => held);

    expect(await source.list()).toEqual(['review', 'writing']);
    expect(await source.read('review')).toEqual({ items: ['review'], harness: 'claude-code' });
    expect(await source.read('absent')).toBeUndefined();
  });

  it('reads live: an edited or removed item is what the next read gives', async () => {
    const held = new Map<string, SkillsItem>([['review', { items: ['review'] } as SkillsItem]]);
    const source = skillsComponentSource(() => held);

    held.set('review', { items: ['review', 'audit'] } as SkillsItem);
    const edited = await source.read('review');
    held.delete('review');

    expect(edited).toEqual({ items: ['review', 'audit'] });
    expect(await source.read('review')).toBeUndefined();
  });
});
