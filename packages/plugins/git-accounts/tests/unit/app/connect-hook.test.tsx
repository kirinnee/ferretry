/**
 * The connect card Projects mounts in its Create-a-project flow (`projects.connect-account`): Git accounts provides the
 * SAME card as its settings tab, and tells the flow which account GitHub approved.
 */
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import appHalf from '../../../app/index.ts';
import { buttonNamed, click, mount, q, settle, settleUntil } from '../../support/app-dom.ts';
import { hubot, NOW, scriptedGithub } from '../../support/scripted-github.ts';

const mounts: Array<{ unmount: () => Promise<void> }> = [];
afterEach(async () => {
  setSystemTime();
  while (mounts.length > 0) await mounts.pop()?.unmount();
});

const HOOK = 'projects.connect-account';

describe('the connect card given to Projects', () => {
  it('is provided under the name Projects offers, as a component', () => {
    const { client } = scriptedGithub();
    const given = appHalf.shell?.hooks?.[HOOK]?.({ client: client as never, daemon: 'workstation' }) as {
      panel: unknown;
    };
    expect(typeof given.panel).toBe('function');
  });

  it('draws the consent words, then the code, and reports the approved account by id', async () => {
    const { client } = scriptedGithub({
      polls: [{ status: 'done', accountId: hubot.id, login: hubot.login }],
      connects: hubot,
    });
    const given = appHalf.shell?.hooks?.[HOOK]?.({ client: client as never, daemon: 'workstation' }) as {
      panel: (props: { connected: number; onConnected: (id: string) => void }) => unknown;
    };
    const Panel = given.panel as (props: { connected: number; onConnected: (id: string) => void }) => never;
    // The scripted code runs out at a fixed instant; the card reads the real clock, so the clock is pinned before it.
    setSystemTime(new Date(NOW));
    const told: string[] = [];
    const mounted = await mount(<Panel connected={0} onConnected={id => told.push(id)} />);
    mounts.push(mounted);
    await settle();
    await click(buttonNamed(mounted.container, 'Connect a GitHub account'));
    await click(buttonNamed(mounted.container, 'Continue to GitHub'));
    await settleUntil(() => told.length > 0, 400);
    expect(told).toEqual([hubot.id]);
    expect(q(mounted.container, '[data-testid="git-done"]').textContent).toContain('Connected @hubot-fake');
  });
});
