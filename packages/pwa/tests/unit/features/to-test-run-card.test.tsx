import { afterEach, describe, expect, it } from 'bun:test';
import type { ToTestAnswers } from '../../../src/features/agenda/to-test-rows.tsx';
import { ToTestStep } from '../../../src/features/agenda/to-test-step.tsx';
import type { ToTestCard } from '../../../src/lib/to-test-inbox.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const rowOf = (title: string, taskName: string | null): ToTestCard =>
  ({
    key: 'to-test:F1',
    card: { key: 'F1', daemonId: 'd1', machine: 'Liftoff EC2', task: { id: 'F1', title, shippedIn: null } },
    group: {},
    doneLaneId: 'closed',
    notGoodLaneId: 'implement',
    howToTest: '1. Try it\n2. Press Done',
    taskName,
    since: null,
    snoozedUntil: null,
  }) as unknown as ToTestCard;

const answers: ToTestAnswers = {
  answerFor: () => ({ pressed: null, error: null }) as never,
  done: () => undefined,
  notGood: () => undefined,
  snooze: () => undefined,
};

const mountStep = async (row: ToTestCard, onNext: () => void = () => undefined): Promise<HTMLElement> => {
  view = await mount(
    <ToTestStep
      answers={answers}
      index={0}
      now={undefined}
      onNavigate={() => undefined}
      onNext={onNext}
      onPrevious={undefined}
      row={row}
      total={2}
    />,
  );
  return view.container;
};

const pointer = (type: string, y: number): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: y,
    pointerId: 4,
    pointerType: 'touch',
  });

describe('the quick-answer run — the card to test', () => {
  it('prints the title once when the ferret task has the same name', async () => {
    const root = await mountStep(rowOf('Secret card program check', 'Secret Card Program Check'));
    expect(root.querySelector('[data-to-test-ferret]')).toBeNull();
    expect(root.textContent?.toLowerCase().split('secret card program check').length).toBe(2);
  });

  it('still names the ferret task when it differs from the title', async () => {
    const root = await mountStep(rowOf('Try the board', 'Credentials Build Lead'));
    expect(root.querySelector('[data-to-test-ferret]')?.textContent).toBe('Credentials Build Lead');
  });

  it('skips on a swipe down that starts on the title link, which is most of the head', async () => {
    const skipped: string[] = [];
    const root = await mountStep(rowOf('Try the board', null), () => skipped.push('next'));
    const title = must(root.querySelector<HTMLElement>('[data-to-test-title]'), 'title link');
    await interact(() => title.dispatchEvent(pointer('pointerdown', 300)));
    await interact(() => title.dispatchEvent(pointer('pointermove', 340)));
    await interact(() => title.dispatchEvent(pointer('pointermove', 600)));
    await interact(() => title.dispatchEvent(pointer('pointerup', 600)));
    expect(skipped).toEqual(['next']);
  });

  it('does not skip on a swipe down that starts in the steps: that is the card scrolling', async () => {
    const skipped: string[] = [];
    const root = await mountStep(rowOf('Try the board', null), () => skipped.push('next'));
    const how = must(root.querySelector<HTMLElement>('[data-to-test-how]'), 'steps');
    await interact(() => how.dispatchEvent(pointer('pointerdown', 300)));
    await interact(() => how.dispatchEvent(pointer('pointermove', 340)));
    await interact(() => how.dispatchEvent(pointer('pointermove', 600)));
    await interact(() => how.dispatchEvent(pointer('pointerup', 600)));
    expect(skipped).toEqual([]);
  });
});
