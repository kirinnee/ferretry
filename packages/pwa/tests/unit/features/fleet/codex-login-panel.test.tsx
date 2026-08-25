/**
 * Codex's own panel. This file is Codex's and only Codex's.
 *
 * The load-bearing assertion here has no counterpart in Claude's suite: **there is no field**. A device
 * grant completes at the provider, so a panel that offered somewhere to paste would be asking for a value
 * this harness has no way to receive.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactTestRenderer } from 'react-test-renderer';

import { CodexLoginPanel } from '../../../../src/features/fleet/codex-login-panel.tsx';
import { render, run } from '../../../support/react.ts';
import { CODEX_CODE, CODEX_URL, codexFlow } from './harness-login-support.ts';

let mounted: ReactTestRenderer | null = null;

afterEach(() => {
  if (mounted !== null) run(() => mounted?.unmount());
  mounted = null;
});

const element = (overrides: Partial<Parameters<typeof CodexLoginPanel>[0]> = {}) => (
  <CodexLoginPanel
    accountLabel="Studio Codex"
    identity="codex:studio"
    memberCount={2}
    flow={null}
    busy={false}
    refusal={null}
    onStart={() => undefined}
    onCancel={() => undefined}
    copy={async () => {}}
    {...overrides}
  />
);

const mount = (overrides: Partial<Parameters<typeof CodexLoginPanel>[0]> = {}): ReactTestRenderer => {
  mounted = render(element(overrides));
  return mounted;
};

const texts = (view: ReactTestRenderer): string => JSON.stringify(view.toJSON());

describe('CodexLoginPanel', () => {
  it('says up front that nothing comes back to this screen', () => {
    const view = mount();

    expect(view.root.findByProps({ 'data-codex-login': 'idle' })).toBeDefined();
    expect(texts(view)).toContain('Nothing comes back to this screen');
    expect(texts(view)).toContain('Sign in to Codex');
  });

  it('has no place to type a code, in any state it can be in', () => {
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

  it('reports the sibling copies when it finishes', () => {
    const flow = codexFlow('complete');
    const view = mount({
      flow: {
        ...flow,
        state: 'complete',
        accounts: [
          { accountId: flow.accountId, status: 'logged-in' },
          { accountId: '55555555-5555-4555-8555-555555555555', status: 'synced' },
        ],
      },
    });

    expect(texts(view)).toContain('copied to 1 sibling wrapper');
  });

  it('says no sibling needed a copy when none did', () => {
    expect(texts(mount({ flow: codexFlow('complete') }))).toContain('No sibling wrapper needed a copy');
  });

  it('names every account that did not settle rather than claiming success', () => {
    const flow = codexFlow('complete');
    const view = mount({
      flow: {
        ...flow,
        state: 'complete',
        accounts: [{ accountId: flow.accountId, status: 'failed', message: 'the sign-in exited with code 1' }],
      },
    });

    expect(texts(view)).toContain('without settling every account');
    expect(texts(view)).toContain('exited with code 1');
  });

  it('names the way back on a failure', () => {
    const view = mount({ flow: codexFlow('failed') });

    expect(texts(view)).toContain('fy fleet login');
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
    const buttons = view.root.findAllByType('button');
    run(() => buttons[buttons.length - 1]?.props.onClick());
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

  it('says one covers this account only when there is no sibling', () => {
    expect(texts(mount({ memberCount: 1 }))).toContain('this account only');
  });

  it('says several siblings in the plural', () => {
    expect(texts(mount({ memberCount: 4 }))).toContain('3 sibling wrappers too');
  });
});
