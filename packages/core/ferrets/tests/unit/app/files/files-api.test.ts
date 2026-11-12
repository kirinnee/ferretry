import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  describeFsError,
  fsApi,
  fsTabAvailable,
  isAbort,
  isUnknownRoute,
  loadFsChanges,
  readFsProbe,
  resetFsProbes,
  UnreadableAnswerError,
  useFsProbe,
} from '../../../../app/features/files/files-api.ts';
import { render, runAsync } from '../support/react.ts';
import { type FsCall, type FsFixture, fsClient, refusal, scopeOf } from './support/fs-client.ts';

const setup = (fixture: FsFixture = {}) => {
  const calls: FsCall[] = [];
  const client = fsClient(() => fixture, calls);
  return { calls, client, scope: scopeOf(client, 'same/ferret') };
};

describe('files API', () => {
  it('reads through the half’s own client by route key, addressed by the ferret id and never by a URL', async () => {
    const { calls, scope } = setup();
    const listing = await fsApi.list(scope, 'src', undefined);
    expect(listing.entries).toEqual([]);
    expect(calls).toEqual([{ route: 'GET /v1/ferrets/:ferretId/fs', ferretId: 'same/ferret', query: { path: 'src' } }]);
  });

  it('sends no path for the root, `rev` for the committed copy, and `format` for the bounded bytes', async () => {
    const { calls, scope } = setup();
    await fsApi.list(scope, '', undefined);
    await fsApi.file(scope, 'a.ts', 'head', undefined);
    await fsApi.preview(scope, 'a.pdf', undefined);
    expect(calls.map(call => [call.route, call.query])).toEqual([
      ['GET /v1/ferrets/:ferretId/fs', {}],
      ['GET /v1/ferrets/:ferretId/fs/file', { rev: 'head', path: 'a.ts' }],
      ['GET /v1/ferrets/:ferretId/fs/file', { format: 'base64', path: 'a.pdf' }],
    ]);
  });

  it('uses every filesystem endpoint, parses the answers, and reads an empty diff as an empty string', async () => {
    const { scope } = setup({
      files: { 'a.ts': { path: 'a.ts' } },
      changes: { repo: true, changes: [{ path: 'fresh.ts', status: '??' }] },
      diffs: { 'a.ts': 'diff text' },
    });
    expect(await fsApi.file(scope, 'a.ts', 'head', undefined)).toMatchObject({ path: 'a.ts' });
    // An untracked row is the daemon's authoritative status, passed through unchanged.
    expect(await fsApi.changes(scope, undefined)).toEqual({
      repo: true,
      changes: [{ path: 'fresh.ts', status: '??' }],
    });
    expect(await fsApi.diff(scope, 'a.ts', undefined)).toBe('diff text');
    expect(await fsApi.diff(scope, 'b.ts', undefined)).toBe('');
  });

  it('refuses an answer that is not the shape the route declares, rather than casting it', async () => {
    const client = { call: async () => ({ entries: 'not a list' }) } as never;
    await expect(fsApi.list(scopeOf(client), '', undefined)).rejects.toBeInstanceOf(UnreadableAnswerError);
    const text = { call: async () => ({ not: 'text' }) } as never;
    await expect(fsApi.diff(scopeOf(text), 'a.ts', undefined)).rejects.toBeInstanceOf(UnreadableAnswerError);
  });

  it('drops an answer that arrives after the caller stopped waiting', async () => {
    const { scope } = setup();
    const controller = new AbortController();
    controller.abort('stopped');
    await expect(fsApi.list(scope, '', controller.signal)).rejects.toBe('stopped');
    const late = new AbortController();
    const slow = scopeOf({
      call: async () => {
        late.abort('left');
        return { root: '/work', path: '', entries: [] };
      },
    } as never);
    await expect(fsApi.list(slow, '', late.signal)).rejects.toBe('left');
  });

  it('keeps the daemon’s own refusal on what it throws', async () => {
    const { scope } = setup({ listings: { '': refusal(500, 'internal', 'HTTP 500') } });
    await expect(fsApi.list(scope, '', undefined)).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });

  it('words errors, availability and aborts as the pane needs them', () => {
    expect(isAbort(new DOMException('', 'AbortError'))).toBeTrue();
    expect(isAbort(new Error('no'))).toBeFalse();
    expect(describeFsError(new TypeError('offline'))).toBe('could not reach the daemon');
    expect(describeFsError(new Error('offline'))).toBe('offline');
    expect(describeFsError('offline')).toBe('offline');
    expect(fsTabAvailable('ready')).toBeTrue();
    expect(fsTabAvailable('error')).toBeTrue();
    expect(fsTabAvailable('absent')).toBeFalse();
    // A daemon that cannot serve the surface KEEPS the tab: the reason has to be stated somewhere, and a silently
    // missing tab states nothing.
    expect(fsTabAvailable('unsupported')).toBeTrue();
  });

  it('words a grant refusal as one, with the daemon’s own sentence after the guidance when it has one', () => {
    const bare = describeFsError(refusal(403, 'grant_not_granted', ''));
    expect(bare).toContain('switched off the project filesystem');
    expect(describeFsError(refusal(403, 'grant_not_granted', 'grant it on the host.'))).toBe(
      `${bare} grant it on the host.`,
    );
    expect(describeFsError(refusal(403, 'grant_device_not_granted', ''))).toContain(
      'this device has not been given it',
    );
    expect(describeFsError(refusal(403, 'grant_step_up_required', ''))).toContain('needs your passkey');
    expect(describeFsError(refusal(503, 'grant_undetermined', ''))).toContain('could not read its own grant document');
    // The same code on a status a grant never answers with is just a failure.
    expect(describeFsError(refusal(404, 'grant_not_granted', 'gone'))).toBe('gone');
  });

  it('reads its probe from the same record when rendered without a browser', () => {
    resetFsProbes();
    const { scope } = setup();
    const seen: string[] = [];
    const Probe = () => {
      seen.push(useFsProbe(scope).state);
      return null;
    };
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toEqual(['probing']);
  });

  it('settles on unsupported and keeps the daemon’s own reason for the disclosure', async () => {
    resetFsProbes();
    const { calls, scope } = setup({
      changes: refusal(501, 'unsupported', 'file browsing is not available on macOS yet'),
    });
    await loadFsChanges(scope);
    expect(readFsProbe(scope)).toMatchObject({
      state: 'unsupported',
      changes: null,
      error: 'file browsing is not available on macOS yet',
    });
    // Settled, not merely failed: re-asking a machine what it is spends a request to hear the same answer, so only a
    // forced refresh may repeat it.
    await loadFsChanges(scope);
    expect(calls).toHaveLength(1);
  });

  it('says a root walk that is not bound yet (503 plugin_unavailable) is unavailable on this machine, not a retry', async () => {
    resetFsProbes();
    const { scope } = setup({
      changes: refusal(503, 'plugin_unavailable', 'Not in 5.0 yet: the ferret file browser.'),
    });
    await loadFsChanges(scope);
    expect(readFsProbe(scope).state).toBe('unsupported');
  });

  it('publishes daemon-scoped probes: the same ferret id on two daemons is two records', async () => {
    resetFsProbes();
    const a = setup({ changes: { repo: true, changes: [] } });
    const b = setup({ changes: refusal(403, 'grant_not_granted', '') });
    const sameIdOnB = scopeOf(b.client, 'same/ferret');
    await loadFsChanges(a.scope);
    await loadFsChanges(sameIdOnB);
    expect(readFsProbe(a.scope).state).toBe('ready');
    expect(readFsProbe(sameIdOnB).state).toBe('error');
  });

  it('publishes probes and exposes the subscribed hook snapshot', async () => {
    resetFsProbes();
    const fixture: FsFixture = { changes: { repo: true, changes: [] } };
    const calls: FsCall[] = [];
    const scope = scopeOf(
      fsClient(() => fixture, calls),
      'w',
    );
    await loadFsChanges(scope);
    expect(readFsProbe(scope)).toMatchObject({ state: 'ready', refreshing: false });
    await loadFsChanges(scope);
    expect(calls).toHaveLength(1);
    let probe!: ReturnType<typeof useFsProbe>;
    const Probe = () => {
      probe = useFsProbe(scope);
      return null;
    };
    render(createElement(Probe));
    await runAsync(async () => {
      probe.refresh();
      await Promise.resolve();
    });
    expect(probe.state).toBe('ready');
    fixture.changes = refusal(404, 'unknown_route', 'no such route') as never;
    await loadFsChanges(scope, true);
    expect(readFsProbe(scope).state).toBe('absent');
    expect(isUnknownRoute({})).toBeFalse();
    fixture.changes = refusal(403, 'forbidden', 'denied') as never;
    await loadFsChanges(scope, true);
    expect(readFsProbe(scope)).toMatchObject({ state: 'error', error: 'denied' });
  });
});
