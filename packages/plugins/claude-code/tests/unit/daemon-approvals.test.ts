import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness, LaunchSpec } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import type { ClaudeCodeApi } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import manifest from '../../manifest.ts';

/**
 * MCP's `approvedProjectServers` question, answered by the REAL daemon half over the real kernel roots on a temp disk
 * (fake JSON only, no real home): the half reads the ferret's home through the same `agent-homes` root its harness
 * writes it with. What MCP does with each answer (bind an approved server, bind nothing for a disabled one or an
 * unreadable home) is MCP's `project-launch.test.ts`.
 */

const FERRET = 'f1' as FerretId;
const ROOT = '/work/app';
let fixture: string;
let HOME: string;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'claude-code-approvals-unit-'));
  HOME = join(fixture, 'fy-home/state/claude-code/agent-homes/f1');
  await mkdir(HOME, { recursive: true });
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

function half(): { readonly claudeCode: ClaudeCodeApi; readonly harness: Harness } {
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: join(fixture, 'fy-home'), plugin: 'claude-code', worktrees: join(fixture, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
  );
  const built = daemon.build?.({
    manifest,
    needs: {},
    uses: {},
    hooks: {} as never,
    kernel: {
      roots,
      config: { file: () => ({ searchPaths: [], permissionMode: 'auto' }), collection: () => new Map() },
      spawn: {
        run: async () => {
          throw new Error('nothing is launched to answer an approval');
        },
      },
      fetch: {
        request: async () => {
          throw new Error('nothing is fetched to answer an approval');
        },
      },
      clock: { now: () => '2026-11-07T10:00:00.000Z', nowMs: () => 0, sleep: async () => {} },
      events: { publish() {} },
      state: { read: async () => ({ ok: false }), write: async () => {} },
      redaction: { read: async (fn: (scope: unknown) => unknown) => await fn({ text: (s: string) => s }) },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as DaemonContext<typeof manifest>['kernel'],
  } as unknown as DaemonContext<typeof manifest>);
  const provides = built?.provides as { claudeCode?: ClaudeCodeApi } | undefined;
  const harness = (built?.hooks as Record<string, unknown> | undefined)?.['harnesses:claude-code'] as
    | Harness
    | undefined;
  if (provides?.claudeCode === undefined || harness === undefined) throw new Error('the half provides no claudeCode');
  return { claudeCode: provides.claudeCode, harness };
}

const spec = (): LaunchSpec =>
  ({
    ferret: FERRET,
    name: 'a',
    role: 'lead',
    harness: 'claude-code',
    folder: ROOT,
    home: HOME,
    instructions: [],
    parts: [],
  }) as unknown as LaunchSpec;

const ask = async (claudeCode: ClaudeCodeApi, ferret: FerretId = FERRET) =>
  await claudeCode.approvedProjectServers?.({ ferret, root: ROOT, servers: ['docs', 'tracker', 'fresh'] });

/** A `.claude.json` that approves every server of the project: what a read must never hand over by mistake. */
const APPROVE_ALL = JSON.stringify({
  projects: { [ROOT]: { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true } },
});

describe('the Claude Code daemon half serves approvedProjectServers', () => {
  test('an approved server answers approved, a disabled one disabled, an unanswered one pending', async () => {
    const { claudeCode } = half();
    await writeFile(
      join(HOME, '.claude.json'),
      JSON.stringify({
        projects: {
          [ROOT]: {
            hasTrustDialogAccepted: true,
            enabledMcpjsonServers: ['docs'],
            disabledMcpjsonServers: ['tracker'],
          },
        },
      }),
    );

    expect(await ask(claudeCode)).toEqual({
      state: 'read',
      servers: { docs: 'approved', tracker: 'disabled', fresh: 'pending' },
    });
  });

  test('a decision made in Claude survives the launches that follow, so the disabled server stays withheld', async () => {
    const { claudeCode, harness } = half();
    await harness.prepareHome(spec());
    const seeded = JSON.parse(await readFile(join(HOME, '.claude.json'), 'utf8')) as {
      projects: Record<string, Record<string, unknown>>;
    };
    const entry = seeded.projects[ROOT] ?? {};
    entry.enabledMcpjsonServers = ['docs'];
    entry.disabledMcpjsonServers = ['tracker'];
    await writeFile(join(HOME, '.claude.json'), JSON.stringify(seeded));

    for (const launch of [2, 3, 4]) {
      await harness.prepareHome(spec());
      expect([launch, await ask(claudeCode)]).toEqual([
        launch,
        { state: 'read', servers: { docs: 'approved', tracker: 'disabled', fresh: 'pending' } },
      ]);
    }
  });

  test('a home it cannot read answers unreadable, and a ferret id that is not a plain name is refused', async () => {
    const { claudeCode } = half();
    await writeFile(join(HOME, '.claude.json'), '{"projects": ');
    expect((await ask(claudeCode))?.state).toBe('unreadable');
    expect((await ask(claudeCode, '../f2' as FerretId))?.state).toBe('unreadable');
  });

  test("a multi-part ferret id (f2/x) is refused before it reaches a folder inside another ferret's home", async () => {
    const { claudeCode } = half();
    const inside = join(fixture, 'fy-home/state/claude-code/agent-homes/f2/x');
    await mkdir(inside, { recursive: true });
    await writeFile(join(inside, '.claude.json'), APPROVE_ALL);

    expect((await ask(claudeCode, 'f2/x' as FerretId))?.state).toBe('unreadable');
    expect((await ask(claudeCode, '../f2' as FerretId))?.state).toBe('unreadable');
  });

  test("a ferret's first launch, before its home exists, answers pending for every server, and its launch still makes the home", async () => {
    const { claudeCode, harness } = half();
    await rm(HOME, { recursive: true });

    expect(await ask(claudeCode)).toEqual({
      state: 'read',
      servers: { docs: 'pending', tracker: 'pending', fresh: 'pending' },
    });
    await harness.prepareHome(spec());
    expect(await ask(claudeCode)).toEqual({
      state: 'read',
      servers: { docs: 'pending', tracker: 'pending', fresh: 'pending' },
    });
  });

  test('a LINK at the home name answers unreadable, even to a folder that approves everything', async () => {
    const { claudeCode } = half();
    await rm(HOME, { recursive: true });
    const elsewhere = join(fixture, 'fy-home/state/claude-code/agent-homes/f9');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, '.claude.json'), APPROVE_ALL);
    await symlink(elsewhere, HOME);

    const answer = await ask(claudeCode);

    expect(answer?.state).toBe('unreadable');
    expect(JSON.stringify(answer)).not.toContain('approved');
  });

  test('a FILE at the home name answers unreadable', async () => {
    const { claudeCode } = half();
    await rm(HOME, { recursive: true });
    await writeFile(HOME, APPROVE_ALL);

    expect((await ask(claudeCode))?.state).toBe('unreadable');
  });
});
