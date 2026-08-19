/**
 * Claude's own panel. This file is Claude's and only Claude's.
 *
 * There is no shared suite with `codex-login-panel.test.tsx` on purpose: the properties that matter here
 * — a paste field, a value cleared before the request settles — have no counterpart there, and one
 * parameterised suite over both would be evidence about a shape rather than about either sign-in.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';

import { ClaudeLoginPanel } from '../../../../src/features/fleet/claude-login-panel.tsx';
import { render, run } from '../../../support/react.ts';
import { CLAUDE_URL, claudeFlow } from './harness-login-support.ts';

/** A failed render must not leak its mount, or the next test in this file renders into it. */
let mounted: ReactTestRenderer | null = null;

afterEach(() => {
  if (mounted !== null) run(() => mounted?.unmount());
  mounted = null;
});

const mount = (overrides: Partial<Parameters<typeof ClaudeLoginPanel>[0]> = {}): ReactTestRenderer => {
  mounted = render(
    <ClaudeLoginPanel
      accountLabel="Studio Claude"
      identity="claude:studio"
      memberCount={3}
      flow={null}
      busy={false}
      refusal={null}
      onStart={() => undefined}
      onSubmitCode={() => undefined}
      onCancel={() => undefined}
      copy={async () => {}}
      {...overrides}
    />,
  );
  return mounted;
};

const texts = (view: ReactTestRenderer): string => JSON.stringify(view.toJSON());

describe('ClaudeLoginPanel', () => {
  it('offers a sign-in and says one covers every sibling lane', () => {
    const view = mount();

    expect(view.root.findByProps({ 'data-claude-login': 'idle' })).toBeDefined();
    expect(texts(view)).toContain('2 sibling wrappers too');
    expect(texts(view)).toContain('Sign in to Claude Code');
  });

  it('says one covers this account only when there is no sibling', () => {
    expect(texts(mount({ memberCount: 1 }))).toContain('this account only');
  });

  it('says one sibling in the singular', () => {
    expect(texts(mount({ memberCount: 2 }))).toContain('1 sibling wrapper too');
  });

  it('states that the daemon never holds a credential', () => {
    expect(texts(mount())).toContain('this daemon never holds one');
  });

  it('publishes the link with its PKCE query intact, and asks for a CODE rather than a URL', () => {
    const view = mount({ flow: claudeFlow('awaiting-code') });

    expect(texts(view)).toContain('code_challenge_method=S256');
    expect(texts(view)).toContain('Paste the code Claude showed you');
    // The old panel asked for "the complete redirected URL" against a daemon localhost callback that does
    // not exist in this flow. Asking for it again would ask for something a person never sees.
    expect(texts(view)).not.toContain('redirected');
    expect(texts(view)).not.toContain('localhost');
  });

  it('never claims the daemon validates the OAuth exchange', () => {
    // The daemon holds no verifier and no state — the harness child does. A panel that said otherwise
    // would describe the daemon as the OAuth client, which is the design this feature refuses.
    const rendered = texts(mount({ flow: claudeFlow('awaiting-code') }));

    expect(rendered).not.toContain('one-time state');
    expect(rendered).not.toContain('callback origin');
    expect(rendered).not.toContain('OAuth-state');
  });

  it('clears the typed code before the submission is even dispatched', () => {
    const submitted: string[] = [];
    const view = mount({ flow: claudeFlow('awaiting-code'), onSubmitCode: code => submitted.push(code) });
    const field = view.root.findByProps({ name: 'claude-login-code' });

    run(() => field.props.onChange({ target: { value: 'the-authorization-code' } }));
    run(() => view.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }));

    expect(submitted).toEqual(['the-authorization-code']);
    // The field is empty in the rendered tree the instant the handler returns, so no screenshot, retry
    // affordance or accessibility dump taken afterwards can carry the value.
    expect(view.root.findByProps({ name: 'claude-login-code' }).props.value).toBe('');
    expect(texts(view)).not.toContain('the-authorization-code');
  });

  it('does not submit an empty code, or one while a request is in flight', () => {
    const submitted: string[] = [];
    const view = mount({ flow: claudeFlow('awaiting-code'), onSubmitCode: code => submitted.push(code) });

    run(() => view.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }));
    expect(submitted).toEqual([]);

    run(() =>
      mounted?.update(
        panelWith({ flow: claudeFlow('awaiting-code'), busy: true, onSubmitCode: code => submitted.push(code) }),
      ),
    );
    run(() => view.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }));
    expect(submitted).toEqual([]);
  });

  it('says the code is kept nowhere, where the code is typed', () => {
    expect(texts(mount({ flow: claudeFlow('awaiting-code') }))).toContain('kept nowhere');
  });

  it('reports how many siblings received the credential when it finishes', () => {
    const view = mount({ flow: claudeFlow('complete') });

    expect(view.root.findByProps({ 'data-claude-login': 'complete' })).toBeDefined();
    expect(texts(view)).toContain('copied to 1 sibling wrapper');
  });

  it('says no sibling needed a copy when none did', () => {
    const flow = claudeFlow('complete');
    const view = mount({
      flow: { ...flow, state: 'complete', accounts: [{ accountId: flow.accountId, status: 'logged-in' }] },
    });

    expect(texts(view)).toContain('No sibling wrapper needed a copy');
  });

  it('names every lane that did not settle rather than claiming success', () => {
    const flow = claudeFlow('complete');
    const view = mount({
      flow: {
        ...flow,
        state: 'complete',
        accounts: [
          { accountId: flow.accountId, status: 'logged-in' },
          { accountId: '99999999-9999-4999-8999-999999999999', status: 'indeterminate', message: 'a locked keychain' },
        ],
      },
    });

    expect(texts(view)).toContain('without settling every lane');
    expect(texts(view)).toContain('a locked keychain');
  });

  it('names the way back on a failure, and offers a fresh start', () => {
    const view = mount({ flow: claudeFlow('failed') });

    expect(view.root.findByProps({ 'data-claude-login': 'failed' })).toBeDefined();
    expect(texts(view)).toContain('fy fleet login');
    expect(texts(view)).toContain('Start a new sign-in');
  });

  it('shows a refusal in the daemon’s own words', () => {
    expect(texts(mount({ refusal: 'a sign-in for this identity is already running' }))).toContain('already running');
  });

  it('says it is starting while the daemon has published nothing yet', () => {
    const view = mount({ flow: claudeFlow('starting') });

    expect(view.root.findByProps({ 'data-claude-login': 'starting' })).toBeDefined();
    expect(texts(view)).toContain('Starting sign-in…');
    expect(texts(view)).not.toContain('claude.com');
  });

  it('starts on the button, and cancels from the awaiting state', () => {
    let starts = 0;
    let cancels = 0;
    const view = mount({ onStart: () => (starts += 1) });
    run(() => view.root.findAllByType('button')[0]?.props.onClick());
    expect(starts).toBe(1);

    run(() => mounted?.update(panelWith({ flow: claudeFlow('awaiting-code'), onCancel: () => (cancels += 1) })));
    const buttons = view.root.findAllByType('button');
    run(() => buttons[buttons.length - 1]?.props.onClick());
    expect(cancels).toBe(1);
  });

  it('copies the link through the injected writer, never the real clipboard', async () => {
    const copied: string[] = [];
    const view = mount({
      flow: claudeFlow('awaiting-code'),
      copy: async text => {
        copied.push(text);
      },
    });

    const button = view.root.findByProps({ 'aria-label': 'Copy the Claude sign-in link' });
    await run(() => button.props.onClick());

    expect(copied).toEqual([CLAUDE_URL]);
  });
});

/** The same element with one prop changed, for an update inside `act`. */
const panelWith = (overrides: Partial<Parameters<typeof ClaudeLoginPanel>[0]>) => (
  <ClaudeLoginPanel
    accountLabel="Studio Claude"
    identity="claude:studio"
    memberCount={3}
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
