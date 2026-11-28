/**
 * Claude's MCP servers, config documents and plumbing come from Claude's kit (E-276 PR 6): Runtimes calls the member and
 * writes what it answers, and a Claude runtime whose plugin gives no such member is REFUSED by name, never written in
 * Codex's shape or in a shape Runtimes still remembers. Codex still branches here, so its kit is never asked.
 */
import { describe, expect, it } from 'bun:test';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import {
  type AdaptPlumbing,
  adaptProfile,
  missingKitRefusal,
  priorServersOf,
  renderMcpComponents,
} from '../../../daemon/lib/account/adapt.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';

const SERVERS = { files: { command: 'files-server', args: ['--stdio'] } };
const REFUSAL = 'claude is not supported here';

const CLAUDE_PLUMBING: AdaptPlumbing = { harness: 'claude', statusLine: () => 'fy statusline' };

const claudeProfile = () => {
  const model = parseAccountModel({
    version: 1,
    components: { mcp: SERVERS },
    profiles: { p: { layers: ['mcp/files'] } },
  });
  const result = resolveProfile({ model, profile: 'p', harness: 'claude' });
  if (!result.ok) throw new Error('unexpected');
  return result.resolved;
};

const adapt = (kit: RuntimesHarnessKit | undefined) =>
  adaptProfile({ resolved: claudeProfile(), plumbing: CLAUDE_PLUMBING, kit });

/** A kit that answers with marker words, so the test can see which bytes came from it. */
const MARKED: RuntimesHarnessKit = {
  renderMcpServer: () => ({ marker: 'server' }),
  configDocuments: ({ servers }) => ({ settings: { marker: 'settings' }, claudeJson: { servers } }),
  plumbing: () => [{ key: 'marker.key', path: ['marker', 'plumbing'], value: 1 }],
};

describe('Claude MCP rendering through the kit', () => {
  it('should write the server the kit renders', () => {
    expect(renderMcpComponents('claude', SERVERS, MARKED)).toEqual({ files: { marker: 'server' } });
  });

  it('should refuse a Claude server when the plugin gives no kit or no renderer', () => {
    expect(() => renderMcpComponents('claude', SERVERS, undefined)).toThrow(REFUSAL);
    expect(() => renderMcpComponents('claude', SERVERS, {})).toThrow(REFUSAL);
  });

  it('should never ask the Claude kit to render a Codex server', () => {
    const asked: string[] = [];
    const kit: RuntimesHarnessKit = {
      renderMcpServer: () => {
        asked.push('claude');
        return {};
      },
    };
    expect(renderMcpComponents('codex', SERVERS, kit)).toEqual({
      files: { command: 'files-server', args: ['--stdio'] },
    });
    expect(asked).toEqual([]);
  });

  it('should render the prior servers of the machine through the kit, and none for Codex', () => {
    expect(priorServersOf('claude', () => SERVERS, MARKED)).toEqual({ files: { marker: 'server' } });
    expect(() => priorServersOf('claude', () => SERVERS, undefined)).toThrow(REFUSAL);
    expect(priorServersOf('codex', () => SERVERS, MARKED)).toEqual({});
  });
});

describe('Claude documents and plumbing through the kit', () => {
  it('should write the documents and plumbing keys the kit answers', () => {
    const adapted = adapt(MARKED);
    expect(adapted.claudeJson).toEqual({ servers: { files: { marker: 'server' } } });
    expect(adapted.settings.value).toEqual({ marker: { plumbing: 1 } });
    expect(adapted.plumbing.map(entry => entry.key)).toEqual(['marker.key']);
  });

  it('should refuse a Claude runtime whose plugin gives no kit', () => {
    expect(() => adapt(undefined)).toThrow(REFUSAL);
  });

  it('should refuse a Claude runtime whose kit renders servers but writes no documents', () => {
    expect(() => adapt({ renderMcpServer: MARKED.renderMcpServer })).toThrow(REFUSAL);
  });

  it('should refuse a Claude runtime whose kit writes documents but no plumbing', () => {
    expect(() => adapt({ renderMcpServer: MARKED.renderMcpServer, configDocuments: MARKED.configDocuments })).toThrow(
      REFUSAL,
    );
  });
});

describe('a Claude runtime without its plugin kit, as data', () => {
  it('should be a typed refusal, never a throw, and only for the harness whose kit is missing', () => {
    expect(missingKitRefusal('claude', undefined)).toEqual({
      kind: 'harness-unsupported',
      message: 'claude-code is not supported here',
    });
    expect(missingKitRefusal('claude', {} as RuntimesHarnessKit)).toBeUndefined();
    expect(missingKitRefusal('codex', undefined)).toEqual({
      kind: 'harness-unsupported',
      message: 'codex is not supported here',
    });
    expect(missingKitRefusal('codex', { runtimeExtras: () => ({ env: {} }) })).toBeUndefined();
  });
});
