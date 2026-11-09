/**
 * MCP's answer to Runtimes' profile component source: the `mcp` components a profile layer names, projected from this
 * plugin's own items, live, with every secret still a reference.
 */
import { describe, expect, it } from 'bun:test';
import type { McpItem } from '../../contract/index.ts';
import { mcpComponentSource } from '../../daemon/lib/profile-component-source.ts';

const items = (): Map<string, McpItem> =>
  new Map<string, McpItem>([
    ['zeta', { url: 'https://zeta.example.test/mcp' } as McpItem],
    ['github', { command: 'github-mcp', args: ['--stdio'], env: { TOKEN: '${secret:GITHUB_TOKEN}' } } as McpItem],
  ]);

describe('the mcp profile component source', () => {
  it('lists every item in name order and reads one as its parsed projection', async () => {
    const source = mcpComponentSource(items);

    expect(await source.list()).toEqual(['github', 'zeta']);
    expect(await source.read('github')).toEqual({
      command: 'github-mcp',
      args: ['--stdio'],
      env: { TOKEN: '${secret:GITHUB_TOKEN}' },
    });
  });

  it('answers undefined for a name that is not there', async () => {
    expect(await mcpComponentSource(items).read('absent')).toBeUndefined();
  });

  it('keeps a secret as a ${secret:NAME} reference: no value is in what it gives', async () => {
    const read = JSON.stringify(await mcpComponentSource(items).read('github'));

    expect(read).toContain('${secret:GITHUB_TOKEN}');
    expect(read).not.toMatch(/ghp_|sk-/u);
  });

  it('reads live: a changed or removed item is what the next read gives, and a copy cannot change the item', async () => {
    const held = items();
    const source = mcpComponentSource(() => held);

    const first = (await source.read('github')) as { args: string[] };
    first.args.push('--tampered');
    held.set('github', { command: 'github-mcp', args: ['--second'] } as McpItem);
    const second = await source.read('github');
    held.delete('github');

    expect(second).toEqual({ command: 'github-mcp', args: ['--second'] });
    expect(await source.read('github')).toBeUndefined();
    expect(await source.list()).toEqual(['zeta']);
  });
});
