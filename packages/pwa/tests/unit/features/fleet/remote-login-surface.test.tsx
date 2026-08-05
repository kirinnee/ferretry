import { describe, expect, it } from 'bun:test';

import { type RemoteLoginStep, RemoteLoginSurface } from '../../../../src/features/fleet/remote-login-surface.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const daemon = daemonConnection({
  daemonId: 'remote-login-daemon',
  baseUrl: 'https://daemon.example.test',
  deviceToken: 'test-token',
});

const identity = {
  identity: 'claude:studio',
  provider: 'claude' as const,
  accountLabel: 'Studio Claude',
  memberCount: 3,
};

const callbackUrl = 'http://127.0.0.1:43123/oauth/callback?code=fixture-not-a-credential&state=fixture-state';
const awaiting: RemoteLoginStep = {
  kind: 'awaiting-callback',
  authorizationUrl: 'https://accounts.example.test/authorize?state=fixture-state',
};

describe('RemoteLoginSurface', () => {
  it('names the daemon-scoped identity and its sibling coverage before sign-in starts', () => {
    const view = render(
      <RemoteLoginSurface
        daemonId={daemon.daemonId}
        identity={identity}
        initialStep={{ kind: 'ready' }}
        onStart={async () => awaiting}
        onSubmitRedirect={async () => ({ kind: 'complete', copiedToSiblings: 2 })}
      />,
    );

    const root = view.root.findByProps({ 'data-remote-login': 'ready' });
    expect(root.props['data-remote-login-daemon-id']).toBe('remote-login-daemon');
    const text = JSON.stringify(view.toJSON());
    expect(text).toContain('Studio Claude');
    expect(text).toContain('2 sibling wrappers too');
    expect(text).toContain('Log in to Claude Code');
    view.unmount();
  });

  it('clears a pasted callback before the daemon result renders and never echoes it after rejection', async () => {
    let received = '';
    const view = render(
      <RemoteLoginSurface
        daemonId={daemon.daemonId}
        identity={identity}
        initialStep={awaiting}
        onStart={async () => awaiting}
        onSubmitRedirect={async redirect => {
          received = redirect;
          return { kind: 'rejected', reason: 'That callback belongs to another sign-in.' };
        }}
      />,
    );

    const input = view.root.findByProps({ name: 'remote-login-callback' });
    run(() => input.props.onChange({ target: { value: callbackUrl } }));
    const form = view.root.findByType('form');
    await runAsync(async () => {
      await form.props.onSubmit({ preventDefault() {} });
    });

    expect(received).toBe(callbackUrl);
    const updatedInput = view.root.findByProps({ name: 'remote-login-callback' });
    expect(updatedInput.props.value).toBe('');
    const rendered = JSON.stringify(view.toJSON());
    expect(rendered).not.toContain(callbackUrl);
    expect(rendered).toContain('That callback belongs to another sign-in.');
    view.unmount();
  });

  it('reports verified identity success and the exact sibling fan-out', () => {
    const view = render(
      <RemoteLoginSurface
        daemonId={daemon.daemonId}
        identity={identity}
        initialStep={{ kind: 'complete', copiedToSiblings: 2 }}
        onStart={async () => awaiting}
        onSubmitRedirect={async () => ({ kind: 'complete', copiedToSiblings: 2 })}
      />,
    );

    const rendered = JSON.stringify(view.toJSON());
    expect(rendered).toContain('Signed in to ');
    expect(rendered).toContain('Studio Claude');
    expect(rendered).toContain('2 sibling wrappers.');
    view.unmount();
  });
});
