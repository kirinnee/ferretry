import { describe, expect, test } from 'bun:test';
import {
  AgendaClearAgentsResultSchema,
  AgendaConfigSchema,
  AgendaModePatchSchema,
  AgendaOpenQuerySchema,
  BuzzRecordSchema,
  DaemonAgendaActionSchema,
  SeenFileSchema,
} from '../../contract/index.ts';

describe('agenda wire schemas', () => {
  test('mode patch and clear result are strict', () => {
    expect(AgendaModePatchSchema.safeParse({ enabled: true, extra: 1 }).success).toBe(false);
    expect(AgendaClearAgentsResultSchema.safeParse({ cleared: 1, ferrets: 1 }).success).toBe(true);
    expect(AgendaClearAgentsResultSchema.safeParse({ cleared: 1, sessions: 1 }).success).toBe(false);
  });
  test('the roll-up page limit is bounded', () => {
    expect(AgendaOpenQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(AgendaOpenQuerySchema.safeParse({ limit: 500, after: 'x' }).success).toBe(true);
  });
  test('the daemon agenda takes only the owner’s four verbs', () => {
    expect(DaemonAgendaActionSchema.safeParse({ action: 'dismiss', ask: 'a1' }).success).toBe(true);
    expect(DaemonAgendaActionSchema.safeParse({ action: 'raise', ask: 'a1' }).success).toBe(false);
  });
  test('stored files start at format 1 and the config defaults are on with a 3 hour warning', () => {
    expect(SeenFileSchema.safeParse({ format: 1, seen: {} }).success).toBe(true);
    expect(SeenFileSchema.safeParse({ format: 2, seen: {} }).success).toBe(false);
    expect(AgendaConfigSchema.parse({})).toEqual({ agendaMode: true, agendaNudge: true, deadlineWarnHours: 3 });
    const line = {
      format: 1,
      key: 'stop:f1',
      at: '2026-11-07T09:00:00.000Z',
      kind: 'stopped',
      title: 't',
      enrolled: 1,
    };
    expect(BuzzRecordSchema.safeParse(line).success).toBe(true);
    expect(BuzzRecordSchema.safeParse({ ...line, endpoint: 'https://x' }).success).toBe(false);
  });
});

import { agendaConformance, fakeAgenda } from '../../contract/testing/index.ts';

agendaConformance('fakeAgenda', () => fakeAgenda({ agendaOf: { f1: 2, f2: 0 } }));
