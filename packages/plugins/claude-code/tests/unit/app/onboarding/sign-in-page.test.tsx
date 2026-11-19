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
    // ready, then the hold: the shell's Next is locked (it would record a default as done); Later and Skip are not.
    expect(run.events).toEqual(['ready', 'busy:Sign in to Claude to continue']);
    await interact(() => (view.container.querySelector('[data-fake-sign-in]') as HTMLElement).click());
    expect(run.events).toEqual(['ready', 'busy:Sign in to Claude to continue', 'busy:null', 'done']);
  });

  it('does not hold Next on a page that has no panel to sign in with (nothing here could free it)', async () => {
    const { run } = await open(null);
    expect(run.events).toEqual(['ready']);
  });

  it('shows itself, saying where to sign in, when no plugin fills the slot', async () => {
    const { view, run } = await open(null);
    expect(run.events).toEqual(['ready']);
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
