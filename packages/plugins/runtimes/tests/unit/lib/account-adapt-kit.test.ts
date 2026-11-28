/**
 * Each harness's MCP servers, config documents and plumbing come from its own plugin's kit (E-276 PR 6 Claude, PR 7 Codex):
 * Runtimes calls the member and writes what it answers, and a runtime whose plugin gives no such member is REFUSED by name,
 * never written in another harness's shape or in a shape Runtimes still remembers. A kit is never asked for another
 * harness's runtime.
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
import { CODEX_CREDENTIAL_STORE_FILE, CODEX_CREDENTIAL_STORE_KEY } from '../../../daemon/lib/account/credentials.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

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

  it('should refuse a harness Runtimes has no behaviour for whatever kit it is handed', () => {
    expect(() => renderMcpComponents('opencode' as never, SERVERS, MARKED)).toThrow('opencode is not supported here');
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
    expect(missingKitRefusal('codex', undefined)).toEqual({
      kind: 'harness-unsupported',
      message: 'codex is not supported here',
    });
    expect(missingKitRefusal('claude', {} as RuntimesHarnessKit)).toBeUndefined();
    expect(missingKitRefusal('codex', { runtimeExtras: () => ({ env: {} }) })).toBeUndefined();
  });
});

describe('Codex through its kit', () => {
  const CODEX_PLUMBING: AdaptPlumbing = { harness: 'codex', sqliteHome: '/fy/sqlite' };
  const codexProfile = () => {
    const model = parseAccountModel({
      version: 1,
      components: { mcp: SERVERS, settings: { base: { harness: 'codex', file: 'config.toml' } } },
      profiles: { p: { layers: ['settings/base', 'mcp/files'] } },
    });
    const result = resolveProfile({
      model,
      profile: 'p',
      harness: 'codex',
      settingsBodies: { base: { mcp_servers: { files: { command: 'own' } }, sqlite_home: '/own' } },
    });
    if (!result.ok) throw new Error('unexpected');
    return result.resolved;
  };
  const MARKED_CODEX: RuntimesHarnessKit = {
    renderMcpServer: () => ({ marker: 'server' }),
    configDocuments: ({ servers }) => ({ settings: { written: servers }, serversAt: ['written'] }),
    plumbing: input => [
      { key: 'sqlite_home', path: ['sqlite_home'], value: input.sqliteHome, replacesOwn: true },
      { key: 'marker', path: ['marker'], value: input.statusLine === undefined },
    ],
  };
  const adaptCodex = (kit: RuntimesHarnessKit | undefined) =>
    adaptProfile({ resolved: codexProfile(), plumbing: CODEX_PLUMBING, kit });

  it('should write what the Codex kit answers, hand it the history directory and no Claude fact', () => {
    const adapted = adaptCodex(MARKED_CODEX);
    expect(adapted.settings.value).toEqual({
      written: { files: { marker: 'server' } },
      sqlite_home: '/fy/sqlite',
      marker: true,
    });
    expect(adapted.claudeJson).toBeUndefined();
    // What Runtimes tracks stays Runtimes': the kit says where servers went, Runtimes names what they replaced.
    expect(adapted.overrides.map(override => [override.key, override.by])).toEqual([['sqlite_home', 'plumbing']]);
    expect(adapted.plumbing).toEqual([
      { key: 'sqlite_home', path: ['sqlite_home'], value: '/fy/sqlite' },
      { key: 'marker', path: ['marker'], value: true },
    ]);
  });

  it('should refuse a Codex runtime whose plugin gives no kit or no member, by name', () => {
    const refusal = 'codex is not supported here';
    expect(() => adaptCodex(undefined)).toThrow(refusal);
    expect(() => adaptCodex({ renderMcpServer: MARKED_CODEX.renderMcpServer })).toThrow(refusal);
    expect(() => renderMcpComponents('codex', SERVERS, {})).toThrow(refusal);
    expect(() =>
      adaptCodex({ renderMcpServer: MARKED_CODEX.renderMcpServer, configDocuments: MARKED_CODEX.configDocuments }),
    ).toThrow(refusal);
  });

  it('should render a Codex server only through the Codex kit, and the prior servers of the machine are none', () => {
    expect(renderMcpComponents('codex', SERVERS, MARKED_CODEX)).toEqual({ files: { marker: 'server' } });
    expect(() => renderMcpComponents('codex', SERVERS, undefined)).toThrow('codex is not supported here');
    expect(priorServersOf('codex', () => SERVERS, MARKED_CODEX)).toEqual({});
  });

  it('should write the credential store key and value Runtimes reads a Codex login with, so the two copies cannot drift', () => {
    const entries = REAL_KITS.get('codex')?.plumbing?.({ settings: {}, sqliteHome: '/fy/sqlite' }) ?? [];
    expect(entries[0]).toMatchObject({
      key: CODEX_CREDENTIAL_STORE_KEY,
      path: [CODEX_CREDENTIAL_STORE_KEY],
      value: CODEX_CREDENTIAL_STORE_FILE,
    });
  });
});
