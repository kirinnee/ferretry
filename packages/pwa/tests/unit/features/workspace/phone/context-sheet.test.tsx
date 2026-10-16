import { afterEach, describe, expect, it } from 'bun:test';
import { ContextSheet, ContextSheetButton } from '../../../../../src/features/workspace/phone/context-sheet.tsx';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe('ContextSheet', () => {
  it('renders nothing and calls no body while closed', async () => {
    let calls = 0;
    mounted = await mount(
      <ContextSheet
        open={false}
        onClose={() => {}}
        renderBody={() => {
          calls++;
          return <p>body</p>;
        }}
      />,
    );
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
    expect(calls).toBe(0);
  });

  it('opens as a dialog titled "This folder" around the render-prop body', async () => {
    let closed = 0;
    mounted = await mount(
      <ContextSheet open onClose={() => closed++} renderBody={() => <p data-body="">Signals</p>} />,
    );
    const dialog = must(mounted.container.querySelector('[role="dialog"]'), 'dialog');
    const heading = must(dialog.querySelector('h2'), 'heading');
    expect(heading.textContent).toBe('This folder');
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(dialog.querySelector('[data-context-sheet-body] [data-body]')?.textContent).toBe('Signals');
    await interact(() =>
      must(mounted?.container.querySelector<HTMLButtonElement>('button[aria-label="Close context"]'), 'close').click(),
    );
    expect(closed).toBe(1);
  });

  it('takes a different title', async () => {
    mounted = await mount(<ContextSheet open onClose={() => {}} renderBody={() => null} title="Context" />);
    expect(mounted.container.querySelector('h2')?.textContent).toBe('Context');
  });
});

describe('ContextSheetButton', () => {
  it('opens the sheet and says whether it is open', async () => {
    let opened = 0;
    mounted = await mount(<ContextSheetButton open={false} onOpen={() => opened++} />);
    const button = must(mounted.container.querySelector<HTMLButtonElement>('button'), 'button');
    expect(button.getAttribute('aria-label')).toBe('Open context');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await interact(() => button.click());
    expect(opened).toBe(1);
    await mounted.render(<ContextSheetButton open onOpen={() => {}} />);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});
