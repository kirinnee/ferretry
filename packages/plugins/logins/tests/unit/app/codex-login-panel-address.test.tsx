/**
 * The one field Codex's link sign-in has: the address the browser ends on, which carries an authorization code. It is
 * an uncontrolled secret textarea, so these run against a real DOM (the renderer-tree suite has no nodes to read).
 */
import { describe, expect, it } from 'bun:test';
import { CodexLoginPanel } from '../../../app/features/codex-login-panel.tsx';
import { interact, mount, must } from '../support/dom.ts';
import { codexFlow } from './support/harness-login.ts';

/** A made-up address: no real authorization code is ever typed in a test. */
const ADDRESS = 'http://localhost:1455/auth/callback?code=code-TESTONLY&state=fixture';

const WORDING = { coverage: 'Every runtime that uses it can launch once it is done.', signedIn: 'Signed in.' };

const panel = (overrides: Partial<Parameters<typeof CodexLoginPanel>[0]> = {}) => (
  <CodexLoginPanel
    accountLabel="Studio Codex"
    loginId="codex-studio"
    wording={WORDING}
    flow={codexFlow('awaiting-callback')}
    busy={false}
    refusal={null}
    onStart={() => undefined}
    onCancel={() => undefined}
    onUseLink={() => undefined}
    onStartLink={() => undefined}
    onStartDeviceCode={() => undefined}
    onSubmitAddress={() => undefined}
    linked={true}
    copy={async () => {}}
    {...overrides}
  />
);

const areaIn = (container: HTMLElement): HTMLTextAreaElement =>
  must(container.querySelector('textarea'), 'the address box');

const typeAddress = async (area: HTMLTextAreaElement, text: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const submit = async (container: HTMLElement): Promise<void> => {
  await interact(() =>
    must(container.querySelector('form'), 'the form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
};

describe('the Codex address box', () => {
  it('never holds the address in the markup while it is typed, and has no name a native submit could send', async () => {
    const view = await mount(panel());
    const area = areaIn(view.container);
    await typeAddress(area, ADDRESS);
    expect(area.value).toBe(ADDRESS);
    expect(area.textContent).toBe('');
    expect(area.hasAttribute('name')).toBe(false);
    expect(view.container.innerHTML).not.toContain('code-TESTONLY');
    await view.unmount();
  });

  it('hands the typed address over, empties the box, and never sends a blank one', async () => {
    const sent: string[] = [];
    const view = await mount(panel({ onSubmitAddress: address => sent.push(address) }));
    const area = areaIn(view.container);
    await submit(view.container);
    expect(sent).toEqual([]);
    await typeAddress(area, ADDRESS);
    await submit(view.container);
    expect(sent).toEqual([ADDRESS]);
    expect(area.value).toBe('');
    expect(view.container.innerHTML).not.toContain('code-TESTONLY');
    await view.unmount();
  });

  it('keeps the button off for spaces only, and refuses to send while busy, showing the finish label it was given', async () => {
    const sent: string[] = [];
    const onSubmitAddress = (address: string): void => void sent.push(address);
    const view = await mount(panel({ onSubmitAddress, wording: { ...WORDING, finishLabel: 'Finish and launch' } }));
    const button = must(
      [...view.container.querySelectorAll('button')].find(item => item.textContent?.includes('Finish and launch')) ??
        null,
      'the finish button',
    );
    expect(button.disabled).toBe(true);
    await typeAddress(areaIn(view.container), '   ');
    expect(button.disabled).toBe(true);
    await typeAddress(areaIn(view.container), ADDRESS);
    expect(button.disabled).toBe(false);
    await view.render(
      panel({ onSubmitAddress, busy: true, wording: { ...WORDING, finishLabel: 'Finish and launch' } }),
    );
    await submit(view.container);
    expect(sent).toEqual([]);
    expect(view.container.textContent).toContain('Sending…');
    await view.unmount();
  });

  it('empties the box when the sign-in moves on and the box leaves the screen', async () => {
    const view = await mount(panel());
    const area = areaIn(view.container);
    await typeAddress(area, ADDRESS);
    await view.render(panel({ flow: codexFlow('finishing') }));
    expect(view.container.querySelector('textarea')).toBeNull();
    expect(area.value).toBe('');
    await view.unmount();
  });
});
