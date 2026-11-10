import { expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import { ferretId } from '../../../../contract/testing/index.ts';
import { ListSessionsController } from '../../../../cli/lib/session/ps-controller.ts';
import { RenameSessionController } from '../../../../cli/lib/session/rename-controller.ts';
import { RevokeCredentialController } from '../../../../cli/lib/session/revoke-credential.ts';
import { SignalSessionController } from '../../../../cli/lib/session/signal-controller.ts';
import { renderSubtreeTable } from '../../../../cli/lib/session/subtree-table.ts';
import { capturedPresenter, RecordingApi } from './controller-doubles.ts';

const PLAIN = { amber: (cell: string) => cell };

test('fy ps with nothing to show says why in words and leaves the table out', async () => {
  const { io, presenter } = capturedPresenter();
  await new ListSessionsController(new RecordingApi({ list: [] }), presenter, PLAIN).execute();
  expect(io.out).toEqual(['no ferrets']);
  expect(io.reported).toEqual([]);
});

test('fy rename --json answers the renamed ferret as JSON and prints no sentence', async () => {
  const api = new RecordingApi();
  const { io, presenter } = capturedPresenter();
  await new RenameSessionController(api, presenter).execute('wren', 'ash', { json: true });
  expect(io.out).toHaveLength(1);
  expect(JSON.parse(io.out[0] ?? '{}')).toMatchObject({ id: 'wren', name: 'ash' });
});

test('fy session revoke-credential --json answers the revocation as JSON and asks no state', async () => {
  const asked: string[] = [];
  const { io, presenter } = capturedPresenter();
  await new RevokeCredentialController(
    {
      revoke: async () => ({ id: 'lead', revoked: true }),
      state: async session => {
        asked.push(session);
        return 'working';
      },
    },
    presenter,
    'fy',
  ).execute('wren', { json: true });
  expect(JSON.parse(io.out[0] ?? '{}')).toEqual({ id: 'lead', revoked: true });
  expect(asked).toEqual([]);
});

test('fy session revoke-credential on a ferret with no live credential and a stopped pane says both plainly', async () => {
  const { io, presenter } = capturedPresenter();
  await new RevokeCredentialController(
    { revoke: async () => ({ id: 'lead', revoked: false }), state: async () => 'stopped' },
    presenter,
    'fy',
  ).execute('wren');
  expect(io.out).toEqual([
    'lead held no live credential; none is issued to it from now on',
    'no restart or resume gives it a credential again until a person resumes it: fy resume lead',
    'it is stopped',
  ]);
});

test('fy signal --json answers the daemon answer as JSON', async () => {
  const api = new RecordingApi({ signal: {} });
  const { io, presenter } = capturedPresenter();
  await new SignalSessionController(api, presenter, {}).execute('done', undefined, { session: 'wren', json: true });
  expect(JSON.parse(io.out[0] ?? 'null')).toEqual({});
});

test('fy signal waiting fails loudly when the daemon accepts it but declares no wait', async () => {
  const api = new RecordingApi({ signal: {} });
  const { io, presenter } = capturedPresenter();
  await expect(
    new SignalSessionController(api, presenter, {}).execute('waiting', undefined, { session: 'wren' }),
  ).rejects.toThrow('daemon accepted waiting but returned no declared-wait state');
  expect(io.out).toEqual([]);
});

test('a subtree table with no clock shows an ended helper with its own end instant', () => {
  const lines = renderSubtreeTable(
    {
      root: { id: ferretId('lead'), name: 'wren' },
      at: '2026-11-06T09:00:00.000Z' as Instant,
      endedWindowMs: 7_200_000,
      rows: [
        {
          id: ferretId('kid'),
          name: 'ash',
          depth: 1,
          state: 'ended',
          ferretState: 'stopped',
          endedAt: '2026-11-06T08:30:00.000Z',
        },
      ],
    },
    undefined,
  );
  expect(lines[0]).toBe('wren (lead): 1 descendant');
  expect(lines[2]).toContain('ended 2026-11-06T08:30:00.000Z');
});
