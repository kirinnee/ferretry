/**
 * The one prompt that asks for the operator password, tested against a REAL document.
 *
 * A modal's contract is made of document facts — Escape, the focus trap, what the scrim does — so a
 * shallow tree would assert its shape and none of its behaviour. The two panels that raise it (the fleet
 * cockpit and the grants surface) prove the flow through it in their own suites; this proves the prompt.
 */

import { describe, expect, it } from 'bun:test';
import { OperatorUnlockDialog } from '../../../../src/features/settings/operator-unlock-dialog.tsx';
import { UNLOCK_HOLDING_NOTE, UNLOCK_LIMIT_NOTE } from '../../../../src/lib/grants.ts';
import { interact, mount, must } from '../../../support/dom.ts';

const PURPOSE = 'Changing the agent fleet needs the operator password for this machine, typed once to unlock it.';

const open = async (
  overrides: {
    readonly open?: boolean;
    readonly holding?: boolean;
    readonly busy?: boolean;
    readonly failure?: { readonly message: string; readonly retryable: boolean } | null;
  } = {},
) => {
  const calls = { submitted: [] as string[], closed: 0 };
  const mounted = await mount(
    <OperatorUnlockDialog
      open={overrides.open ?? true}
      purpose={PURPOSE}
      holding={overrides.holding ?? true}
      busy={overrides.busy ?? false}
      failure={overrides.failure ?? null}
      submitLabel="Unlock"
      onSubmit={password => calls.submitted.push(password)}
      onClose={() => {
        calls.closed += 1;
      }}
    />,
  );
  return { ...mounted, calls };
};

const field = (container: HTMLElement): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>('[data-grant-unlock-field]'), 'the password field');

const type = async (node: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const named = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text)),
    `the "${text}" button`,
  );

describe('the operator unlock prompt', () => {
  it('renders nothing at all while it is closed', async () => {
    const dialog = await open({ open: false });
    expect(dialog.container.querySelector('[role="dialog"]')).toBeNull();
    expect(dialog.container.querySelector('input')).toBeNull();
    await dialog.unmount();
  });

  /**
   * The whole point of the change: it says it unlocks CHANGING SETTINGS on this machine, with the scope
   * and the lifetime, rather than claiming to authorise one action.
   */
  it('says what it unlocks, for how long, and who holds it', async () => {
    const dialog = await open();
    const panel = must(dialog.container.querySelector('[role="dialog"]'), 'the dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('data-operator-unlock-dialog')).toBe('unlock');
    expect(panel.textContent).toContain('Unlock settings on this machine');
    // The caller's own sentence, unchanged: two vocabularies already own this and a third would drift.
    expect(must(dialog.container.querySelector('[data-operator-unlock-purpose]'), 'the purpose').textContent).toBe(
      PURPOSE,
    );
    expect(must(dialog.container.querySelector('[data-operator-unlock-holding]'), 'the scope').textContent).toBe(
      UNLOCK_HOLDING_NOTE,
    );
    // The limiter, before a try is spent.
    expect(panel.textContent).toContain(UNLOCK_LIMIT_NOTE);
    // A name for the dialog rather than a bare div, and the container is what focus lands on.
    expect(panel.getAttribute('aria-labelledby')).not.toBeNull();
    await dialog.unmount();
  });

  /**
   * A per-change confirmation MINTS NOTHING. Promising five ungoverned minutes there would be false in
   * the dangerous direction: it would tell somebody a window is open when none is.
   */
  it('promises no window at all when the password is a per-change confirmation', async () => {
    const dialog = await open({ holding: false });
    const panel = must(dialog.container.querySelector('[role="dialog"]'), 'the dialog');
    expect(panel.getAttribute('data-operator-unlock-dialog')).toBe('confirm');
    expect(panel.textContent).toContain('Confirm with the operator password');
    expect(dialog.container.querySelector('[data-operator-unlock-holding]')).toBeNull();
    expect(panel.textContent).not.toContain(UNLOCK_HOLDING_NOTE);
    await dialog.unmount();
  });

  it('hands the typed value over once and clears the field', async () => {
    const dialog = await open();
    // Nothing to submit yet, and the control says so rather than failing silently on press.
    expect(named(dialog.container, 'Unlock').hasAttribute('disabled')).toBe(true);

    await type(field(dialog.container), 'correct horse battery');
    await interact(() => named(dialog.container, 'Unlock').click());
    expect(dialog.calls.submitted).toEqual(['correct horse battery']);
    // Cleared by the submit: a wrong password is retyped, and the last attempt must not sit in a field
    // while somebody walks away from the screen.
    expect(field(dialog.container).value).toBe('');
    await dialog.unmount();
  });

  it('sends nothing on an empty field and nothing while something is in flight', async () => {
    const empty = await open();
    await interact(() =>
      must(empty.container.querySelector('form'), 'the form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(empty.calls.submitted).toEqual([]);
    await empty.unmount();

    const busy = await open({ busy: true });
    await type(field(busy.container), 'correct horse battery');
    await interact(() =>
      must(busy.container.querySelector('form'), 'the form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(busy.calls.submitted).toEqual([]);
    expect(field(busy.container).hasAttribute('disabled')).toBe(true);
    expect(busy.container.textContent).toContain('Working…');
    await busy.unmount();
  });

  it('reports a wrong password where it was typed, and says when the daemon has stopped checking', async () => {
    const retryable = await open({
      failure: { message: 'that is not this machine’s operator password; 4 attempts remaining', retryable: true },
    });
    const alert = must(retryable.container.querySelector('[data-grant-unlock-failure]'), 'the failure');
    expect(alert.getAttribute('data-grant-unlock-failure')).toBe('retryable');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('4 attempts remaining');
    // It REPLACES the limit note rather than stacking a second sentence under it.
    expect(retryable.container.textContent).not.toContain(UNLOCK_LIMIT_NOTE);
    await retryable.unmount();

    const final = await open({ failure: { message: 'this daemon has stopped checking', retryable: false } });
    expect(
      must(final.container.querySelector('[data-grant-unlock-failure]'), 'the failure').getAttribute(
        'data-grant-unlock-failure',
      ),
    ).toBe('final');
    await final.unmount();
  });

  /** Three ways out, because a modal a keyboard cannot leave is worse than no modal. */
  it('closes on Cancel, on the scrim and on Escape, and takes the typed value with it', async () => {
    const cancelled = await open();
    await type(field(cancelled.container), 'half typed');
    await interact(() => named(cancelled.container, 'Cancel').click());
    expect(cancelled.calls.closed).toBe(1);
    expect(cancelled.calls.submitted).toEqual([]);
    // The value is gone rather than waiting behind a closed prompt.
    expect(field(cancelled.container).value).toBe('');
    await cancelled.unmount();

    const scrim = await open();
    await interact(() =>
      must(
        scrim.container.querySelector<HTMLElement>('[aria-label="Cancel the operator password"]'),
        'the scrim',
      ).click(),
    );
    expect(scrim.calls.closed).toBe(1);
    await scrim.unmount();

    const escaped = await open();
    await interact(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(escaped.calls.closed).toBe(1);
    await escaped.unmount();
  });

  /**
   * A dismissal is refused while a request is in flight, for the reason every other panel here refuses
   * one: the attempt is already spent, and hiding the prompt would hide the answer to it.
   */
  it('cannot be dismissed while the password is being checked', async () => {
    const busy = await open({ busy: true });
    await interact(() => named(busy.container, 'Cancel').click());
    await interact(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(busy.calls.closed).toBe(0);
    await busy.unmount();
  });

  it('keeps Tab inside itself, because it claims the rest of the page is unreachable', async () => {
    const dialog = await open();
    const panel = must(dialog.container.querySelector<HTMLElement>('[role="dialog"]'), 'the dialog');
    // The trap is an `onKeyDown` on the dialog itself rather than a document listener, so it applies only
    // while focus is genuinely inside. Pressing Tab from the container wraps to the last control.
    await interact(() =>
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })),
    );
    expect(dialog.container.contains(document.activeElement)).toBe(true);
    await dialog.unmount();
  });
});
