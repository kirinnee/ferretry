import { describe, expect, it } from 'bun:test';
import { Button } from '../../../src/ui/primitives.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const buttonOf = (container: HTMLElement): HTMLButtonElement => must(container.querySelector('button'), 'the button');

describe('Button busy (C59 O5 item 1: the loader never resizes a button)', () => {
  it('without the new props it is the plain button it always was', async () => {
    const view = await mount(<Button>Save</Button>);
    const button = buttonOf(view.container);
    expect(button.textContent).toBe('Save');
    expect(button.querySelector('.kt-btn__lead, .kt-btn__label')).toBeNull();
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect(button.disabled).toBe(false);
    await view.unmount();
  });

  it('busy puts the spinner in the icon slot (it replaces the icon), disables the button and marks it aria-busy', async () => {
    const view = await mount(
      <Button icon={<svg data-icon="" />} busy={false} busyLabel="Starting…">
        Start
      </Button>,
    );
    const button = buttonOf(view.container);
    expect(button.querySelector('[data-icon]')).not.toBeNull();
    expect(button.querySelector('[data-spinner]')).toBeNull();
    expect(button.querySelectorAll('.kt-btn__lead')).toHaveLength(1);

    await view.render(
      <Button icon={<svg data-icon="" />} busy busyLabel="Starting…">
        Start
      </Button>,
    );
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(true);
    // One slot, one mark: the spinner took the icon's place, it was not added beside it.
    expect(button.querySelectorAll('.kt-btn__lead')).toHaveLength(1);
    expect(button.querySelector('[data-icon]')).toBeNull();
    expect(button.querySelectorAll('[data-spinner]')).toHaveLength(1);
    await view.unmount();
  });

  it('keeps the other label as an unseen ghost, so the width is the longer of the two and no text is said twice', async () => {
    const view = await mount(
      <Button icon={<svg />} busyLabel="Starting sign-in…">
        Sign in to Claude Code
      </Button>,
    );
    const label = (): HTMLElement => must(view.container.querySelector<HTMLElement>('.kt-btn__label'), 'the label');
    expect(label().textContent).toBe('Sign in to Claude Code');
    expect(label().getAttribute('data-ghost')).toBe('Starting sign-in…');
    await view.render(
      <Button icon={<svg />} busy busyLabel="Starting sign-in…">
        Sign in to Claude Code
      </Button>,
    );
    expect(label().textContent).toBe('Starting sign-in…');
    expect(label().getAttribute('data-ghost')).toBe('Sign in to Claude Code');
    await view.unmount();
  });

  it('a busy button cannot be pressed, and an idle one still can', async () => {
    let presses = 0;
    const view = await mount(
      <Button busy={false} onClick={() => (presses += 1)}>
        Go
      </Button>,
    );
    await interact(() => buttonOf(view.container).click());
    expect(presses).toBe(1);
    await view.render(
      <Button busy onClick={() => (presses += 1)}>
        Go
      </Button>,
    );
    await interact(() => buttonOf(view.container).click());
    expect(presses).toBe(1);
    await view.unmount();
  });
});
