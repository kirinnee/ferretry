/**
 * Claude's own panel. This file is Claude's and only Claude's.
 *
 * There is no shared suite with `codex-login-panel.test.tsx` on purpose: the properties that matter here
 * — a paste field, a value cleared before the request settles — have no counterpart there, and one
 * parameterised suite over both would be evidence about a shape rather than about either sign-in.
 *
 * It runs against a real DOM: the code field is the app's secret input (uncontrolled: the value lives in the node, never in
 * React state), and C59 O5's rules (a cut-short link, a masked one-line field, a button that works, a message that shakes) are
 * facts about nodes.
 */
import { describe, expect, it } from 'bun:test';
import type { ClaudeLoginFlow } from '../../../contract/index.ts';
import { ClaudeLoginPanel } from '../../../app/features/claude-login-panel.tsx';
import { LONG_LINK, SignInLink } from '../../../app/features/sign-in-restart.tsx';
import { interact, mount as mountDom, must } from '../support/dom.ts';
import { CLAUDE_URL, claudeFlow } from './support/harness-login.ts';

type FailedClaudeFlow = Extract<ClaudeLoginFlow, { state: 'failed' }>;

const WORDING = {
  coverage: 'Every runtime that uses it can launch once it is done.',
  signedIn: 'Signed in. 3 runtimes can launch now.',
  finishLabel: 'Finish sign-in for 3 runtimes',
};

const panelWith = (overrides: Partial<Parameters<typeof ClaudeLoginPanel>[0]> = {}) => (
  <ClaudeLoginPanel
    accountLabel="Studio Claude"
    loginId="claude-studio"
    wording={WORDING}
    flow={null}
    busy={false}
    refusal={null}
    onStart={() => undefined}
    onSubmitCode={() => undefined}
    onCancel={() => undefined}
    copy={async () => {}}
    {...overrides}
  />
);

const mount = (overrides: Partial<Parameters<typeof ClaudeLoginPanel>[0]> = {}) => mountDom(panelWith(overrides));

const text = (container: HTMLElement): string => container.textContent ?? '';
const buttons = (container: HTMLElement): HTMLButtonElement[] => [...container.querySelectorAll('button')];
const codeField = (container: HTMLElement): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>('input[type="password"]'), 'the code field');
const typeCode = async (field: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const submit = async (container: HTMLElement): Promise<void> => {
  await interact(() =>
    must(container.querySelector('form'), 'the form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
};
/** A button inside a disabled fieldset is disabled too, which happy-dom's `.disabled` does not say. */
const disabled = (button: HTMLButtonElement): boolean =>
  button.disabled || button.closest('fieldset[disabled]') !== null;

describe('ClaudeLoginPanel', () => {
  it('offers a sign-in and says what one sign-in covers', async () => {
    const view = await mount();

    expect(view.container.querySelector('[data-claude-login="idle"]')).not.toBeNull();
    expect(text(view.container)).toContain(WORDING.coverage);
    expect(text(view.container)).toContain('Sign in to Claude Code');
    await view.unmount();
  });

  it('shows no identity line and no sibling copy', async () => {
    const view = await mount();

    expect(text(view.container)).not.toContain('Identity');
    expect(text(view.container)).not.toContain('sibling');
    expect(view.container.querySelectorAll('code')).toHaveLength(0);
    await view.unmount();
  });

  it('publishes the link with its PKCE query intact, and asks for a CODE rather than a URL', async () => {
    const view = await mount({ flow: claudeFlow('awaiting-code') });

    expect(text(view.container)).toContain('code_challenge_method=S256');
    expect(text(view.container)).toContain('Paste the code Claude showed you');
    // The old panel asked for "the complete redirected URL" against a daemon localhost callback that does
    // not exist in this flow. Asking for it again would ask for something a person never sees.
    expect(text(view.container)).not.toContain('redirected');
    expect(text(view.container)).not.toContain('localhost');
    await view.unmount();
  });

  it('never claims the daemon validates the OAuth exchange', async () => {
    // The daemon holds no verifier and no state — the harness child does. A panel that said otherwise
    // would describe the daemon as the OAuth client, which is the design this feature refuses.
    const view = await mount({ flow: claudeFlow('awaiting-code') });
    const rendered = text(view.container);

    expect(rendered).not.toContain('one-time state');
    expect(rendered).not.toContain('callback origin');
    expect(rendered).not.toContain('OAuth-state');
    await view.unmount();
  });

  it('clears the typed code before the submission is even dispatched', async () => {
    const submitted: string[] = [];
    const view = await mount({ flow: claudeFlow('awaiting-code'), onSubmitCode: code => submitted.push(code) });
    const field = codeField(view.container);

    await typeCode(field, 'the-authorization-code');
    expect(field.value).toBe('the-authorization-code');
    await submit(view.container);

    expect(submitted).toEqual(['the-authorization-code']);
    // The field is empty in the page the instant the handler returns, so no screenshot, retry
    // affordance or accessibility dump taken afterwards can carry the value.
    expect(codeField(view.container).value).toBe('');
    expect(view.container.innerHTML).not.toContain('the-authorization-code');
    await view.unmount();
  });

  it('does not submit an empty code, or one while a request is in flight', async () => {
    const submitted: string[] = [];
    const view = await mount({ flow: claudeFlow('awaiting-code'), onSubmitCode: code => submitted.push(code) });

    await submit(view.container);
    expect(submitted).toEqual([]);

    await typeCode(codeField(view.container), 'a-code');
    await view.render(
      panelWith({ flow: claudeFlow('awaiting-code'), busy: true, onSubmitCode: code => submitted.push(code) }),
    );
    await submit(view.container);
    expect(submitted).toEqual([]);
    await view.unmount();
  });

  it('says the code is kept nowhere, where the code is typed', async () => {
    const view = await mount({ flow: claudeFlow('awaiting-code') });
    expect(text(view.container)).toContain('Kept nowhere');
    await view.unmount();
  });

  it('names the way back on a failure, and offers a fresh start', async () => {
    const view = await mount({ flow: claudeFlow('failed') });

    expect(view.container.querySelector('[data-claude-login="failed"]')).not.toBeNull();
    expect(text(view.container)).toContain('sign this login in on the host');
    expect(text(view.container)).toContain('Start a new sign-in');
    await view.unmount();
  });

  it('shows a refusal in the daemon’s own words', async () => {
    const view = await mount({ refusal: 'a sign-in for this identity is already running' });
    expect(text(view.container)).toContain('already running');
    await view.unmount();
  });

  it('says it is starting while the daemon has published nothing yet', async () => {
    const view = await mount({ flow: claudeFlow('starting') });

    expect(view.container.querySelector('[data-claude-login="starting"]')).not.toBeNull();
    expect(text(view.container)).toContain('Starting sign-in…');
    expect(text(view.container)).not.toContain('claude.com');
    await view.unmount();
  });

  it('starts on the button, and cancels from the awaiting state', async () => {
    let starts = 0;
    let cancels = 0;
    const view = await mount({ onStart: () => (starts += 1) });
    await interact(() => buttons(view.container)[0]?.click());
    expect(starts).toBe(1);

    await view.render(panelWith({ flow: claudeFlow('awaiting-code'), onCancel: () => (cancels += 1) }));
    await interact(() => buttons(view.container).at(-1)?.click());
    expect(cancels).toBe(1);
    await view.unmount();
  });

  it('copies the link through the injected writer, never the real clipboard', async () => {
    const copied: string[] = [];
    const view = await mount({
      flow: claudeFlow('awaiting-code'),
      copy: async text => {
        copied.push(text);
      },
    });

    const button = must(
      view.container.querySelector<HTMLButtonElement>('[aria-label="Copy the Claude sign-in link"]'),
      'the copy button',
    );
    await interact(() => button.click());

    expect(copied).toEqual([CLAUDE_URL]);
    await view.unmount();
  });
});

describe('ClaudeLoginPanel when Claude does not take a code', () => {
  const awaitingRejected = { ...claudeFlow('awaiting-code'), lastCode: 'rejected' } as const;

  it('says the last code was refused, instead of showing the same form as if nothing happened', async () => {
    const view = await mount({ flow: awaitingRejected });

    const alert = must(view.container.querySelector('[data-claude-login-rejected]'), 'the rejected alert');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(text(view.container)).toContain('Claude didn’t accept that code.');
    expect(text(view.container)).toContain('paste it again above');
    // The obvious next action is the field that is still there.
    expect(view.container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    await view.unmount();
  });

  it('says nothing about a refusal while no code has been refused', async () => {
    const view = await mount({ flow: claudeFlow('awaiting-code') });

    expect(view.container.querySelectorAll('[data-claude-login-rejected]')).toHaveLength(0);
    expect(text(view.container)).not.toContain('didn’t accept');
    await view.unmount();
  });

  it('offers a fresh try — not the host command — when the sign-in ended on a refused code', async () => {
    let starts = 0;
    const view = await mount({
      flow: { ...(claudeFlow('failed') as FailedClaudeFlow), lastCode: 'rejected' },
      onStart: () => (starts += 1),
    });

    expect(text(view.container)).toContain('Claude didn’t accept that code.');
    expect(text(view.container)).toContain('paste the whole code Claude shows you');
    expect(text(view.container)).not.toContain('sign this login in on the host');
    expect(text(view.container)).toContain('Try again');
    await interact(() => buttons(view.container).at(-1)?.click());
    expect(starts).toBe(1);
    await view.unmount();
  });

  it('offers a new link when the sign-in link expired', async () => {
    const view = await mount({ flow: { ...(claudeFlow('failed') as FailedClaudeFlow), lastCode: 'expired' } });

    expect(text(view.container)).toContain('That sign-in link expired before a code was accepted.');
    expect(text(view.container)).toContain('Get a new link');
    expect(text(view.container)).not.toContain('sign this login in on the host');
    await view.unmount();
  });
});

describe('ClaudeLoginPanel with the wording of a login', () => {
  const wording = WORDING;

  it('labels the finish button with the wording, and falls back to the usual label without one', async () => {
    const view = await mount({ flow: claudeFlow('awaiting-code'), wording });
    expect(text(view.container)).toContain('Finish sign-in for 3 runtimes');
    await view.render(
      panelWith({ flow: claudeFlow('awaiting-code'), wording: { ...wording, finishLabel: undefined } }),
    );
    expect(text(view.container)).toContain('Finish sign-in');
    expect(text(view.container)).not.toContain('for 3 runtimes');
    await view.unmount();
  });

  it('says the signedIn sentence on complete — and none of the sibling copy report', async () => {
    const view = await mount({ flow: claudeFlow('complete'), wording });

    expect(view.container.querySelector('[data-claude-login="complete"]')).not.toBeNull();
    expect(text(view.container)).toContain('Signed in. 3 runtimes can launch now.');
    expect(text(view.container)).not.toContain('copied to');
    expect(text(view.container)).not.toContain('Signed in to Studio Claude');
    await view.unmount();
  });
});

describe('C59 O5 item 3: a long sign-in link is cut short, with a way to see all of it', () => {
  it('shows it cut short at first, "Show full" opens it and "Show less" folds it back (aria-expanded)', async () => {
    const view = await mount({ flow: claudeFlow('awaiting-code') });
    expect(CLAUDE_URL.length).toBeGreaterThanOrEqual(LONG_LINK);
    const link = (): HTMLElement => must(view.container.querySelector<HTMLElement>('[data-sign-in-link]'), 'the link');
    const toggle = (): HTMLButtonElement =>
      must(view.container.querySelector<HTMLButtonElement>('[data-sign-in-link-toggle]'), 'the toggle');

    expect(link().getAttribute('data-expanded')).toBe('false');
    expect(link().className).toContain('truncate');
    expect(link().className).not.toContain('break-all');
    expect(toggle().textContent).toBe('Show full');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().getAttribute('aria-controls')).toBe(link().id);
    // The whole link stays in the page for a reader and for Copy; only the look is cut.
    expect(link().textContent).toBe(CLAUDE_URL);

    await interact(() => toggle().click());
    expect(link().getAttribute('data-expanded')).toBe('true');
    expect(link().className).toContain('break-all');
    expect(toggle().textContent).toBe('Show less');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    await interact(() => toggle().click());
    expect(link().getAttribute('data-expanded')).toBe('false');
    expect(toggle().textContent).toBe('Show full');
    await view.unmount();
  });

  it('offers no toggle for a link that is already short', async () => {
    const view = await mountDom(<SignInLink url="https://example.test/a" copy={async () => {}} />);
    expect(view.container.querySelector('[data-sign-in-link-toggle]')).toBeNull();
    expect(view.container.querySelector('[data-sign-in-link]')?.getAttribute('data-expanded')).toBe('true');
    await view.unmount();
  });
});

describe('C59 O5 item 4: the code is one masked line', () => {
  it('is a single-line password input from the shared secret field: no textarea, never resizable, no name, not in the markup', async () => {
    const view = await mount({ flow: claudeFlow('awaiting-code') });
    const field = codeField(view.container);

    expect(view.container.querySelectorAll('textarea')).toHaveLength(0);
    expect(field.tagName).toBe('INPUT');
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('new-password');
    expect(field.hasAttribute('name')).toBe(false);
    expect(field.id).toBe('claude-login-code-claude-studio');
    await typeCode(field, 'a-secret-code-123');
    expect(field.getAttribute('value')).toBeNull();
    expect(view.container.innerHTML).not.toContain('a-secret-code-123');
    await view.unmount();
  });
});

describe('C59 O5 item 5: Finish sign in answers, and a refusal shakes', () => {
  it('shows a spinner in the Finish button, disables every other button, and keeps the label slot of one width', async () => {
    const submitted: string[] = [];
    const view = await mount({ flow: claudeFlow('awaiting-code'), onSubmitCode: code => submitted.push(code) });
    const finish = (): HTMLButtonElement =>
      must(view.container.querySelector<HTMLButtonElement>('button[type="submit"]'), 'Finish');

    expect(finish().querySelector('[data-spinner]')).toBeNull();
    expect(finish().getAttribute('aria-busy')).toBeNull();
    await typeCode(codeField(view.container), 'the-code');
    expect(disabled(finish())).toBe(false);
    await submit(view.container);
    expect(submitted).toEqual(['the-code']);

    // The request is in flight: the parent says `busy`.
    await view.render(panelWith({ flow: claudeFlow('awaiting-code'), busy: true, wording: WORDING }));
    expect(finish().getAttribute('aria-busy')).toBe('true');
    expect(finish().querySelector('[data-spinner]')).not.toBeNull();
    expect(finish().textContent).toBe('Sending…');
    // The label it had is kept as a ghost the same width, so the button does not resize.
    expect(finish().querySelector('.kt-btn__label')?.getAttribute('data-ghost')).toBe('Finish sign-in for 3 runtimes');
    for (const button of buttons(view.container)) expect(disabled(button)).toBe(true);

    await view.render(panelWith({ flow: claudeFlow('awaiting-code'), busy: false, wording: WORDING }));
    expect(finish().getAttribute('aria-busy')).toBeNull();
    expect(finish().querySelector('[data-spinner]')).toBeNull();
    await view.unmount();
  });

  it('a start-over or a cancel in flight does not make Finish look as if the code were sent', async () => {
    const view = await mount({ flow: claudeFlow('awaiting-code'), busy: true });
    const finish = must(view.container.querySelector<HTMLButtonElement>('button[type="submit"]'), 'Finish');
    expect(finish.getAttribute('aria-busy')).toBeNull();
    expect(finish.querySelector('[data-spinner]')).toBeNull();
    await view.unmount();
  });

  it('says a refusal as an alert that carries the shake, in the space kept under the buttons', async () => {
    const view = await mount({ flow: claudeFlow('awaiting-code'), refusal: 'Claude did not accept that code.' });
    const alert = must(view.container.querySelector('[data-sign-in-notes] [role="alert"]'), 'the refusal');
    expect(alert.textContent).toContain('Claude did not accept that code.');
    expect(alert.className).toContain('fy-shake');
    // Said once: not also above the steps.
    expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    await view.unmount();
  });

  it('ends on a plain "Signed in" with its mark', async () => {
    const view = await mount({ flow: claudeFlow('complete'), wording: { coverage: 'c', signedIn: 'Signed in.' } });
    const status = must(view.container.querySelector('[role="status"]'), 'the success');
    expect(status.textContent).toBe('Signed in.');
    expect(status.querySelector('svg')).not.toBeNull();
    await view.unmount();
  });
});
