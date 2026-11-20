/**
 * The first-run Lessons page against a fake daemon and a recording `StepHost` (r11 O8): what it tells the shell (`ready`,
 * `commit`), what Next writes (`passiveDefault`, once), and that the page itself writes nothing and draws no button.
 */
import { describe, expect, it } from 'bun:test';
import { recordingHost as stepHarness } from '../../../../support/app/step-host.ts';
import { LessonsStep } from '../../../../../app/features/onboarding/lessons-step.tsx';
import { lessonsStepPanel } from '../../../../../app/features/onboarding/step-panel.tsx';
import { click, textOf, waitFor, waitForText } from '../../../../support/app/dom-helpers.ts';
import { mount, must } from '../../../../support/app/dom.ts';
import { fakeLessonsDaemon } from '../../../../support/app/lessons.ts';

const card = (root: ParentNode, id: string): HTMLElement =>
  must(root.querySelector<HTMLElement>(`[data-choice="${id}"]`), `${id} card`);
const patches = (daemon: ReturnType<typeof fakeLessonsDaemon>) =>
  daemon.calls.filter(call => call.route === 'PATCH /v1/lessons/config').map(call => call.body);
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('first-run › Lessons step', () => {
  it('reads the machine setting, then shows two stacked cards with neither chosen and lifts the cover once', async () => {
    const daemon = fakeLessonsDaemon();
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'the page lifts its cover');
    // The shell's frame owns the title and the footer; the page draws neither, and no button of its own.
    expect(view.container.querySelector('h1, h2, h3, header, footer, [data-step-page], [data-step-footer]')).toBeNull();
    expect(view.container.querySelector('button')).toBeNull();
    expect(view.container.querySelector('[data-choice-cards]')?.getAttribute('data-layout')).toBe('stack');
    expect(view.container.querySelectorAll('[data-choice]').length).toBe(2);
    expect(view.container.querySelectorAll('[data-selected="true"]').length).toBe(0);
    expect(harness.count('ready')).toBe(1);
    expect(harness.count('done')).toBe(0);
    expect(harness.hasCommit).toBe(false);
    expect(patches(daemon)).toEqual([]);
    await view.unmount();
  });

  it('says one line and no tool names: the words stay short and never mention bun', async () => {
    const daemon = fakeLessonsDaemon();
    const view = await mount(<LessonsStep connection={daemon.connection} />);
    await waitFor(() => view.container.querySelectorAll('[data-choice]').length === 2, 'cards');
    const text = textOf(view.container);
    expect(text).toContain('Rules are kept in Lessons, where you read each one before it is used.');
    expect(text.toLowerCase()).not.toContain('bun');
    // The page's words (the demo column is drawn apart, by the frame) stay under 160 characters.
    const words = [...view.container.querySelectorAll('.fy-lessons-step-line, .fy-cc__title, .fy-cc__line')]
      .map(node => node.textContent ?? '')
      .join(' ');
    expect(words.length).toBeLessThanOrEqual(160);
    await view.unmount();
  });

  it('a pick only registers the save: nothing is written, busy, or answered until Next runs it', async () => {
    const daemon = fakeLessonsDaemon();
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'ready');
    await click(card(view.container, 'off'));
    await waitFor(() => card(view.container, 'off').dataset.selected === 'true', 'selected');
    expect(harness.hasCommit).toBe(true);
    expect(patches(daemon)).toEqual([]);
    expect(harness.count('busy')).toBe(0);
    expect(harness.count('done')).toBe(0);
    // Next: exactly one write, of the card on screen.
    await harness.runCommit();
    expect(patches(daemon)).toEqual([{ passiveDefault: false }]);
    await view.unmount();
  });

  it('changing the pick replaces the registered save: Next writes the last card, once', async () => {
    const daemon = fakeLessonsDaemon();
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'ready');
    await click(card(view.container, 'off'));
    await click(card(view.container, 'on'));
    await waitFor(() => card(view.container, 'on').dataset.selected === 'true', 'on selected');
    await harness.runCommit();
    expect(patches(daemon)).toEqual([{ passiveDefault: true }]);
    await view.unmount();
  });

  it('the picture follows the card: a rule is filed for Learn and nothing for Don’t learn', async () => {
    const daemon = fakeLessonsDaemon();
    const view = await mount(<LessonsStep connection={daemon.connection} />);
    await waitFor(() => view.container.querySelectorAll('[data-choice]').length === 2, 'cards');
    // Outside a frame the demo draws inline; at rest it shows the filed rule.
    expect(view.container.querySelector('[data-lessons-demo]')?.getAttribute('data-kept')).toBe('true');
    await click(card(view.container, 'off'));
    await waitFor(
      () => view.container.querySelector('[data-lessons-demo]')?.getAttribute('data-kept') === 'false',
      'off',
    );
    expect(view.container.querySelector('[data-lessons-rule]')).toBeNull();
    await view.unmount();
  });

  it('a refused save rejects with the daemon’s sentence, so the shell can show it and Next can try again', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.once('PATCH /v1/lessons/config', {
      refuse: { status: 403, code: 'grant_refused', message: 'fleet.configure is closed' },
    });
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'ready');
    await click(card(view.container, 'on'));
    await waitFor(() => harness.hasCommit, 'registered');
    let message = '';
    await harness.runCommit().catch((reason: unknown) => {
      message = reason instanceof Error ? reason.message : String(reason);
    });
    expect(message).toContain('fleet.configure is closed');
    // The pick stays, and the same Next runs the save again.
    expect(card(view.container, 'on').dataset.selected).toBe('true');
    await harness.runCommit();
    expect(patches(daemon)).toEqual([{ passiveDefault: true }, { passiveDefault: true }]);
    await view.unmount();
  });

  it('says why it cannot read the setting, lifts the cover anyway, and reads again on Try again', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.once('GET /v1/lessons/config', {
      refuse: { status: 500, code: 'internal', message: 'lessons.yaml is invalid' },
    });
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitForText(view.container, 'lessons.yaml is invalid');
    expect(harness.decision).toBe('shown');
    expect(view.container.querySelectorAll('[data-choice]').length).toBe(0);
    const retry = must(view.container.querySelector<HTMLButtonElement>('.fy-lessons-step-retry'), 'retry');
    await click(retry);
    await waitFor(() => view.container.querySelectorAll('[data-choice]').length === 2, 'cards');
    expect(view.container.querySelector('[data-lessons-problem]')).toBeNull();
    expect(daemon.calls.filter(call => call.route === 'GET /v1/lessons/config').length).toBe(2);
    // The cover lifted when the read failed; a good retry does not lift it a second time.
    expect(harness.count('ready')).toBe(1);
    await view.unmount();
  });

  it('does not re-read the setting when the shell hands a new host object', async () => {
    const daemon = fakeLessonsDaemon();
    const first = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={first.host} />);
    await waitFor(() => first.decision === 'shown', 'ready');
    const second = stepHarness();
    await view.render(<LessonsStep connection={daemon.connection} step={second.host} />);
    await flush();
    expect(daemon.calls.filter(call => call.route === 'GET /v1/lessons/config').length).toBe(1);
    await view.unmount();
  });

  it('draws by itself, with no host', async () => {
    const daemon = fakeLessonsDaemon();
    const view = await mount(<LessonsStep connection={daemon.connection} />);
    await waitFor(() => view.container.querySelectorAll('[data-choice]').length === 2, 'cards');
    await click(card(view.container, 'off'));
    await waitFor(() => card(view.container, 'off').dataset.selected === 'true', 'selected');
    expect(patches(daemon)).toEqual([]);
    await view.unmount();
  });

  it('writes nothing to the browser’s storage (a daemon step is answered on the daemon)', async () => {
    const writes: string[] = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = (key: string) => {
      writes.push(key);
    };
    try {
      const daemon = fakeLessonsDaemon();
      const harness = stepHarness();
      const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
      await waitFor(() => harness.decision === 'shown', 'ready');
      await click(card(view.container, 'on'));
      await harness.runCommit();
      await view.unmount();
    } finally {
      Storage.prototype.setItem = original;
    }
    expect(writes).toEqual([]);
  });

  it('the panel hands the shell’s host to the page', async () => {
    const daemon = fakeLessonsDaemon();
    const harness = stepHarness();
    const Panel = lessonsStepPanel(daemon.connection);
    const view = await mount(<Panel subject="lessons.lessons" step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'ready');
    await view.unmount();
  });
});
