/**
 * The Settings form kit: the Save bar says what state its form is in (and is drawn from the first paint), Save is off until something
 * changed and while the form cannot be saved, a failure replaces the state words, a field's error takes the place of its help, and a
 * group says WHEN it saves.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { SettingField, SettingSaveBar } from '../../../src/compose/setting-form.tsx';
import { SettingGroup, SettingRow } from '../../../src/compose/setting-row.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const bar = (container: HTMLElement): HTMLElement => must(container.querySelector('[data-setting-savebar]'), 'the bar');
const button = (container: HTMLElement, name: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent === name),
    `the ${name} button`,
  );
const noop = () => undefined;

describe('SettingSaveBar', () => {
  it('is drawn clean from the first paint, with Save and Discard off', async () => {
    mounted = await mount(<SettingSaveBar dirty={false} onSave={noop} onDiscard={noop} />);
    expect(bar(mounted.container).getAttribute('data-state')).toBe('clean');
    expect(mounted.container.textContent).toContain('Nothing to save');
    expect(button(mounted.container, 'Save').disabled).toBe(true);
    expect(button(mounted.container, 'Discard changes').disabled).toBe(true);
  });

  it('says unsaved, turns Save on, and sends Save and Discard presses once each', async () => {
    let saves = 0;
    let discards = 0;
    mounted = await mount(
      <SettingSaveBar dirty onSave={() => (saves += 1)} onDiscard={() => (discards += 1)} saveLabel="Save budget" />,
    );
    expect(bar(mounted.container).getAttribute('data-state')).toBe('dirty');
    expect(mounted.container.textContent).toContain('Unsaved changes');
    await interact(() => button(mounted?.container as HTMLElement, 'Save budget').click());
    await interact(() => button(mounted?.container as HTMLElement, 'Discard changes').click());
    expect([saves, discards]).toEqual([1, 1]);
  });

  it('keeps Save off for a form that cannot be saved as typed, while Discard stays on', async () => {
    mounted = await mount(<SettingSaveBar dirty blocked onSave={noop} onDiscard={noop} />);
    expect(button(mounted.container, 'Save').disabled).toBe(true);
    expect(button(mounted.container, 'Discard changes').disabled).toBe(false);
  });

  it('says saving and cannot be pressed twice', async () => {
    mounted = await mount(<SettingSaveBar dirty saving onSave={noop} onDiscard={noop} />);
    expect(bar(mounted.container).getAttribute('data-state')).toBe('saving');
    expect(button(mounted.container, 'Saving…').disabled).toBe(true);
    expect(button(mounted.container, 'Discard changes').disabled).toBe(true);
  });

  it('says saved (in the page’s own words) once the form is clean again', async () => {
    mounted = await mount(<SettingSaveBar dirty={false} saved savedWords="In effect" onSave={noop} onDiscard={noop} />);
    expect(bar(mounted.container).getAttribute('data-state')).toBe('saved');
    expect(mounted.container.textContent).toContain('In effect');
  });

  it('puts the sentence that says why it did not save in place of the state words, as an alert', async () => {
    mounted = await mount(<SettingSaveBar dirty error="The machine refused it." onSave={noop} onDiscard={noop} />);
    expect(bar(mounted.container).getAttribute('data-state')).toBe('failed');
    expect(mounted.container.textContent).not.toContain('Unsaved changes');
    expect(must(mounted.container.querySelector('[role=alert]'), 'the alert').textContent).toBe(
      'The machine refused it.',
    );
  });
});

describe('SettingField', () => {
  it('labels the control and describes it by its help', async () => {
    mounted = await mount(
      <SettingField label="Trigger" help="Dollars per day.">
        {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} />}
      </SettingField>,
    );
    const input = must(mounted.container.querySelector('input'), 'the input');
    expect(must(mounted.container.querySelector('label'), 'label').getAttribute('for')).toBe(input.id);
    const note = must(mounted.container.querySelector('[data-setting-field-note]'), 'the note');
    expect(note.getAttribute('data-setting-field-note')).toBe('help');
    expect(input.getAttribute('aria-describedby')).toBe(note.id);
  });

  it('shows the error IN PLACE of the help, never both', async () => {
    mounted = await mount(
      <SettingField label="Trigger" help="Dollars per day." error="Use a number above 0.">
        {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} />}
      </SettingField>,
    );
    expect(mounted.container.textContent).toContain('Use a number above 0.');
    expect(mounted.container.textContent).not.toContain('Dollars per day.');
    expect(mounted.container.querySelectorAll('[data-setting-field-note]').length).toBe(1);
  });
});

describe('SettingGroup saves', () => {
  it('says WHEN the group saves under its heading, and draws its foot inside the group', async () => {
    mounted = await mount(
      <div>
        <SettingGroup label="Prompts" saves="now">
          <SettingRow name="Ask" />
        </SettingGroup>
        <SettingGroup label="Limits" saves="on-save" foot={<span data-foot="">foot</span>}>
          <SettingRow name="Size" />
        </SettingGroup>
      </div>,
    );
    const now = must(mounted.container.querySelector('[data-setting-saves="now"]'), 'the now group');
    expect(now.querySelector('[data-setting-saves-note]')?.textContent).toBe('Changes apply as soon as you make them.');
    const form = must(mounted.container.querySelector('[data-setting-saves="on-save"]'), 'the form group');
    expect(form.querySelector('[data-setting-saves-note]')?.textContent).toBe('Changes apply when you press Save.');
    expect(form.querySelector('[data-foot]')).not.toBeNull();
  });

  it('draws nothing about saving for a group that does not say', async () => {
    mounted = await mount(
      <SettingGroup label="Plain">
        <SettingRow name="Size" />
      </SettingGroup>,
    );
    expect(mounted.container.querySelector('[data-setting-saves-note]')).toBeNull();
  });
});
