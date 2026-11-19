/**
 * `hostHistory`: the owner's own `~/.codex` history is offered to the conversation index only while it is on (default).
 * Off, the harness lists no owner source and opens nothing in the owner's home. Real kernel roots, a fake owner home in a
 * temp dir (never the real `~/.codex`), no network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessHistorySource } from '@ferretry/core-ferrets/contract';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import { ensureInternalRootBases } from '../../../../core/kernel/host/roots.ts';
import {
  CODEX_AGENT_HOMES,
  CODEX_HISTORY_ENTRIES,
  CODEX_HISTORY_POOL,
  CODEX_CONFIG,
  HarnessConfigSchema,
} from '../../contract/index.ts';
import { codexHarness } from '../../daemon/adapters/codex-harness.ts';
import { selectEverything } from '../support/selected.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const RELATIVE = 'sessions/2026/11/16/rollout-2026-11-16T09-00-00-host.jsonl';
const TEXT = 'host conversation\n';

async function world(hostHistory: (() => boolean) | undefined) {
  const parent = await mkdtemp(join(tmpdir(), 'ferretry-codex-host-history-'));
  parents.push(parent);
  const home = join(parent, 'fy');
  const owner = join(parent, 'owner/.codex');
  await mkdir(join(owner, 'sessions/2026/11/16'), { recursive: true });
  await writeFile(join(owner, RELATIVE), TEXT);
  for (const folder of ['', 'state', 'state/codex', 'state/codex/agent-homes'])
    await mkdir(join(home, folder), { recursive: true, mode: 0o700 }).then(() => chmod(join(home, folder), 0o700));
  const pooling = {
    historyPool: { state: CODEX_HISTORY_POOL.name, entries: CODEX_HISTORY_ENTRIES },
    stateFiles: [CODEX_AGENT_HOMES, CODEX_HISTORY_POOL],
  };
  const fs = nodeFs(() => crypto.randomUUID());
  await ensureInternalRootBases(fs, { home, plugin: 'codex' }, ['agent-homes', 'harness-history'], pooling);
  const roots = rootsPortFor(
    fs,
    { home, plugin: 'codex', worktrees: join(parent, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    { hardLinkRoots: [], ...pooling },
  );
  const asked = { historyHome: 0 };
  const kernel = { roots, log: { warn: () => undefined } } as unknown as KernelPorts;
  const harness = codexHarness({
    selected: selectEverything,
    kernel,
    locate: async () => ({ outcome: 'absent' }) as never,
    probe: {} as never,
    update: {} as never,
    historyHome: async () => {
      asked.historyHome++;
      return owner;
    },
    ...(hostHistory === undefined ? {} : { hostHistory }),
  });
  const sources = async (): Promise<readonly HarnessHistorySource[]> => {
    if (harness.historySources === undefined) throw new Error('the harness does not offer history sources');
    return await harness.historySources();
  };
  return { sources, owner, asked };
}

describe('hostHistory', () => {
  test('the config default is on, and an explicit off parses', () => {
    expect(HarnessConfigSchema.parse({}).hostHistory).toBe(true);
    expect(HarnessConfigSchema.parse({ hostHistory: false }).hostHistory).toBe(false);
    expect(HarnessConfigSchema.safeParse({ hostHistory: 'no' }).success).toBe(false);
  });

  test('default (no setting wired): the owner source is listed and readable, unchanged', async () => {
    const w = await world(undefined);
    const computer = (await w.sources()).filter(source => source.kind === 'computer');
    expect(computer).toHaveLength(1);
    expect(computer[0]?.label).toBe('owner');
    expect((await computer[0]?.files.entries('sessions/2026/11/16'))?.map(entry => entry.name)).toEqual([
      'rollout-2026-11-16T09-00-00-host.jsonl',
    ]);
  });

  test('on: the same as the default', async () => {
    const w = await world(() => true);
    expect((await w.sources()).filter(source => source.kind === 'computer')).toHaveLength(1);
  });

  test('off: no owner source, the owner home is never asked for, and nothing in it changes', async () => {
    const w = await world(() => false);
    const found = await w.sources();
    expect(found.filter(source => source.kind === 'computer')).toEqual([]);
    expect(w.asked.historyHome).toBe(0);
    expect(await readFile(join(w.owner, RELATIVE), 'utf8')).toBe(TEXT);
  });

  test('a setting that cannot be read counts as off (the safe side of a read)', async () => {
    const w = await world(() => {
      throw new Error('harness-codex.yaml is damaged');
    });
    expect((await w.sources()).filter(source => source.kind === 'computer')).toEqual([]);
    expect(w.asked.historyHome).toBe(0);
  });

  test('flipping it is seen on the next look, with no restart', async () => {
    let on = true;
    const w = await world(() => on);
    expect((await w.sources()).some(source => source.kind === 'computer')).toBe(true);
    on = false;
    expect((await w.sources()).some(source => source.kind === 'computer')).toBe(false);
    on = true;
    expect((await w.sources()).some(source => source.kind === 'computer')).toBe(true);
  });

  test('an ALREADY ISSUED owner source stops answering the moment it is switched off (entries, stat and read)', async () => {
    let on = true;
    const w = await world(() => on);
    const issued = (await w.sources()).find(source => source.kind === 'computer');
    if (issued === undefined) throw new Error('the owner source is missing');
    const dir = 'sessions/2026/11/16';
    expect((await issued.files.entries(dir)).length).toBe(1);
    expect((await issued.files.stat(RELATIVE))?.size).toBe(Buffer.byteLength(TEXT));
    expect(new TextDecoder().decode(await issued.files.read(RELATIVE, 0, 64))).toBe(TEXT);
    on = false;
    expect(await issued.files.entries(dir)).toEqual([]);
    expect(await issued.files.stat(RELATIVE)).toBeUndefined();
    expect(await issued.files.read(RELATIVE, 0, 64)).toBeUndefined();
    on = true;
    expect((await issued.files.entries(dir)).length).toBe(1);
  });

  test('an already issued source fails closed when the setting becomes unreadable', async () => {
    let state: 'on' | 'broken' = 'on';
    const w = await world(() => {
      if (state === 'broken') throw new Error('damaged');
      return true;
    });
    const issued = (await w.sources()).find(source => source.kind === 'computer');
    if (issued === undefined) throw new Error('the owner source is missing');
    state = 'broken';
    expect(await issued.files.read(RELATIVE, 0, 64)).toBeUndefined();
  });
});

describe('hostHistory is held for the owner when it is turned back ON', () => {
  const held = CODEX_CONFIG.loosens;
  const file = (document: Record<string, unknown>) => HarnessConfigSchema.parse(document);
  const said = ['agents now let Ferretry read your own Codex conversations on this computer (hostHistory turned on)'];

  test('false to true is held', () => {
    expect(held(file({ hostHistory: false }), file({ hostHistory: true }))).toEqual(said);
  });

  test('removing the line (it falls back to true) is held; so is removing every setting', () => {
    expect(held(file({ hostHistory: false }), file({}))).toEqual(said);
    expect(held(file({ hostHistory: false, permissionMode: 'auto' }), file({ permissionMode: 'auto' }))).toEqual(said);
  });

  test('true to false, no change, and a first document are not held (narrowing or nothing new)', () => {
    expect(held(file({ hostHistory: true }), file({ hostHistory: false }))).toEqual([]);
    expect(held(file({ hostHistory: false }), file({ hostHistory: false }))).toEqual([]);
    expect(held(file({}), file({}))).toEqual([]);
    expect(held(undefined, file({ hostHistory: false }))).toEqual([]);
  });
});
