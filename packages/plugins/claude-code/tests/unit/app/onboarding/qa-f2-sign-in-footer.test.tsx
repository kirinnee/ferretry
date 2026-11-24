/**
 * QA F2 (O9 walk, f4a20555): on "Sign in to Claude" Back, Later and Next are ALL disabled and Cancel does not unlock them.
 * The page holds Next with `step.busy('Sign in to Claude to continue')`, but the shell's `busy(label)` locks the WHOLE
 * footer (onboarding `page-frame.tsx` rule 3), and step-host.ts rule 8 says a page never calls `busy()` just to hold Next.
 * Codex's sign-in page never calls `busy()`, which is why its footer stays live. Next is held instead by a registered save
 * that refuses with a sentence (rule 8): Back and Later stay enabled.
 */
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

const open = async (withPanel: boolean) => {
  const client = scripted({});
  noteClientDaemon(client, 'fy_daemon_fake');
  const run = stepHarness();
  const slots: Record<string, PlacedPanel[]> = withPanel
    ? {
        'claude-code.sign-in': [
          {
            plugin: 'logins',
            id: 'claude-code-sign-in',
            view: (props: Props) => {
              queueMicrotask(() => (props.onShown as () => void)());
              return <p>Sign in to Claude Code</p>;
            },
          },
        ],
      }
    : {};
  const view = await mount(
    <WithSlotPanels slots={slots}>
      <SignInPage client={client} step={run.step} />
    </WithSlotPanels>,
  );
  mounted.push(view);
  await settle();
  return run;
};

describe('QA F2: the Claude sign-in page while nobody is signed in', () => {
  for (const withPanel of [true, false]) {
    it(`never locks the whole footer (no busy label), ${withPanel ? 'with' : 'without'} the sign-in panel`, async () => {
      const run = await open(withPanel);
      expect(run.events).toContain('ready');
      expect(run.events.filter(event => event.startsWith('busy:') && event !== 'busy:null')).toEqual([]);
    });

    it(`still never records a sign-in on Next, ${withPanel ? 'with' : 'without'} the sign-in panel`, async () => {
      const run = await open(withPanel);
      expect(run.hasCommit).toBe(true);
      await expect(run.runCommit()).rejects.toThrow(/sign in/iu);
      expect(run.events).not.toContain('done');
    });
  }
});
