import { describe, expect, it } from 'bun:test';
import {
  callbackMatchesFlow,
  callbackMessage,
  finishedMessage,
  flowState,
  issuerHost,
  MCP_OAUTH_CHANNEL,
  mcpRedirectUri,
  mcpSignInStatus,
  receivedMessage,
  signedInSentence,
  signsInWithOAuth,
} from '../../../../../src/features/fleet/components/mcp-sign-in-model.ts';
import { CALLBACK, mcpConnection, mcpFlow, NOW, OTHER_CALLBACK } from '../mcp-sign-in-support.ts';
import { component, github } from './catalog-fixture.ts';

const remote = (auth?: 'oauth') =>
  component({
    reference: 'mcp/linear',
    kind: 'mcp',
    name: 'linear',
    detail: { kind: 'mcp', url: 'https://mcp.linear.example/mcp', env: [], ...(auth === undefined ? {} : { auth }) },
  });

describe('which servers sign in', () => {
  it('is a server at a web address marked auth: oauth, and nothing else', () => {
    expect(signsInWithOAuth(remote('oauth'))).toBe(true);
    expect(signsInWithOAuth(remote())).toBe(false);
    expect(signsInWithOAuth(github)).toBe(false);
  });

  it('comes back to this PWA’s own callback page', () => {
    expect(mcpRedirectUri('https://ferretry.pages.dev')).toBe('https://ferretry.pages.dev/oauth/mcp-callback');
    expect(MCP_OAUTH_CHANNEL).toBe('ferretry-mcp-oauth');
  });
});

describe('matching a hand-over to its sign-in', () => {
  it('reads the state out of the provider link', () => {
    expect(flowState(mcpFlow())).toBe('fixture-state');
    expect(flowState({ authorizeUrl: 'https://auth.example/authorize' })).toBeUndefined();
    expect(flowState({ authorizeUrl: 'not a url' })).toBeUndefined();
  });

  it('takes only an address carrying this sign-in’s state', () => {
    expect(callbackMatchesFlow(CALLBACK, mcpFlow())).toBe(true);
    expect(callbackMatchesFlow(OTHER_CALLBACK, mcpFlow())).toBe(false);
    expect(callbackMatchesFlow('not a url', mcpFlow())).toBe(false);
    expect(callbackMatchesFlow(CALLBACK, { authorizeUrl: 'https://auth.example/authorize' })).toBe(false);
  });

  it('reads only a well-formed callback message, and answers without the address', () => {
    expect(callbackMessage({ type: 'callback', id: 'a', href: CALLBACK })).toEqual({ id: 'a', href: CALLBACK });
    expect(callbackMessage({ type: 'received', id: 'a' })).toBeUndefined();
    expect(callbackMessage({ type: 'callback', id: 1, href: CALLBACK })).toBeUndefined();
    expect(callbackMessage({ type: 'callback', id: 'a' })).toBeUndefined();
    expect(callbackMessage(null)).toBeUndefined();
    expect(callbackMessage('callback')).toBeUndefined();
    expect(receivedMessage('a')).toEqual({ type: 'received', id: 'a' });
    expect(finishedMessage('a', true)).toEqual({ type: 'finished', id: 'a', ok: true });
  });

  it('names an issuer by its host', () => {
    expect(issuerHost('https://auth.linear.example/tenant')).toBe('auth.linear.example');
    expect(issuerHost('auth.linear.example')).toBe('auth.linear.example');
  });
});

describe('where a sign-in stands', () => {
  it('says a server never signed in needs one, and offers no sign-out', () => {
    expect(mcpSignInStatus(undefined, NOW)).toEqual({
      title: 'Needs sign-in',
      detail: 'Runtimes that use this server can’t launch until you sign in.',
      tone: 'warn',
      signedInBefore: false,
      canSignOut: false,
    });
  });

  it('says a lapsed sign-in needs a new one, again, with its tokens still to sign out of', () => {
    const lapsed = mcpSignInStatus(mcpConnection({ state: 'needs-sign-in' }), NOW);
    expect(lapsed).toMatchObject({ title: 'Needs sign-in', signedInBefore: true, canSignOut: true });
    const empty = mcpSignInStatus(mcpConnection({ state: 'needs-sign-in', secrets: [], signedInAt: undefined }), NOW);
    expect(empty).toMatchObject({ signedInBefore: false, canSignOut: false });
  });

  it('tells an expiry that renews by itself from one that needs a new sign-in', () => {
    expect(mcpSignInStatus(mcpConnection({ state: 'expired' }), NOW)).toMatchObject({
      title: 'Expired · renews at next launch',
      tone: 'pend',
    });
    expect(mcpSignInStatus(mcpConnection({ state: 'expired', renewable: false }), NOW)).toMatchObject({
      title: 'Expired',
      detail: 'Sign in again so runtimes that use this server can launch.',
      tone: 'warn',
    });
  });

  it('says when a signed-in server expires: soon, today, later, never said', () => {
    expect(mcpSignInStatus(mcpConnection(), NOW)).toMatchObject({
      title: 'Signed in · expires in 59m',
      detail: 'Ferretry renews it by itself when it runs out.',
      tone: 'ok',
    });
    expect(mcpSignInStatus(mcpConnection({ expiresAt: '2026-10-16T13:00:00.000Z' }), NOW).title).toBe(
      'Signed in · expires in 3h',
    );
    expect(mcpSignInStatus(mcpConnection({ expiresAt: '2026-10-16T09:00:00.000Z' }), NOW).title).toBe(
      'Signed in · expires now',
    );
    const later = '2026-10-20T10:00:00.000Z';
    expect(mcpSignInStatus(mcpConnection({ expiresAt: later }), NOW).title).toBe(
      `Signed in · expires ${new Date(later).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
    );
    const forever = mcpSignInStatus(mcpConnection({ expiresAt: undefined, renewable: false }), NOW);
    expect(forever).toEqual({ title: 'Signed in', tone: 'ok', signedInBefore: true, canSignOut: true });
    expect(signedInSentence(mcpConnection(), NOW)).toBe('Signed in · expires in 59m.');
  });
});
