import { expect, test } from 'bun:test';
import { planGraph } from '../../../host/graph.ts';
import { definePlugin } from '../../../manifest/index.ts';

const plugin = (id: string, permissions = {}) =>
  definePlugin({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: [], permissions });

test('revealMinted is declared by the MCP plugin alone: any other plugin is refused when it is defined', () => {
  expect(() => plugin('mcp', { revealMinted: true })).not.toThrow();
  expect(() => plugin('other', { revealMinted: true })).toThrow(/revealMinted/);
  expect(() => plugin('connector', { revealMinted: true })).toThrow(/revealMinted/);
});

test('boot refuses a non-MCP plugin that declares revealMinted even when definePlugin was bypassed', () => {
  const manifest = { ...plugin('mcp', { revealMinted: true }), id: 'other' };
  const plan = planGraph(
    [manifest],
    () => true,
    () => [],
  );

  expect(plan.order).toEqual([]);
  expect(plan.refused[0]?.reason).toBe('reveal-minted');
  expect(plan.refused[0]?.sentence).toContain('revealMinted');
});
