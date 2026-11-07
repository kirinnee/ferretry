import { afterEach, describe, expect, it } from 'bun:test';
import { AccountSlot, type RenderAccountSlot } from '../../../../app/features/move/account-slot.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { chosenAccount, emptySlot, fakeSlot } from './slot.tsx';

let live: Mounted | undefined;
afterEach(async () => {
  await live?.unmount();
  live = undefined;
});

const field = (over: Partial<Parameters<typeof AccountSlot>[0]['field']> = {}) => ({
  harness: 'codex' as const,
  value: '',
  onValueChange: () => undefined,
  onChosen: () => undefined,
  fallbackId: 'wrapper',
  labelId: 'label',
  fallbackPlaceholder: 'codex-default',
  noAccounts: null,
  ...over,
});

describe('AccountSlot', () => {
  it('draws only what the contributing panel draws', async () => {
    live = await mount(
      <AccountSlot fallbackLabel="Wrapper" field={field()} render={fakeSlot([chosenAccount('codex-a', 'codex')])} />,
    );
    expect(live.container.querySelector('[data-account="codex-a"]')).not.toBeNull();
    expect(live.container.querySelector('input')).toBeNull();
  });

  it('falls back to a typed wrapper when nobody contributed a panel, and reports what is typed', async () => {
    const typed: string[] = [];
    live = await mount(
      <AccountSlot
        fallbackLabel="Wrapper"
        field={field({ onValueChange: next => typed.push(next) })}
        render={emptySlot}
      />,
    );
    const input = must(live.container.querySelector<HTMLInputElement>('input#wrapper'), 'typed wrapper');
    expect(input.getAttribute('aria-label')).toBe('Wrapper');
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'codex-z');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(typed).toEqual(['codex-z']);
  });

  it('falls back to a typed wrapper when the slot only holds the shell line saying its plugin cannot draw', async () => {
    const blocked: RenderAccountSlot = () => (
      <div className="fy-slot" data-slot="ferrets.move-account">
        <div className="fy-panel" data-panel="runtimes.move-account">
          <p className="fy-shell-line fy-shell-line--muted" role="status">
            Runtimes is paused on this daemon.
          </p>
        </div>
      </div>
    );
    live = await mount(<AccountSlot fallbackLabel="Wrapper" field={field()} render={blocked} />);
    expect(live.container.querySelector('.fy-shell-line')).not.toBeNull();
    expect(live.container.querySelector('input#wrapper')).not.toBeNull();
  });
});
