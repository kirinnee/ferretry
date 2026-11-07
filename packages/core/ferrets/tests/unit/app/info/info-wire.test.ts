import { describe, expect, it } from 'bun:test';
import {
  InfoReadError,
  readFerret,
  readFerrets,
  readRelaunchSettings,
  readWorktrees,
  restartFerret,
} from '../../../../app/features/info/info-wire.ts';
import { type Call, scripted } from '../support/client.ts';
import { ferretOf } from './fixtures.ts';

const rejection = async (work: Promise<unknown>): Promise<InfoReadError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(InfoReadError);
  return error as InfoReadError;
};

describe('the Info reads', () => {
  it('reads one ferret by route key from exactly the ferret asked for', async () => {
    const calls: Call[] = [];
    const client = scripted({ 'GET /v1/ferrets/:ferretId': ferretOf('f1') }, calls);
    expect(String((await readFerret(client, 'f1')).id)).toBe('f1');
    expect(calls[0]).toMatchObject({ route: 'GET /v1/ferrets/:ferretId', params: { ferretId: 'f1' } });
  });

  it('reads the ferret list, the worktrees and the relaunch dial, each parsed', async () => {
    const client = scripted({
      'GET /v1/ferrets': [ferretOf('f1'), ferretOf('f2', { parent: 'f1' })],
      'GET /v1/worktrees': { worktrees: [{ path: '/wt/a', branch: 'a', extra: 1 }], managedRoot: '/wt' },
      'GET /v1/ferrets/:ferretId/relaunch-settings': { current: false, reasons: ['settings'] },
    });
    expect((await readFerrets(client)).map(ferret => String(ferret.id))).toEqual(['f1', 'f2']);
    expect(await readWorktrees(client)).toEqual([{ path: '/wt/a', branch: 'a' }]);
    expect(await readRelaunchSettings(client, 'f1')).toEqual({ current: false, reasons: ['settings'] });
  });

  it('refuses a body this page cannot read as a failed read, not as a claim about the ferret', async () => {
    const client = scripted({
      'GET /v1/ferrets/:ferretId': { nope: true },
      'GET /v1/ferrets/:ferretId/relaunch-settings': { current: 'yes' },
    });
    expect((await rejection(readFerret(client, 'f1'))).status).toBe(502);
    expect((await rejection(readRelaunchSettings(client, 'f1'))).message).toContain('cannot read');
  });

  it('carries the daemon’s own words, status and code when a read is refused', async () => {
    const refusal = Object.assign(new Error('no ferret f9'), { status: 404, code: 'not-found' });
    const error = await rejection(readFerret(scripted({ 'GET /v1/ferrets/:ferretId': refusal }), 'f9'));
    expect(error).toMatchObject({ message: 'no ferret f9', status: 404, code: 'not-found' });
  });
});

describe('restartFerret', () => {
  const answer = (patch: Record<string, unknown>) => ({ restarted: [], queued: [], skipped: [], failed: [], ...patch });

  it('asks for this one ferret by id, and says it restarted', async () => {
    const calls: Call[] = [];
    const client = scripted({ 'POST /v1/restarts': answer({ restarted: [{ id: 'f1' }] }) }, calls);
    expect(await restartFerret(client, 'f1')).toEqual({ kind: 'restarted' });
    expect(calls[0]).toMatchObject({ route: 'POST /v1/restarts', body: { scope: 'ids', ids: ['f1'] } });
  });

  it('says a busy ferret is queued, with the daemon’s detail when it gave one', async () => {
    const queued = scripted({ 'POST /v1/restarts': answer({ queued: [{ id: 'f1', reason: 'mid-turn' }] }) });
    expect(await restartFerret(queued, 'f1')).toMatchObject({ kind: 'queued' });
    const detail = scripted({
      'POST /v1/restarts': answer({ queued: [{ id: 'f1', reason: 'in-flight', detail: 'a build is running' }] }),
    });
    expect(await restartFerret(detail, 'f1')).toEqual({ kind: 'queued', sentence: 'a build is running' });
  });

  it('throws the daemon’s reason for a failure, a skip, and a refusal', async () => {
    const failed = scripted({ 'POST /v1/restarts': answer({ failed: [{ id: 'f1', reason: 'the pane is gone' }] }) });
    expect((await rejection(restartFerret(failed, 'f1'))).message).toBe('the pane is gone');
    const skipped = scripted({ 'POST /v1/restarts': answer({ skipped: [{ id: 'f1', reason: 'not-running' }] }) });
    expect((await rejection(restartFerret(skipped, 'f1'))).message).toContain('not running');
    const refused = Object.assign(new Error('owner only'), { status: 403 });
    expect((await rejection(restartFerret(scripted({ 'POST /v1/restarts': refused }), 'f1'))).status).toBe(403);
  });
});
