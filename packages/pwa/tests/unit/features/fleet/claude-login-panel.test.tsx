/**
 * Claude's own panel. This file is Claude's and only Claude's.
 *
 * There is no shared suite with `codex-login-panel.test.tsx` on purpose: the properties that matter here
 * — a paste field, a value cleared before the request settles — have no counterpart there, and one
 * parameterised suite over both would be evidence about a shape rather than about either sign-in.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { ClaudeLoginFlow } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import { ClaudeLoginPanel } from '../../../../src/features/fleet/claude-login-panel.tsx';
import { render, run } from '../../../support/react.ts';
import { CLAUDE_URL, claudeFlow } from './harness-login-support.ts';

type FailedClaudeFlow = Extract<ClaudeLoginFlow, { state: 'failed' }>;

const WORDING = {
  coverage: 'Every runtime that uses it can launch once it is done.',
  signedIn: 'Signed in. 3 runtimes can launch now.',
  finishLabel: 'Finish sign-in for 3 runtimes',
};

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
    />,
  );
  return mounted;
};

const texts = (view: ReactTestRenderer): string => JSON.stringify(view.toJSON());

describe('ClaudeLoginPanel', () => {
  it('offers a sign-in and says what one sign-in covers', () => {
    const view = mount();

    expect(view.root.findByProps({ 'data-claude-login': 'idle' })).toBeDefined();
    expect(texts(view)).toContain(WORDING.coverage);
    expect(texts(view)).toContain('Sign in to Claude Code');
  });

  it('shows no identity line and no sibling copy', () => {
    const view = mount();

    expect(texts(view)).not.toContain('Identity');
    expect(texts(view)).not.toContain('sibling');
    expect(view.root.findAllByType('code')).toHaveLength(0);
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

  it('names the way back on a failure, and offers a fresh start', () => {
    const view = mount({ flow: claudeFlow('failed') });

    expect(view.root.findByProps({ 'data-claude-login': 'failed' })).toBeDefined();
    expect(texts(view)).toContain('sign this login in on the host');
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

describe('ClaudeLoginPanel when Claude does not take a code', () => {
  const awaitingRejected = { ...claudeFlow('awaiting-code'), lastCode: 'rejected' } as const;

  it('says the last code was refused, instead of showing the same form as if nothing happened', () => {
    const view = mount({ flow: awaitingRejected });

    const alert = view.root.findByProps({ 'data-claude-login-rejected': '' });
    expect(alert.props.role).toBe('alert');
    expect(texts(view)).toContain('Claude didn’t accept that code.');
    expect(texts(view)).toContain('paste it again below');
    // The obvious next action is the field that is still there.
    expect(view.root.findAllByType('textarea')).toHaveLength(1);
  });

  it('says nothing about a refusal while no code has been refused', () => {
    const view = mount({ flow: claudeFlow('awaiting-code') });

    expect(view.root.findAllByProps({ 'data-claude-login-rejected': '' })).toHaveLength(0);
    expect(texts(view)).not.toContain('didn’t accept');
  });

  it('offers a fresh try — not the host command — when the sign-in ended on a refused code', () => {
    let starts = 0;
    const view = mount({
      flow: { ...(claudeFlow('failed') as FailedClaudeFlow), lastCode: 'rejected' },
      onStart: () => (starts += 1),
    });

    expect(texts(view)).toContain('Claude didn’t accept that code.');
    expect(texts(view)).toContain('paste the whole code Claude shows you');
    expect(texts(view)).not.toContain('sign this login in on the host');
    expect(texts(view)).toContain('Try again');
    run(() => view.root.findAllByType('button').at(-1)?.props.onClick());
    expect(starts).toBe(1);
  });

  it('offers a new link when the sign-in link expired', () => {
    const view = mount({ flow: { ...(claudeFlow('failed') as FailedClaudeFlow), lastCode: 'expired' } });

    expect(texts(view)).toContain('That sign-in link expired before a code was accepted.');
    expect(texts(view)).toContain('Get a new link');
    expect(texts(view)).not.toContain('sign this login in on the host');
  });
});

describe('ClaudeLoginPanel with the wording of a login', () => {
  const wording = WORDING;

  it('labels the finish button with the wording, and falls back to the usual label without one', () => {
    expect(texts(mount({ flow: claudeFlow('awaiting-code'), wording }))).toContain('Finish sign-in for 3 runtimes');
    run(() => mounted?.unmount());
    expect(
      texts(mount({ flow: claudeFlow('awaiting-code'), wording: { ...wording, finishLabel: undefined } })),
    ).toContain('Finish sign-in');
    run(() => mounted?.unmount());
    const view = mount({
      flow: claudeFlow('awaiting-code'),
      wording: { coverage: wording.coverage, signedIn: wording.signedIn },
    });
    expect(texts(view)).not.toContain('for 3 runtimes');
    expect(texts(view)).toContain('Finish sign-in');
  });

  it('says the signedIn sentence on complete — and none of the sibling copy report', () => {
    const view = mount({ flow: claudeFlow('complete'), wording });

    expect(view.root.findByProps({ 'data-claude-login': 'complete' })).toBeDefined();
    expect(texts(view)).toContain('Signed in. 3 runtimes can launch now.');
    expect(texts(view)).not.toContain('copied to');
    expect(texts(view)).not.toContain('Signed in to Studio Claude');
  });
});
