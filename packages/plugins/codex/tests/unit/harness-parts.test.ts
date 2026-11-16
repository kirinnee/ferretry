import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHarness } from '../../daemon/adapters/codex-harness.ts';
import { harnessContext, type CodexHarnessOptions } from '../../daemon/harness/parts/context.ts';
import { CODEX_HARNESS_PARTS } from '../../daemon/harness/parts/index.ts';

/** Every member the harness has, from before it was split into parts: composing the parts must give exactly these. */
const BASE_MEMBERS = [
  'accepts',
  'conversations',
  'credentials',
  'deliver',
  'discover',
  'launchSettings',
  'hasConversation',
  'historySources',
  'homeFor',
  'importConversation',
  'inject',
  'key',
  'prepareHome',
  'provedConversation',
  'resume',
  'start',
  'startFailure',
  'stop',
  'transcript',
  'transcriptBytes',
  'transcriptStamp',
  'transcriptTail',
  'turnStop',
  'update',
  'usage',
].sort();

/** The pin: which part owns which members. A member moving to another part is a change to this table. */
const OWNERS: Record<string, string[]> = {
  conversationPart: ['conversations', 'hasConversation', 'importConversation', 'provedConversation'],
  credentialsPart: ['credentials'],
  deliverPart: ['deliver'],
  discoverPart: ['discover', 'update'],
  historyPart: ['historySources'],
  homePart: ['homeFor', 'prepareHome'],
  identityPart: ['accepts', 'key', 'turnStop'],
  injectPart: ['inject'],
  launchSettingsPart: ['launchSettings'],
  lifecyclePart: ['resume', 'start', 'stop'],
  runtimeSwitchPart: ['runtimeSwitch'],
  startFailurePart: ['startFailure'],
  transcriptPart: ['transcript', 'transcriptBytes', 'transcriptStamp', 'transcriptTail', 'usage'],
};

const withoutSwitch = {
  kernel: { roots: {}, log: {}, clock: {}, redaction: {}, state: {} },
  selected: async () => ({ settings: new Map() }),
  locate: async () => ({ outcome: 'absent' }),
  probe: {},
  update: {},
} as unknown as CodexHarnessOptions;
const withSwitch = { ...withoutSwitch, runtimeSwitch: () => ({}) } as unknown as CodexHarnessOptions;

describe('the Codex harness parts', () => {
  test('every member lives in exactly the part the pin names, and in no other', () => {
    const context = harnessContext(withSwitch);
    const found = Object.fromEntries(
      CODEX_HARNESS_PARTS.map(part => [part.name, Object.keys(part(context)).sort()] as const),
    );
    expect(found).toEqual(OWNERS);
    const all = Object.values(found).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  test('the registry lists each part once, sorted by name', () => {
    const names = CODEX_HARNESS_PARTS.map(part => part.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });

  test('the composed harness has exactly the members it had before the split', () => {
    expect(Object.keys(codexHarness(withoutSwitch)).sort()).toEqual(BASE_MEMBERS);
    expect(Object.keys(codexHarness(withSwitch)).sort()).toEqual([...BASE_MEMBERS, 'runtimeSwitch'].sort());
  });

  test('two independent one-line adds to the registry merge cleanly', async () => {
    const registry = await readFile(join(import.meta.dir, '../../daemon/harness/parts/index.ts'), 'utf8');
    const dir = await mkdtemp(join(tmpdir(), 'codex-parts-registry-'));
    try {
      // The first entry: its own line is added before it, so the opening `= [` is not touched.
      const ours = registry
        .replace(
          "import { conversationPart } from './conversation.ts';\n",
          "import { auditPart } from './audit.ts';\nimport { conversationPart } from './conversation.ts';\n",
        )
        .replace('  conversationPart,\n', '  auditPart,\n  conversationPart,\n');
      // The last entry: its own line is added after it, so the closing `] as const;` is not touched.
      const theirs = registry
        .replace(
          "import { transcriptPart } from './transcript.ts';\n",
          "import { transcriptPart } from './transcript.ts';\nimport { zoomPart } from './zoom.ts';\n",
        )
        .replace('  transcriptPart,\n', '  transcriptPart,\n  zoomPart,\n');
      await writeFile(join(dir, 'base.ts'), registry);
      await writeFile(join(dir, 'ours.ts'), ours);
      await writeFile(join(dir, 'theirs.ts'), theirs);
      const merged = spawnSync('git', ['merge-file', '-p', 'ours.ts', 'base.ts', 'theirs.ts'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(merged.status).toBe(0);
      expect(merged.stdout).toContain('  auditPart,\n  conversationPart,');
      expect(merged.stdout).toContain('  transcriptPart,\n  zoomPart,\n]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
