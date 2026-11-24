/** The "Sign in" page: it offers Logins' slot with three callbacks, and does what the panel says. */
import {
  noteClientDaemon,
  interact,
  type Mounted,
  mount,
  type PlacedPanel,
  WithSlotPanels,
} from '@ferretry/app/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { SignInPage } from '../../../../app/features/onboarding/sign-in-page.tsx';
import { scripted, stepHarness } from '../../../fixtures/onboarding/harness.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

type Props = Record<string, unknown>;
const call = (props: Props, name: string): void => (props[name] as () => void)();

/** A stand-in for Logins' panel: it says what it found when it mounts, and "signed in" on a press. */
const open = async (found: 'nothing' | 'usable' | null) => {
  const client = scripted({});
  noteClientDaemon(client, 'fy_daemon_fake');
  const run = stepHarness();
  const slots: Record<string, PlacedPanel[]> =
    found === null
      ? {}
      : {
          'claude-code.sign-in': [
            {
              plugin: 'logins',
              id: 'claude-code-sign-in',
              view: (props: Props) => {
                queueMicrotask(() => call(props, found === 'usable' ? 'onAlreadySignedIn' : 'onShown'));
                return (
                  <button type="button" data-fake-sign-in="" onClick={() => call(props, 'onSignedIn')}>
                    Sign in to Claude Code
                  </button>
                );
              },
            },
          ],
        };
  const view = await mount(
    <WithSlotPanels slots={slots}>
      <SignInPage client={client} step={run.step} />
    </WithSlotPanels>,
  );
  mounted.push(view);
  await settle();
  return { view, run };
};

describe('the sign-in page', () => {
  it('skips itself when the panel says a Claude login is already usable', async () => {
    const { run } = await open('usable');
    expect(run.events).toEqual(['skip:not-needed']);
  });

  it('lifts its loading cover, holds Next while nobody is signed in, and is done (Next free) only once it signed in', async () => {
    const { view, run } = await open('nothing');
    // ready, then Next's refusing save (rule 8): Next stays and says why; Back and Later stay live. Signed in clears the save.
    expect(run.events).toEqual(['ready', 'commit']);
    await interact(() => (view.container.querySelector('[data-fake-sign-in]') as HTMLElement).click());
    expect(run.events).toEqual(['ready', 'commit', 'commit', 'done']);
  });

  it('holds Next with a refusing save (never records a sign-in with no login) when there is no panel to sign in with; Later and Skip stay', async () => {
    const { run } = await open(null);
    expect(run.events).toEqual(['ready', 'commit']);
    expect(run.events).not.toContain('done');
  });

  it('shows itself, saying where to sign in, when no plugin fills the slot', async () => {
    const { view, run } = await open(null);
    expect(run.events).toEqual(['ready', 'commit']);
    expect(view.container.querySelector('[data-sign-in-missing]')?.textContent).toContain('Settings › Logins');
  });

  it('never calls a route of Logins itself', async () => {
    const client = scripted({});
    noteClientDaemon(client, 'fy_daemon_fake');
    const view = await mount(
      <WithSlotPanels slots={{}}>
        <SignInPage client={client} step={stepHarness().step} />
      </WithSlotPanels>,
    );
    mounted.push(view);
    await settle();
    expect(client.calls).toEqual([]);
  });
});
