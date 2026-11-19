/**
 * The first-run Lessons page against a fake daemon and the real `StepHarness`: what it tells the shell (`ready`, `busy`,
 * `done`) and what it writes (`passiveDefault`), including the refusals.
 */
import { describe, expect, it } from 'bun:test';
import { recordingHost as stepHarness } from '../../../../support/app/step-host.ts';
import { LessonsStep } from '../../../../../app/features/onboarding/lessons-step.tsx';
import { lessonsStepPanel } from '../../../../../app/features/onboarding/step-panel.tsx';
import { click, textOf, waitFor, waitForText } from '../../../../support/app/dom-helpers.ts';
import { mount, must } from '../../../../support/app/dom.ts';
import { config, fakeLessonsDaemon } from '../../../../support/app/lessons.ts';

const card = (root: ParentNode, id: string): HTMLElement =>
  must(root.querySelector<HTMLElement>(`[data-choice="${id}"]`), `${id} card`);
const patches = (daemon: ReturnType<typeof fakeLessonsDaemon>) =>
  daemon.calls.filter(call => call.route === 'PATCH /v1/lessons/config').map(call => call.body);
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('first-run › Lessons step', () => {
  it('reads the machine setting, then shows two cards with neither chosen and lifts the cover once', async () => {
    const daemon = fakeLessonsDaemon();
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'the page lifts its cover');
    // The shell's frame owns the title and the footer; the page draws neither.
    expect(view.container.querySelector('h1, h2, h3, header, footer, [data-step-page], [data-step-footer]')).toBeNull();
    expect(view.container.querySelector('button')).toBeNull();
    expect(view.container.querySelectorAll('[data-choice]').length).toBe(2);
    expect(view.container.querySelectorAll('[data-selected="true"]').length).toBe(0);
    expect(view.container.querySelector('[data-lessons-now]')?.textContent).toBe('Right now: on for new ferrets.');
    expect(harness.count('ready')).toBe(1);
    expect(harness.count('done')).toBe(0);
    expect(patches(daemon)).toEqual([]);
    await view.unmount();
  });

  it('writes Off, keeps Next busy while it saves, and answers the step', async () => {
    const daemon = fakeLessonsDaemon();
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'ready');
    await click(card(view.container, 'off'));
    await waitFor(() => harness.count('done') === 1, 'done');
    expect(patches(daemon)).toEqual([{ passiveDefault: false }]);
    expect(harness.calls.filter(call => call.kind === 'busy')).toEqual([
      { kind: 'busy', label: 'Saving…' },
      { kind: 'busy', label: null },
    ]);
    expect(card(view.container, 'off').dataset.selected).toBe('true');
    // The current-setting line is for before the answer; once answered the card says it.
    expect(view.container.querySelector('[data-lessons-now]')).toBeNull();
    await view.unmount();
  });

  it('writes On when the machine had it off', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.state.config = config({ passiveDefault: false });
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitForText(view.container, 'Right now: off for new ferrets.');
    await click(card(view.container, 'on'));
    await waitFor(() => harness.count('done') === 1, 'done');
    expect(patches(daemon)).toEqual([{ passiveDefault: true }]);
    await view.unmount();
  });

  it('says a refusal, puts the card back and does not answer the step', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.once('PATCH /v1/lessons/config', {
      refuse: { status: 403, code: 'grant_refused', message: 'fleet.configure is closed' },
    });
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'ready');
    await click(card(view.container, 'off'));
    await waitForText(view.container, 'fleet.configure is closed');
    expect(view.container.querySelectorAll('[data-selected="true"]').length).toBe(0);
    expect(harness.count('done')).toBe(0);
    expect(harness.calls.at(-1)).toEqual({ kind: 'busy', label: null });
    await view.unmount();
  });

  it('locks both cards while a save is pending, so one write is in flight and done follows the chosen card', async () => {
    const daemon = fakeLessonsDaemon();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    daemon.once('PATCH /v1/lessons/config', async () => {
      await gate;
      return { body: config({ passiveDefault: true }) };
    });
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'ready');
    await click(card(view.container, 'on'));
    await waitFor(() => patches(daemon).length === 1, 'the first write is sent');
    // Both cards are locked while it is in flight, and a tap on the other card does nothing.
    const radios = [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.length).toBe(2);
    expect(radios.every(radio => radio.disabled)).toBe(true);
    await click(card(view.container, 'off'));
    await flush();
    expect(patches(daemon)).toEqual([{ passiveDefault: true }]);
    expect(harness.count('done')).toBe(0);
    expect(card(view.container, 'on').dataset.selected).toBe('true');
    release();
    await waitFor(() => harness.count('done') === 1, 'done after the accepted write');
    await flush();
    expect(patches(daemon)).toEqual([{ passiveDefault: true }]);
    expect(card(view.container, 'on').dataset.selected).toBe('true');
    expect(daemon.state.config.passiveDefault).toBe(true);
    expect(harness.calls.at(-1)).toEqual({ kind: 'done' });
    expect(radios.every(radio => !radio.disabled)).toBe(true);
    await view.unmount();
  });

  it('keeps the step unanswered and unlocks the cards when a delayed save is refused', async () => {
    const daemon = fakeLessonsDaemon();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    daemon.once('PATCH /v1/lessons/config', async () => {
      await gate;
      return { refuse: { status: 403, code: 'grant_refused', message: 'fleet.configure is closed' } };
    });
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'ready');
    await click(card(view.container, 'on'));
    await waitFor(() => patches(daemon).length === 1, 'sent');
    release();
    await waitForText(view.container, 'fleet.configure is closed');
    expect(harness.count('done')).toBe(0);
    expect(view.container.querySelectorAll('[data-selected="true"]').length).toBe(0);
    // Free again: the person can answer the other way.
    await click(card(view.container, 'off'));
    await waitFor(() => harness.count('done') === 1, 'done');
    expect(patches(daemon)).toEqual([{ passiveDefault: true }, { passiveDefault: false }]);
    await view.unmount();
  });

  it('only promises what the setting does: automatic suggestions from new ferrets', async () => {
    const daemon = fakeLessonsDaemon();
    const view = await mount(<LessonsStep connection={daemon.connection} />);
    await waitFor(() => view.container.querySelectorAll('[data-choice]').length === 2, 'cards');
    const text = textOf(view.container);
    expect(text).toContain('New ferrets won’t suggest rules.');
    expect(text).toContain('No suggestion');
    expect(text).toContain('Rule suggested');
    expect(text).not.toContain('No rules are filed');
    expect(text).not.toContain('Nothing kept');
    await view.unmount();
  });

  it('names what waits for the owner when the write was held, and still answers', async () => {
    const daemon = fakeLessonsDaemon();
    daemon.once('PATCH /v1/lessons/config', {
      body: { ...config({ passiveDefault: true }), held: ['lesson mining may now spend on ferrets'] },
    });
    const harness = stepHarness();
    const view = await mount(<LessonsStep connection={daemon.connection} step={harness.host} />);
    await waitFor(() => harness.decision === 'shown', 'ready');
    await click(card(view.container, 'on'));
    await waitForText(view.container, 'Waiting for your approval: lesson mining may now spend on ferrets');
    expect(harness.count('done')).toBe(1);
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
      await waitFor(() => harness.count('done') === 1, 'done');
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
