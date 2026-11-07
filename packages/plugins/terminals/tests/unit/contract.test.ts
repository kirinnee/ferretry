import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import { fakeTerminals, terminalsConformance } from '../../contract/testing/index.ts';
import {
  SurfaceKeySchema,
  SurfaceNameSchema,
  TerminalSendInputSchema,
  TerminalWaitInputSchema,
} from '../../contract/index.ts';

const ferret = 'ferret-1' as FerretId;
terminalsConformance(
  'fakeTerminals',
  () =>
    fakeTerminals([
      {
        id: 'a1b2c3d4e5f6',
        sessionId: ferret,
        title: 'build',
        state: 'running',
        cols: 80,
        rows: 24,
        viewers: 1,
        createdAt: '2026-11-07T09:00:00.000Z',
        lastActivityAt: '2026-11-07T09:01:00.000Z',
      },
    ] as never),
  ferret,
);

describe('terminals wire', () => {
  test('a name never looks like a terminal id, and a reference prefix is read through', () => {
    expect(SurfaceNameSchema.safeParse('a1b2c3d4e5f6').success).toBe(false);
    expect(SurfaceKeySchema.parse('%terminal:build')).toBe('build');
  });
  test('a send needs text or keys; a wait waits for text or for exit, not both', () => {
    expect(TerminalSendInputSchema.safeParse({ name: 'build' }).success).toBe(false);
    expect(TerminalSendInputSchema.safeParse({ name: 'build', keys: ['enter'] }).success).toBe(true);
    expect(TerminalWaitInputSchema.safeParse({ name: 'build', text: 'ok', exit: true }).success).toBe(false);
  });
});
