import { describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { useBackDismiss } from '../../src/hooks/use-back-dismiss.ts';
import { interact, mount } from '../support/dom.ts';
import { settleUntil } from '../support/settle.ts';

function Host({ onDismiss }: { readonly onDismiss: () => void }) {
  const [open, setOpen] = useState(true);
  useBackDismiss(open, () => {
    setOpen(false);
    onDismiss();
  });
  return (
    <button type="button" data-host="" onClick={() => setOpen(value => !value)}>
      {open ? 'open' : 'closed'}
    </button>
  );
}

describe('useBackDismiss', () => {
  it('dismisses on the platform Back and leaves the address where it was', async () => {
    // Arrange
    const before = window.location.href;
    let dismissed = 0;
    const view = await mount(<Host onDismiss={() => (dismissed += 1)} />);

    // Act
    await interact(() => window.history.back());
    await settleUntil(() => dismissed === 1, 'Back to dismiss', interact);

    // Assert
    expect(dismissed).toBe(1);
    expect(window.location.href).toBe(before);
    await view.unmount();
  });

  it('does not undo a navigation made while it was active when it goes away', async () => {
    // Arrange
    const view = await mount(<Host onDismiss={() => undefined} />);
    window.history.pushState({}, '', '/elsewhere');
    const landed = window.location.pathname;

    // Act — the page moved on; closing now must not step back off the new page.
    await interact(() => view.container.querySelector<HTMLButtonElement>('[data-host]')?.click());
    await interact(async () => {
      await Promise.resolve();
    });

    // Assert
    expect(window.location.pathname).toBe(landed);
    await view.unmount();
    window.history.replaceState({}, '', '/');
  });
});
