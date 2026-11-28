import { describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { Harness } from '@ferretry/core-ferrets/contract';
import { ClaudeHarness } from '../../../daemon/adapters/claude-harness.ts';
import { composeClaudeHarness } from '../../../daemon/harness/parts/compose.ts';
import type { ClaudeCore } from '../../../daemon/harness/parts/core.ts';
import { CLAUDE_PARTS } from '../../../daemon/harness/parts/list.ts';

/**
 * Every member of `Harness` the Claude Code harness serves, and the ONE part that serves it. A member in two parts, a
 * member in none, or a part that grows one this table does not name fails here; the members `Harness` offers that Claude
 * Code deliberately does not (`inject`, ...) are listed so a new one is a decision, not an accident.
 */
const SERVED = {
  deliverPart: ['deliver'],
  dialogsPart: ['dialogs'],
  forkPart: ['fork'],
  historyPart: ['conversations', 'hasConversation', 'historySources', 'importConversation'],
  homePart: ['homeFor', 'prepareHome'],
  identityPart: ['accepts', 'facts', 'key', 'turnStop'],
  launchSettingsPart: ['launchSettings'],
  lifecyclePart: ['autoLaunchRefusal', 'discover', 'resume', 'start', 'stop', 'update'],
  relocationPart: ['packConversation', 'unpackConversation'],
  runtimeSwitchPart: ['runtimeSwitch'],
  transcriptPart: ['transcript', 'transcriptBytes', 'transcriptStamp', 'transcriptTail'],
  usagePart: ['usage'],
} as const satisfies Record<string, readonly (keyof Harness)[]>;

/** What `Harness` declares and Claude Code does not serve (its own conversation naming, no protocol send, no move). */
const NOT_SERVED = [
  'screenReader',
  'adoptConversation',
  'exportConversation',
  'inject',
  'provedConversation',
  'runtime',
  'startFailure',
  'stagesRelaunch',
  'subscriptionRefusal',
] as const satisfies readonly (keyof Harness)[];

const core = { deps: {} as never, delivered: new Set<string>() } satisfies ClaudeCore;

describe('the Claude harness parts', () => {
  it('serves each member from exactly one part', () => {
    const owner = new Map<string, string>();
    for (const part of CLAUDE_PARTS) {
      for (const member of Object.keys(part(core))) {
        should(owner.get(member)).equal(undefined, `${member} is served by ${owner.get(member)} and ${part.name}`);
        owner.set(member, part.name);
      }
    }
    const expected = new Map<string, string>();
    for (const [part, members] of Object.entries(SERVED)) for (const member of members) expected.set(member, part);
    should([...owner].sort()).deepEqual([...expected].sort());
  });

  it('names every part in the table and every part in the registry once', () => {
    const registered = CLAUDE_PARTS.map(part => part.name);
    should([...registered].sort()).deepEqual(Object.keys(SERVED).sort());
    should(new Set(registered).size).equal(registered.length);
    should(registered).deepEqual([...registered].sort());
  });

  it('keeps every member of Harness either served or deliberately left out', () => {
    const served = new Set<string>(Object.values(SERVED).flat());
    const ABSENT: Record<keyof Harness, true> = {
      screenReader: true,
      accepts: true,
      autoLaunchRefusal: true,
      adoptConversation: true,
      conversations: true,
      deliver: true,
      dialogs: true,
      discover: true,
      exportConversation: true,
      packConversation: true,
      facts: true,
      fork: true,
      hasConversation: true,
      historySources: true,
      homeFor: true,
      importConversation: true,
      inject: true,
      key: true,
      launchSettings: true,
      prepareHome: true,
      provedConversation: true,
      resume: true,
      runtime: true,
      runtimeSwitch: true,
      start: true,
      startFailure: true,
      stagesRelaunch: true,
      stop: true,
      subscriptionRefusal: true,
      transcript: true,
      transcriptBytes: true,
      transcriptStamp: true,
      transcriptTail: true,
      turnStop: true,
      update: true,
      unpackConversation: true,
      usage: true,
    };
    const unsaid = Object.keys(ABSENT).filter(
      member => !served.has(member) && !(NOT_SERVED as readonly string[]).includes(member),
    );
    should(unsaid).deepEqual([]);
  });

  it('composes the harness from them and refuses a member served twice', () => {
    const harness = new ClaudeHarness({ newConversationId: () => 'x' } as never);
    should(Object.keys(harness).sort()).deepEqual(Object.values(SERVED).flat().sort());
    should(harness.key).equal('claude-code');
    should(() => composeClaudeHarness(core)).not.throw();
  });
});

describe('the parts registry takes two independent additions without a conflict', () => {
  it('merges two one-line adds in different places (3-way) with no conflict', async () => {
    const registry = join(import.meta.dir, '../../../daemon/harness/parts/index.ts');
    const base = await readFile(registry, 'utf8');
    const add = (text: string, name: string, file: string, before: string): string =>
      text.replace(
        `export * as ${before} from`,
        `export * as ${name} from './${file}.ts';\nexport * as ${before} from`,
      );
    const dir = await mkdtemp(join(tmpdir(), 'claude-parts-merge-'));
    try {
      await writeFile(join(dir, 'base.ts'), base);
      await writeFile(join(dir, 'a.ts'), add(base, 'cache', 'cache', 'deliver'));
      await writeFile(join(dir, 'b.ts'), add(base, 'memory', 'memory', 'runtimeSwitch'));
      const merged = Bun.spawn(
        ['git', 'merge-file', '-p', join(dir, 'a.ts'), join(dir, 'base.ts'), join(dir, 'b.ts')],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const text = await new Response(merged.stdout).text();
      should(await merged.exited).equal(0);
      should(text).containEql("export * as cache from './cache.ts';\nexport * as deliver from");
      should(text).containEql("export * as memory from './memory.ts';\nexport * as runtimeSwitch from");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
