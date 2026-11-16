import { describe, expect, test } from 'bun:test';
import { ferretSummary } from '@ferretry/core-ferrets/contract/testing';
import { statusOf } from '../../../contract/index.ts';

describe('the session status a ferret’s state reads as, for the interrupt’s refusals', () => {
  test('maps each lifecycle state to the status the refusals are written against', () => {
    expect(statusOf(ferretSummary({ id: 'f1', state: 'starting' }))).toBe('starting');
    expect(statusOf(ferretSummary({ id: 'f1', state: 'working' }))).toBe('running');
    expect(statusOf(ferretSummary({ id: 'f1', state: 'idle' }))).toBe('awaiting_user');
  });

  test('a stopped ferret is completed, stopped or failed by why it stopped', () => {
    const stopped = (cause?: Record<string, unknown>) =>
      statusOf(ferretSummary({ id: 'f1', state: 'stopped', ...(cause === undefined ? {} : { cause }) }));
    expect(stopped({ kind: 'completed' })).toBe('completed');
    expect(stopped()).toBe('stopped');
    expect(stopped({ kind: 'stopped' })).toBe('stopped');
    expect(stopped({ kind: 'clean_exit' })).toBe('stopped');
    expect(stopped({ kind: 'agent_crashed', exitCode: 1 })).toBe('failed');
  });
});
