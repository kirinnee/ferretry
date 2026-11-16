/** The Lessons-owned T row of docs/design/rebuild-parity.tsv, named by its id, driven through the real tool handler. */
import { describe, expect, test } from 'bun:test';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ferret, owner } from '@ferretry/kernel/testing';
import manifest from '../../../manifest.ts';
import { lessonsHost } from './host.ts';

describe('the lessons agent tool', () => {
  test('T-0037 lessons_suggest files one lesson as the calling ferret; a second filing merges and counts', async () => {
    const { host, ferrets } = await lessonsHost();
    ferrets.add({ id: ferretId('f1'), name: 'hadi', folder: '/work/repo' });
    expect(manifest.actions.agentTools.map(tool => tool.name)).toEqual(['lessons_suggest']);
    const first = await host.tool(
      'lessons_suggest',
      { rule: 'Use bun, not Python.', scope: 'global' },
      { as: ferret('f1') },
    );
    expect(first.text).toBe('Filed a new Global lesson for the owner to review.');
    const again = await host.tool(
      'lessons_suggest',
      { rule: 'Use bun, not Python.', scope: 'global' },
      { as: ferret('f1') },
    );
    expect(again.isError).not.toBe(true);
    const board = JSON.parse(String((await host.request('GET', '/v1/lessons/proposals', { as: owner() })).body));
    expect(board).toHaveLength(1);
    const bad = await host.tool('lessons_suggest', { rule: '', scope: 'global' }, { as: ferret('f1') });
    expect(bad.isError).toBe(true);
  });
});
