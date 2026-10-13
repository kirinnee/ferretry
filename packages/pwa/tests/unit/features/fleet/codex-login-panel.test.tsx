/**
 * Codex's own panel. This file is Codex's and only Codex's.
 *
 * The load-bearing assertion here has no counterpart in Claude's suite: **a device code has no field**.
 * A device grant completes at the provider, so a device screen that offered somewhere to paste would be
 * asking for a value this harness has no way to receive. The link sign-in has exactly one field, for the
 * address the browser ends on, and it is cleared before the request settles.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { CodexLoginFlow } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import { CodexLoginPanel } from '../../../../src/features/fleet/codex-login-panel.tsx';
import { render, run } from '../../../support/react.ts';
import { CODEX_CODE, CODEX_LINK_URL, CODEX_URL, codexFlow } from './harness-login-support.ts';

const WORDING = {
  coverage: 'Every runtime that uses it can launch once it is done.',
  signedIn: 'Signed in. 2 runtimes can launch now.',
};

let mounted: ReactTestRenderer | null = null;

afterEach(() => {
  if (mounted !== null) run(() => mounted?.unmount());
  mounted = null;
});

const element = (overrides: Partial<Parameters<typeof CodexLoginPanel>[0]> = {}) => (
  <CodexLoginPanel
    accountLabel="Studio Codex"
    loginId="codex-studio"
    wording={WORDING}
    flow={null}
    busy={false}
    refusal={null}
    onStart={() => undefined}
    onCancel={() => undefined}
    onUseLink={() => undefined}
    onStartLink={() => undefined}
    onSubmitAddress={() => undefined}
    linked={false}
    copy={async () => {}}
    {...overrides}
  />
);

const mount = (overrides: Partial<Parameters<typeof CodexLoginPanel>[0]> = {}): ReactTestRenderer => {
  mounted = render(element(overrides));
  return mounted;
};

const texts = (view: ReactTestRenderer): string => JSON.stringify(view.toJSON());

type Node = ReactTestRenderer['root'];
const textOf = (node: Node | string): string =>
  typeof node === 'string' ? node : node.children.map(child => textOf(child)).join('');

const buttonNamed = (view: ReactTestRenderer, name: string): Node => {
  const found = view.root.findAll(node => node.type === 'button' && textOf(node).includes(name))[0];
  if (found === undefined) throw new Error(`no button "${name}"`);
  return found;
};

describe('CodexLoginPanel', () => {
  it('says up front that nothing comes back to this screen', () => {
    const view = mount();

    expect(view.root.findByProps({ 'data-codex-login': 'idle' })).toBeDefined();
    expect(texts(view)).toContain('Nothing comes back to this screen');
    expect(texts(view)).toContain('Sign in to Codex');
  });

  it('has no place to type a code, in any device-code state', () => {
    // The whole shape difference from Claude's panel, asserted over every state rather than one.
    for (const flow of [
      null,
      codexFlow('starting'),
      codexFlow('awaiting-approval'),
      codexFlow('complete'),
      codexFlow('failed'),
    ]) {
      const view = mount({ flow });

      expect(view.root.findAllByType('textarea')).toHaveLength(0);
      expect(view.root.findAllByType('form')).toHaveLength(0);
      expect(view.root.findAllByType('input')).toHaveLength(0);
      run(() => mounted?.unmount());
      mounted = null;
    }
  });

  it('publishes the link and the code together, because a device grant needs both', () => {
    const view = mount({ flow: codexFlow('awaiting-approval') });

    expect(view.root.findByProps({ 'data-codex-login': 'awaiting-approval' })).toBeDefined();
    expect(texts(view)).toContain(CODEX_URL);
    expect(view.root.findByProps({ 'data-codex-login-user-code': '' }).children.join('')).toBe(CODEX_CODE);
  });

  it('repeats the provider’s own caution about a code somebody else gave you', () => {
    expect(texts(mount({ flow: codexFlow('awaiting-approval') }))).toContain('If a website or another person gave you');
  });

  it('says it is waiting for the provider rather than for the reader', () => {
    const view = mount({ flow: codexFlow('awaiting-approval') });

    expect(texts(view)).toContain('Codex finishes on its own');
    expect(texts(view)).toContain('nothing to paste back');
  });

  it('shows nothing to act on while the daemon has published only half a grant', () => {
    const view = mount({ flow: codexFlow('starting') });

    expect(view.root.findByProps({ 'data-codex-login': 'starting' })).toBeDefined();
    expect(texts(view)).not.toContain(CODEX_URL);
    expect(texts(view)).not.toContain(CODEX_CODE);
  });

  it('names the way back on a failure', () => {
    const view = mount({ flow: codexFlow('failed') });

    expect(texts(view)).toContain('sign this login in on the host');
    expect(texts(view)).toContain('Start a new sign-in');
  });

  it('shows a refusal in the daemon’s own words', () => {
    expect(texts(mount({ refusal: 'Codex has no interactive login on this build' }))).toContain('no interactive login');
  });

  it('starts on the button and cancels from the awaiting state', () => {
    let starts = 0;
    let cancels = 0;
    const view = mount({ onStart: () => (starts += 1) });
    run(() => view.root.findAllByType('button')[0]?.props.onClick());
    expect(starts).toBe(1);

    run(() => mounted?.update(element({ flow: codexFlow('awaiting-approval'), onCancel: () => (cancels += 1) })));
    run(() => buttonNamed(view, 'Cancel').props.onClick());
    expect(cancels).toBe(1);
  });

  it('shows starting copy while a start is in flight', () => {
    expect(texts(mount({ flow: codexFlow('starting') }))).toContain('Starting sign-in…');
  });

  it('copies both values through the injected writer', async () => {
    const copied: string[] = [];
    const view = mount({
      flow: codexFlow('awaiting-approval'),
      copy: async text => {
        copied.push(text);
      },
    });

    await run(() => view.root.findByProps({ 'aria-label': 'Copy the Codex sign-in link' }).props.onClick());
    await run(() => view.root.findByProps({ 'aria-label': 'Copy the Codex device code' }).props.onClick());

    expect(copied).toEqual([CODEX_URL, CODEX_CODE]);
  });
});

describe('CodexLoginPanel when the one-time code expired', () => {
  it('says the code expired — never that it was rejected — and offers a new one', () => {
    let starts = 0;
    const view = mount({
      flow: { ...(codexFlow('failed') as Extract<CodexLoginFlow, { state: 'failed' }>), lastCode: 'expired' },
      onStart: () => (starts += 1),
    });

    expect(texts(view)).toContain('That one-time code expired before it was approved.');
    expect(texts(view)).toContain('Get a new code');
    expect(texts(view)).not.toContain('reject');
    expect(texts(view)).not.toContain('sign this login in on the host');
    run(() => buttonNamed(view, 'Get a new code').props.onClick());
    expect(starts).toBe(1);
  });

  it('keeps the daemon’s own words for every other failure', () => {
    const view = mount({ flow: codexFlow('failed') });

    expect(texts(view)).toContain('the sign-in ran out of time');
    expect(texts(view)).toContain('Start a new sign-in');
    expect(texts(view)).not.toContain('Get a new code');
  });
});

describe('CodexLoginPanel with the wording of a login', () => {
  const wording = WORDING;

  it('shows no identity line and says its own coverage sentence', () => {
    const view = mount();
    expect(texts(view)).not.toContain('Identity');
    expect(view.root.findAllByType('code')).toHaveLength(0);
    expect(texts(view)).toContain(wording.coverage);
    expect(texts(view)).not.toContain('sibling');
  });

  it('says the signedIn sentence on complete — and none of the sibling copy report', () => {
    const view = mount({ flow: codexFlow('complete'), wording });

    expect(texts(view)).toContain('Signed in. 2 runtimes can launch now.');
    expect(texts(view)).not.toContain('copied to');
    expect(texts(view)).not.toContain('No sibling wrapper needed a copy');
    expect(texts(view)).not.toContain('Signed in to Studio Codex');
  });
});

describe('CodexLoginPanel with a link', () => {
  const callbackFlow = codexFlow('awaiting-callback');
  const ADDRESS = 'http://localhost:1455/auth/callback?code=code-TESTONLY&state=fixture';

  it('offers a link while a device code is showing, and asks for it on the button', () => {
    let switches = 0;
    const view = mount({ flow: codexFlow('awaiting-approval'), onUseLink: () => (switches += 1) });

    expect(texts(view)).toContain('Device code didn’t work?');
    run(() => buttonNamed(view, 'Sign in with a link instead').props.onClick());
    expect(switches).toBe(1);
  });

  it('shows the link, says the next page won’t load, and asks for that address', () => {
    const view = mount({ flow: callbackFlow, linked: true });

    expect(view.root.findByProps({ 'data-codex-login': 'awaiting-callback' })).toBeDefined();
    expect(texts(view)).toContain(CODEX_LINK_URL);
    expect(texts(view)).toContain('won’t load');
    expect(texts(view)).toContain('http://localhost');
    expect(view.root.findAllByType('textarea')).toHaveLength(1);
    expect(view.root.findAllByProps({ 'data-codex-login-device-unavailable': '' })).toHaveLength(0);
  });

  it('says why when the daemon moved to a link because device codes are off', () => {
    const view = mount({
      flow: { ...(callbackFlow as Extract<CodexLoginFlow, { state: 'awaiting-callback' }>), deviceCode: 'unavailable' },
      linked: true,
    });

    expect(texts(view)).toContain('This account doesn’t allow device codes');
  });

  it('hands the address over and clears it from the screen, never sending a blank one', () => {
    const sent: string[] = [];
    const view = mount({ flow: callbackFlow, linked: true, onSubmitAddress: address => sent.push(address) });
    const form = view.root.findByType('form');

    run(() => form.props.onSubmit({ preventDefault: () => undefined }));
    run(() => view.root.findByType('textarea').props.onChange({ target: { value: ADDRESS } }));
    run(() => form.props.onSubmit({ preventDefault: () => undefined }));

    expect(sent).toEqual([ADDRESS]);
    expect(view.root.findByType('textarea').props.value).toBe('');
    expect(texts(view)).not.toContain('code-TESTONLY');
  });

  it('refuses to send while busy, and shows the finish label it was given', () => {
    const sent: string[] = [];
    const view = mount({
      flow: callbackFlow,
      linked: true,
      wording: { ...WORDING, finishLabel: 'Finish and launch' },
      onSubmitAddress: address => sent.push(address),
    });
    expect(texts(view)).toContain('Finish and launch');
    run(() => view.root.findByType('textarea').props.onChange({ target: { value: ADDRESS } }));
    run(() =>
      mounted?.update(element({ flow: callbackFlow, linked: true, busy: true, onSubmitAddress: a => sent.push(a) })),
    );
    run(() => view.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }));

    expect(sent).toEqual([]);
    expect(texts(view)).toContain('Sending…');
  });

  it('says Codex is finishing once the address is delivered, and can still be cancelled', () => {
    let cancels = 0;
    const view = mount({ flow: codexFlow('finishing'), linked: true, onCancel: () => (cancels += 1) });

    expect(texts(view)).toContain('Codex is finishing the sign-in…');
    run(() => buttonNamed(view, 'Cancel').props.onClick());
    expect(cancels).toBe(1);
  });

  it('starts as a link sign-in in words, when the link was chosen', () => {
    expect(texts(mount({ flow: codexFlow('starting'), linked: true }))).toContain('Codex signs in with a link');
  });

  const failedWith = (lastCode: 'expired' | 'rejected'): CodexLoginFlow => ({
    ...(codexFlow('failed') as Extract<CodexLoginFlow, { state: 'failed' }>),
    lastCode,
  });

  it('speaks about the link, not a code, when a link sign-in expired or its address was not taken', () => {
    const expired = mount({ flow: failedWith('expired'), linked: true });
    expect(texts(expired)).toContain('That sign-in link expired before its address came back.');
    expect(texts(expired)).toContain('Get a new link');
    expect(texts(expired)).not.toContain('Sign in with a link instead');
    run(() => mounted?.unmount());

    const rejected = mount({ flow: failedWith('rejected'), linked: true });
    expect(texts(rejected)).toContain('Codex couldn’t finish signing in with that address.');
    expect(texts(rejected)).toContain('Try again');
  });

  it('offers a link sign-in after a device code failed', () => {
    let links = 0;
    const view = mount({ flow: codexFlow('failed'), onStartLink: () => (links += 1) });

    run(() => buttonNamed(view, 'Sign in with a link instead').props.onClick());
    expect(links).toBe(1);
  });
});
