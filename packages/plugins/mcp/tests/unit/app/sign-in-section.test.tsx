import { afterEach, describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import type { Mounted } from '@ferretry/app/testing';
import { McpSignInSection, type McpSignInSectionProps } from '../../../app/views/sign-in-section.tsx';
import {
  type Answers,
  type Call,
  CALLBACK,
  completion,
  fakeChannels,
  mcpConnection,
  mcpFlow,
  NOW,
  scriptedClient,
  SECRETS,
} from './mcp-fixtures.ts';
import { click, mountSettled, settle, text } from './mcp-view-support.tsx';

/** What Gate's grants answer when this caller may change the fleet right now. */
const GRANTS_OPEN = { capabilities: [{ capability: 'fleet', configure: true, configureRefusal: 'granted' }] };

const LIST = 'GET /v1/mcp/auth';
const START = 'POST /v1/mcp/auth/:component';
const SIGN_OUT = 'DELETE /v1/mcp/auth/:component';
const FINISH = 'POST /v1/mcp/auth/flows/:flowId';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const open = async (answers: Answers, props: Partial<McpSignInSectionProps> = {}) => {
  const calls: Call[] = [];
  const channels = fakeChannels();
  // The same object the client reads, so a test can change what the machine answers next.
  answers['GET /v1/grants'] ??= GRANTS_OPEN;
  mounted = await mountSettled(
    <McpSignInSection
      component="linear"
      machineName="studio-mac"
      online
      client={scriptedClient(answers, calls)}
      origin="https://ferretry.pages.dev"
      channel={channels.factory}
      now={() => NOW}
      {...props}
    />,
  );
  return { root: mounted.container, calls, channels: channels.opened };
};

const listing = (...connections: ReturnType<typeof mcpConnection>[]) => ({ connections });

describe('McpSignInSection — where it stands', () => {
  it('says a server nobody signed in to needs a sign-in, with no sign-out to offer', async () => {
    const { root } = await open({ [LIST]: listing(mcpConnection({ component: 'other' })) });
    expect(text(root, '[data-mcp-sign-in-status]')).toBe('Needs sign-in');
    expect(root.querySelector('[data-mcp-sign-in-state="none"]')).not.toBeNull();
    expect(text(root, '[data-change-submit]')).toBe('Sign in');
    expect(root.querySelector('[data-mcp-sign-out-ask]')).toBeNull();
    expect(root.querySelector('[data-mcp-sign-in-secrets]')).toBeNull();
  });

  it('shows a signed-in server’s expiry, issuer and the secrets it lives under', async () => {
    const { root } = await open({ [LIST]: listing(mcpConnection()) });
    expect(text(root, '[data-mcp-sign-in-status]')).toBe('Signed in · expires in 59m');
    expect(root.textContent).toContain('With auth.linear.example');
    for (const secret of SECRETS) expect(text(root, '[data-mcp-sign-in-secrets]')).toContain(secret);
    expect(text(root, '[data-change-submit]')).toBe('Sign in again');
  });

  it('shows no issuer when the daemon did not say', async () => {
    const { root } = await open({
      [LIST]: listing(mcpConnection({ state: 'needs-sign-in', issuer: undefined, secrets: [] })),
    });
    expect(root.textContent).not.toContain('With ');
  });

  it('says why it could not read, and reads again on Try again', async () => {
    const answers: Answers = { [LIST]: new DaemonCallError(403, 'grant_refused', 'Not allowed here.') };
    const { root } = await open(answers);
    expect(text(root, '[data-mcp-note="mcp-sign-in-failed"]')).toContain('Not allowed here.');
    answers[LIST] = listing();
    await click(root, '[data-mcp-sign-in-retry]');
    expect(text(root, '[data-mcp-sign-in-status]')).toBe('Needs sign-in');
  });

  it('says it is reading until the machine answers', async () => {
    const { root } = await open({ [LIST]: () => new Promise(() => undefined) });
    expect(root.textContent).toContain('Reading whether linear is signed in…');
  });
});

describe('McpSignInSection — signing in and out', () => {
  it('starts a sign-in that comes back to this origin, finishes it in the sheet and reads again', async () => {
    const answers: Answers = {
      [LIST]: listing(),
      [START]: mcpFlow(),
      [FINISH]: completion(),
    };
    const { root, calls, channels } = await open(answers);
    await click(root, '[data-change-submit]');
    expect(calls.find(call => call.route === START)?.body).toEqual({
      redirectUri: 'https://ferretry.pages.dev/oauth/mcp-callback',
    });
    expect(document.body.querySelector('[data-mcp-sign-in="waiting"]')).not.toBeNull();

    answers[LIST] = listing(mcpConnection());
    channels[0]?.deliver({ type: 'callback', id: 'hand-over', href: CALLBACK });
    await settle();
    expect(text(root, '[data-mcp-sign-in-status]')).toBe('Signed in · expires in 59m');
    await click(document.body, '[data-mcp-sign-in-done]');
    expect(document.body.querySelector('[data-mcp-sign-in]')).toBeNull();
  });

  it('shows the daemon’s sentence when a sign-in cannot start', async () => {
    const { root } = await open({
      [LIST]: listing(),
      [START]: new DaemonCallError(409, 'conflict', 'linear does not say how to sign in.'),
    });
    await click(root, '[data-change-submit]');
    expect(text(root, '[data-change-refusal]')).toBe('linear does not say how to sign in.');
    expect(document.body.querySelector('[data-mcp-sign-in]')).toBeNull();
  });

  it('asks before signing out, keeps the sign-in on Keep, and says what Sign out did', async () => {
    const answers: Answers = {
      [LIST]: listing(mcpConnection()),
      [SIGN_OUT]: { component: 'linear', removed: true, revoked: true },
    };
    const { root, calls } = await open(answers);
    await click(root, '[data-mcp-sign-out-ask]');
    expect(text(root, '[data-mcp-note="mcp-sign-out"]')).toContain(
      'Ferretry deletes the stored sign-in and asks auth.linear.example to end it.',
    );
    await click(root, '[data-mcp-sign-out-keep]');
    expect(root.querySelector('[data-mcp-note="mcp-sign-out"]')).toBeNull();
    expect(calls.some(call => call.route.startsWith('DELETE'))).toBe(false);

    await click(root, '[data-mcp-sign-out-ask]');
    answers[LIST] = listing();
    await click(root, '[data-mcp-note="mcp-sign-out"] [data-change-submit]');
    expect(text(root, '[data-mcp-sign-in-said]')).toBe(
      'Signed out of linear. The provider confirmed it ended the sign-in.',
    );
    expect(text(root, '[data-mcp-sign-in-status]')).toBe('Needs sign-in');
  });

  it('says a sign-out the provider did not confirm still deleted the sign-in, and shows a refusal', async () => {
    const answers: Answers = {
      [LIST]: listing(mcpConnection({ issuer: undefined, state: 'expired' })),
      [SIGN_OUT]: { component: 'linear', removed: true, revoked: false },
    };
    const { root } = await open(answers);
    await click(root, '[data-mcp-sign-out-ask]');
    expect(text(root, '[data-mcp-note="mcp-sign-out"]')).toContain('Ferretry deletes the stored sign-in. Runtimes');
    await click(root, '[data-mcp-note="mcp-sign-out"] [data-change-submit]');
    expect(text(root, '[data-mcp-sign-in-said]')).toBe('Signed out of linear. The stored sign-in is deleted.');

    answers[SIGN_OUT] = new DaemonCallError(403, 'grant_step_up_required', 'Unlock this machine first.');
    await click(root, '[data-mcp-sign-out-ask]');
    await click(root, '[data-mcp-note="mcp-sign-out"] [data-change-submit]');
    expect(text(root, '[data-change-refusal]')).toBe('Unlock this machine first.');
  });
});
