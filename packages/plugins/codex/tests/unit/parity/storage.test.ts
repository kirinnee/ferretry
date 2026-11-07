import { describe, expect, test } from 'bun:test';
import type { FencedPath, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import manifest from '../../../manifest.ts';
import { CODEX_SETTINGS } from '../../../contract/index.ts';
import { codexHarness } from '../../../daemon/adapters/codex-harness.ts';
import { realClock } from '../../support/ports.ts';
import { RUNTIME_SETTINGS_FILE } from '../../../daemon/lib/index.ts';

/**
 * Storage parity (docs/design/rebuild-parity.tsv): where Codex's files live now. Each row is a path today's code built
 * from a root; in 5.0 the root is a declared one, and Codex reaches it only through the roots port.
 */

const HOME = '/state/codex/agent-homes/f1' as FencedPath;

/** A ferret's home that remembers every name written into it, and which root it was asked for. */
function home() {
  const written: string[] = [];
  const asked: string[] = [];
  const handle = {
    name: 'agent-homes',
    resolve: (relative: string) =>
      ok((relative.startsWith('/') ? relative : relative === '' ? HOME : `${HOME}/${relative}`) as FencedPath),
    writeText: async (path: FencedPath) => void written.push(path.slice(HOME.length + 1)),
    ensurePrivateDirectory: async () => undefined,
  } as unknown as RootHandle;
  const roots = { root: (name: string) => (asked.push(name), handle) } as unknown as KernelPorts['roots'];
  return { written, asked, roots };
}

describe('codex storage parity', () => {
  test('F-0005 the config.toml of a ferret’s home is written inside the agent-homes root, never beside it', async () => {
    const { written, asked, roots } = home();
    const harness = codexHarness({
      kernel: {
        roots,
        state: undefined as never,
        log: undefined as never,
        clock: realClock(),
        redaction: undefined as never,
      },
      locate: async () => ({ outcome: 'absent', searched: [] }),
      probe: { version: async () => ({ state: 'unreadable', reason: '' }), startup: async () => ({ ok: true }) },
      update: {
        view: async () => Promise.reject(new Error('unused')),
        start: async () => Promise.reject(new Error('unused')),
        settled: async () => undefined,
      },
    });
    await harness.prepareHome({
      ferret: 'f1',
      home: HOME,
      instructions: [],
      parts: [{ kind: 'mcp', name: 'ferretry', config: { command: 'fy' } }],
    } as never);
    expect(written).toEqual(['config.toml']);
    // The ferret's own scoped home, and the agent-homes folder that makes it private: no other root.
    expect([...new Set(asked)]).toEqual(['agent-homes']);
  });

  test('F-0028 the settings file Codex reads at launch is named config.toml', () => {
    expect(RUNTIME_SETTINGS_FILE).toBe('config.toml');
  });

  test('F-0088 the file the home is prepared with is the same name Codex reads', async () => {
    expect(RUNTIME_SETTINGS_FILE).toBe('config.toml');
    expect(manifest.permissions?.roots).toContain('agent-homes');
  });

  test('F-0089 the rollout-format probe finds config.toml in the same home root the launch writes it to', () => {
    expect(manifest.permissions?.roots).toEqual(['agent-homes', 'harness-history']);
    expect(RUNTIME_SETTINGS_FILE).toBe('config.toml');
  });

  test('F-0161 Codex’s settings items are the config collection codex/settings, one yaml file per name', () => {
    expect(CODEX_SETTINGS.shape).toBe('collection');
    expect(CODEX_SETTINGS.shape === 'collection' && CODEX_SETTINGS.collection).toBe('codex/settings');
    expect(manifest.data?.config).toContain(CODEX_SETTINGS);
  });
});
