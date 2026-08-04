/**
 * The picture has to say the same thing the words would have.
 *
 * It replaced a sentence, so the test that matters is that a reader who hears
 * the page rather than seeing it loses nothing: one accessible name per step,
 * saying where the work is and whether the two ends are joined. The second claim
 * is that no state is carried by colour alone — an unpaired browser must look
 * unpaired in a theme that flattens the accent, which is what the dashed-versus-
 * solid link is for.
 */

import { describe, expect, it } from 'bun:test';

import type { OnboardingStepId } from '../../../src/features/onboarding/onboarding-model.ts';
import { SetupDiagram } from '../../../src/features/onboarding/setup-diagram.tsx';
import { mount, must } from '../../support/dom.ts';

/**
 * EVERY step any route can put on the glass — not one route's list.
 *
 * The diagram is drawn per step rather than per route, so the fact worth pinning
 * is that no step anywhere is missing its sentence. A route's own step list is
 * the model's business and is tested there.
 */
const EVERY_STEP: readonly OnboardingStepId[] = [
  'install',
  'daemon',
  'connect',
  'local',
  'elsewhere',
  'handoff',
  'pair',
  'done',
];

const figureOf = (container: HTMLElement): HTMLElement =>
  must(container.querySelector<HTMLElement>('[data-onboarding-diagram]'), 'the diagram');

describe('the setup diagram', () => {
  it('names itself in a sentence at every step, and never the same one twice', async () => {
    const labels: string[] = [];
    for (const id of EVERY_STEP) {
      const view = await mount(<SetupDiagram step={id} />);
      const figure = figureOf(view.container);

      expect(figure.getAttribute('role')).toBe('img');
      expect(figure.getAttribute('data-onboarding-diagram')).toBe(id);
      labels.push(must(figure.getAttribute('aria-label'), `a label for ${id}`));
      await view.unmount();
    }

    expect(new Set(labels).size).toBe(EVERY_STEP.length);
    expect(labels.at(-1)).toContain('linked to the daemon');
  });

  it('hides its own text from a reader who is given the sentence', async () => {
    const view = await mount(<SetupDiagram step="install" />);

    // Otherwise the picture is announced twice: once as a sentence and once as
    // six disconnected fragments.
    for (const child of figureOf(view.container).children) {
      expect(child.getAttribute('aria-hidden')).toBe('true');
    }
    await view.unmount();
  });

  it('shows an unjoined link as dashed, not merely as a different colour', async () => {
    const unpaired = await mount(<SetupDiagram step="pair" />);
    const linkOf = (container: HTMLElement): string =>
      must(container.querySelector('span[class*="border-t"]'), 'the link').className;

    expect(linkOf(unpaired.container)).toContain('border-dashed');
    await unpaired.unmount();

    const paired = await mount(<SetupDiagram step="done" />);
    expect(linkOf(paired.container)).toContain('border-solid');
    // …and it gains a tick, so the join is a shape too.
    expect(paired.container.querySelector('svg.lucide-check')).not.toBeNull();
    await paired.unmount();
  });

  it('makes the computer-to-browser hand-off visible', async () => {
    const lit = async (step: OnboardingStepId): Promise<readonly boolean[]> => {
      const view = await mount(<SetupDiagram step={step} />);
      // The two ENDS, by their own glyphs: a joined link draws a tick of its own,
      // so "has an svg" would count the line between them as a third node.
      const nodes = [...figureOf(view.container).children].filter(
        child => child.querySelector('svg.lucide-laptop, svg.lucide-smartphone') !== null,
      );
      const result = nodes.map(node => node.className.includes('border-accent'));
      await view.unmount();
      return result;
    };

    // Install is work on the machine alone; the browser is not doing anything.
    expect(await lit('install')).toEqual([true, false]);
    // The same-machine collapse lights BOTH ends: they are one machine.
    expect(await lit('local')).toEqual([true, true]);
    // The machine that will run the agents is elsewhere and has nothing on it yet,
    // so that end is not lit at all — on a phone or on a second computer.
    expect(await lit('elsewhere')).toEqual([false, true]);
    // `fy pair` is on the computer; scanning is the first time both devices act.
    expect(await lit('pair')).toEqual([true, false]);
    expect(await lit('scan')).toEqual([true, true]);
  });
});
