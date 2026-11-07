/**
 * Adversarial rollout walks: a symbolic link must never lead the Codex reader to a sign-in document. Every fixture is
 * VIRTUAL — an in-memory tree — so no real harness home or `auth.json` is ever touched.
 */
import { describe, expect, test } from 'bun:test';
import type { FencedPath, FerretId, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { rootsPortFor } from '@ferretry/kernel/host';
import { err, instantFromEpochMs, ok } from '@ferretry/std';
import { CodexRollouts } from '../../daemon/adapters/rollouts.ts';
import { VirtualFs } from '../support/virtual-fs.ts';

const HOME = '/fixture-fy';
const AGENT = `${HOME}/state/codex/agent-homes/f1`;
const OWNER = '/fixture-owner/.codex';
const SIGN_IN = 'virtual-sign-in-fixture';
const at = instantFromEpochMs(0);

const line = (type: string, payload: unknown) =>
  `${JSON.stringify({ timestamp: '2026-10-20T09:00:00.000Z', type, payload })}\n`;
const rollout = (id: string, home: string, text: string) =>
  line('session_meta', {
    id,
    cwd: '/work/project',
    runtime_workspace_roots: [`${home}/codex-correlation/unreachable`],
  }) + line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

const ports = (roots: KernelPorts['roots']) =>
  ({
    roots,
    state: { read: async () => ok({ format: 1, home: AGENT, baseline: [] }) },
    redaction: { read: async (fn: (scope: { text(s: string): string }) => unknown) => await fn({ text: s => s }) },
    clock: { now: () => at },
  }) as unknown as ConstructorParameters<typeof CodexRollouts>[0];

/** The kernel's real roots over a virtual tree: the production path from the walk down to the descriptor open. */
function kernelRoots(fs: VirtualFs) {
  return rootsPortFor(
    fs.host,
    { home: HOME, plugin: 'codex', worktrees: `${HOME}-worktrees` },
    ['agent-homes', 'harness-history'],
    () => undefined,
    { hardLinkRoots: [] },
  );
}

async function readEverything(rollouts: CodexRollouts) {
  const ferret = 'f1' as FerretId;
  return {
    transcript: await rollouts.transcript.read(ferret),
    usage: await rollouts.usage.turns(ferret),
    conversations: await rollouts.conversations.list(undefined),
  };
}

const neverSignIn = (paths: readonly string[]) => expect(paths.filter(path => path.endsWith('/auth.json'))).toEqual([]);

describe('Codex rollout walk never follows a link to a sign-in document', () => {
  test('a root whose stat follows links: rollout-alias.jsonl -> auth.json and a folder link are skipped, never opened', async () => {
    // A root port may follow links in `stat` and `readText` (the contract promises only `entries`/`lstat` do not):
    // the walk must decide from the entry as it IS. Models `sessions -> .` already rebased onto the ferret home.
    const base = `${AGENT}/sessions`;
    const tree = new Map<string, { kind: 'file'; text: string } | { kind: 'symlink'; to: string }>([
      ['auth.json', { kind: 'file', text: SIGN_IN }],
      ['rollout-alias.jsonl', { kind: 'symlink', to: 'auth.json' }],
      ['nested', { kind: 'symlink', to: '' }],
      ['owned.jsonl', { kind: 'file', text: rollout('native-owned', AGENT, 'right ferret') }],
    ]);
    const opened: string[] = [];
    const follow = (path: string): string => {
      const name =
        path
          .slice(base.length + 1)
          .split('/')
          .at(-1) ?? '';
      const node = tree.get(name);
      return node?.kind === 'symlink' ? node.to : name;
    };
    const root = {
      name: 'agent-homes',
      resolve: (relative: string) =>
        relative.includes('..')
          ? err('outside' as const)
          : ok((relative === '' ? base : `${base}/${relative}`) as FencedPath),
      entries: async (path: string) =>
        path === base
          ? [...tree].map(([name, node]) => ({ name, kind: node.kind, size: 1, modified: at, mode: 0o600, links: 1 }))
          : [],
      list: async (path: string) => (path === base ? [...tree.keys()] : []),
      stat: async (path: string) => {
        const target = follow(path);
        if (target === '') return { kind: 'directory', size: 0, modified: at, mode: 0o700, links: 1 };
        return tree.has(target) ? { kind: 'file', size: 1, modified: at, mode: 0o600, links: 1 } : undefined;
      },
      readText: async (path: string) => {
        const target = follow(path);
        opened.push(`${AGENT}/${target}`);
        const node = tree.get(target);
        if (node?.kind !== 'file') throw new Error('missing');
        return node.text;
      },
      readBytes: async (path: string, limit: { offset: number; length: number }) => {
        const target = follow(path);
        opened.push(`${AGENT}/${target}`);
        const node = tree.get(target);
        if (node?.kind !== 'file') throw new Error('missing');
        return new TextEncoder().encode(node.text).slice(limit.offset, limit.offset + limit.length);
      },
    } as unknown as RootHandle;
    const rollouts = new CodexRollouts(
      ports({
        // The ferret home itself (ownership is bound to it); the walk gets the sessions root.
        root: (_name: string, scope?: { subfolder?: string }) =>
          scope?.subfolder === 'f1' ? { ...root, resolve: () => ok(AGENT as FencedPath) } : root,
      } as unknown as KernelPorts['roots']),
      async () => undefined,
    );
    const read = await readEverything(rollouts);
    expect(read.transcript.map(entry => entry.text)).toEqual(['right ferret']);
    expect(JSON.stringify(read)).not.toContain(SIGN_IN);
    neverSignIn(opened);
    expect(new Set(opened)).toEqual(new Set([`${AGENT}/owned.jsonl`]));
  });

  test('kernel roots: sessions -> . with rollout-alias.jsonl -> auth.json opens nothing at all', async () => {
    const fs = new VirtualFs()
      .directory(`${HOME}/state`)
      .file(`${AGENT}/auth.json`, SIGN_IN)
      .file(`${AGENT}/rollout-real.jsonl`, rollout('native-home', AGENT, 'outside sessions'))
      .link(`${AGENT}/sessions`, '.')
      .link(`${AGENT}/rollout-alias.jsonl`, 'auth.json');
    const read = await readEverything(new CodexRollouts(ports(kernelRoots(fs)), async () => undefined));
    // The scoped sessions root is refused at every read (its base is a link), so nothing in the home is opened.
    expect(read).toEqual({ transcript: [], usage: [], conversations: [] });
    expect(fs.opened).toEqual([]);
  });

  test('kernel roots: links inside a real sessions folder are skipped; the owned rollout is still read', async () => {
    const owned = `${AGENT}/sessions/2026/10/20/rollout-owned.jsonl`;
    const fs = new VirtualFs()
      .directory(`${HOME}/state`)
      .file(`${AGENT}/auth.json`, SIGN_IN)
      .file(owned, rollout('native-owned', AGENT, 'right ferret'))
      .link(`${AGENT}/sessions/rollout-alias.jsonl`, '../auth.json')
      .link(`${AGENT}/sessions/inside-alias.jsonl`, '2026/10/20/rollout-owned.jsonl')
      .link(`${AGENT}/sessions/up`, '..');
    const read = await readEverything(new CodexRollouts(ports(kernelRoots(fs)), async () => undefined));
    expect(read.transcript.map(entry => entry.text)).toEqual(['right ferret']);
    neverSignIn(fs.opened);
    expect(new Set(fs.opened)).toEqual(new Set([owned]));
  });

  test('kernel roots: the owner history walk skips links, even when its sessions folder is a link to the Codex home', async () => {
    const imported = `${OWNER}/sessions/2026/10/20/rollout-import.jsonl`;
    const real = new VirtualFs()
      .directory(`${HOME}/state`)
      .directory(AGENT)
      .file(`${OWNER}/auth.json`, SIGN_IN)
      .file(imported, rollout('import-native', '/another-home', 'imported'))
      .link(`${OWNER}/sessions/rollout-alias.jsonl`, '../auth.json')
      .link(`${OWNER}/sessions/back`, '..');
    const history = async () => `${OWNER}/sessions`;
    expect(await new CodexRollouts(ports(kernelRoots(real)), history).conversations.list(undefined)).toEqual([
      { id: 'import-native', folder: '/work/project', updatedAt: at },
    ]);
    neverSignIn(real.opened);
    expect(real.opened).toEqual([imported]);

    const rebased = new VirtualFs()
      .directory(`${HOME}/state`)
      .directory(AGENT)
      .file(`${OWNER}/auth.json`, SIGN_IN)
      .link(`${OWNER}/sessions`, '.')
      .link(`${OWNER}/rollout-alias.jsonl`, 'auth.json');
    expect(await new CodexRollouts(ports(kernelRoots(rebased)), history).conversations.list(undefined)).toEqual([]);
    expect(rebased.opened).toEqual([]);
  });
});
