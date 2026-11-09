import { describe, expect, it } from 'bun:test';
import mcpApp from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import { scriptedClient } from './mcp-fixtures.ts';

describe('the MCP app half', () => {
  it('is a built half, not a skeleton, and fills exactly what the manifest declares', () => {
    expect(mcpApp.skeleton).toBeUndefined();
    const half = mcpApp.build?.({ manifest, client: scriptedClient({}) as never });
    expect(Object.keys(half?.panels ?? {})).toEqual(['mcp-servers', 'add-mcp-row']);
    expect(Object.keys(half?.settings ?? {})).toEqual(['mcp']);
    expect(manifest.ui?.panels?.map(entry => entry.id)).toEqual(['mcp-servers', 'add-mcp-row']);
    expect(manifest.ui?.settings?.map(entry => entry.id)).toEqual(['mcp']);
  });

  it('loads its views on first use: a surface suspends by throwing its loading promise', () => {
    const half = mcpApp.build?.({ manifest, client: scriptedClient({}) as never });
    let thrown: unknown;
    try {
      half?.settings.mcp({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Promise);
  });
});
