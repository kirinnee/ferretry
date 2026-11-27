import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedClock } from '@ferretry/kernel/testing';
import should from 'should';
import { BrowserIdentityKeySchema } from '../../../contract/wire.ts';
import { BrowserToolCallSchema } from '../../../daemon/tools/wire.ts';
import { IdentityBrowsers } from '../../../daemon/pages/identities.ts';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { nodeStagedFiles } from '../../../daemon/tools/adapters/staged-files.ts';
import { rootFiles } from '../../../daemon/tools/files.ts';
import { SurfaceControl } from '../../../daemon/tools/control.ts';
import { BrowserTools, type BrowserToolPorts } from '../../../daemon/tools/service.ts';
import type { ToolCaller } from '../../../daemon/tools/types.ts';
import { browserKernel } from '../../support/kernel.ts';
import { Tabs } from '../../support/tabs.ts';
import { workRoots } from '../../support/work-root.ts';

const agent: ToolCaller = { kind: 'agent', sessionId: 's1' };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

/** The real identity router over one fake Chrome per identity, with the real tools on top of it: what an agent's call reaches. */
async function world() {
  const chromes = new Map<string, Tabs>();
  const launches: string[] = [];
  const chromeOf = (identity: string): Tabs => {
    let tabs = chromes.get(identity);
    if (tabs === undefined) {
      tabs = new Tabs();
      tabs.idSuffix = `-${identity}`;
      chromes.set(identity, tabs);
    }
    return tabs;
  };
  const browser = new IdentityBrowsers({
    maxRunning: () => 4,
    configured: () => true,
    make: (identity, quota) =>
      new BrowserSessionService(
        { get: async id => (id === 's1' ? {} : undefined) },
        {
          launch: async (_viewport, named) => {
            launches.push(named ?? 'agent');
            return chromeOf(named ?? 'agent').automation;
          },
        },
        () => Date.parse('2026-11-27T10:00:00.000Z'),
        undefined,
        undefined,
        undefined,
        identity,
        quota,
      ),
  });
  const root = await mkdtemp(join(tmpdir(), 'ferretry-browser-identity-tools-'));
  roots.push(root);
  const work = join(root, 'work');
  await mkdir(join(work, '.fy'), { recursive: true });
  const clock = fixedClock();
  const kernel = browserKernel({ secrets: [], clock });
  const tools = new BrowserTools({
    browser: browser as unknown as BrowserToolPorts['browser'],
    control: new SurfaceControl(
      { publish: async () => undefined, history: async () => [] },
      { now: () => clock.nowMs() },
    ),
    kernel: kernel.kernel,
    policy: { allows: async () => true },
    files: rootFiles(workRoots(work, join(work, '.fy')), nodeStagedFiles(join(root, 'upload'), clock)),
    binaryName: 'fy',
    protection: { now: () => clock.nowMs(), appOrigins: () => new Set(), liveSince: () => false },
  });
  return { tools, browser, chromeOf, launches };
}

describe('the browser tools choose the identity', () => {
  it('should open a page in the identity the agent names, and list it with its identity', async () => {
    // Arrange
    const { tools, chromeOf, launches } = await world();

    // Act
    const opened = await tools.call(agent, { tool: 'browser.open', name: 'work', identity: 'b' });
    const listed = await tools.call(agent, { tool: 'browser.list' });

    // Assert — B's Chrome holds it; no `agent` Chrome was started for it
    should(launches).deepEqual(['b']);
    should(chromeOf('b').pages.length).be.above(0);
    should(opened.summary).containEql('in identity b');
    should(listed.surfaces).have.length(1);
    should(listed.surfaces?.[0]).match({ name: 'work', identity: 'b' });
    should(listed.summary).containEql('(b)');
  });

  it('should open in the built-in agent identity when none is named, even after the session used another one', async () => {
    // Arrange
    const { tools, launches } = await world();
    await tools.call(agent, { tool: 'browser.open', name: 'work', identity: 'b' });

    // Act
    await tools.call(agent, { tool: 'browser.open', name: 'plain' });
    const listed = await tools.call(agent, { tool: 'browser.tabs', action: 'list' });

    // Assert
    should(launches).deepEqual(['b', 'agent']);
    const identities = Object.fromEntries((listed.surfaces ?? []).map(row => [row.name, row.identity]));
    should(identities).deepEqual({ work: 'b', plain: 'agent' });
  });

  it('should drive a named page in the identity that holds it', async () => {
    // Arrange
    const { tools, chromeOf } = await world();
    await tools.call(agent, { tool: 'browser.open', name: 'plain' });
    await tools.call(agent, { tool: 'browser.open', name: 'work', identity: 'b' });

    // Act
    await tools.call(agent, { tool: 'browser.click', name: 'work', selector: '#go' });

    // Assert — only B's Chrome was clicked
    should(chromeOf('b').calls.some(call => call.startsWith('click'))).equal(true);
    should(chromeOf('agent').calls.some(call => call.startsWith('click'))).equal(false);
  });

  it('should take exactly the identity keys the contract names, and refuse the rest before any Chrome starts', async () => {
    // Arrange
    const { launches } = await world();
    const open = (identity: string) => BrowserToolCallSchema.safeParse({ tool: 'browser.open', name: 'x', identity });

    // Act / Assert — the MCP row's own test holds the same keys to the same schema
    for (const key of ['b', 'work-2', 'a'.repeat(32), '', 'B', '../agent', '1a', 'a'.repeat(33)])
      should(open(key).success).equal(BrowserIdentityKeySchema.safeParse(key).success);
    should(open('../agent').success).equal(false);
    should(launches).deepEqual([]);
  });
});
