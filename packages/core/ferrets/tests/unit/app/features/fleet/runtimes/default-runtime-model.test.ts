import { describe, expect, it } from 'bun:test';
import {
  agentRuntimes,
  defaultOptionLabel,
  isDefaultRuntime,
  keepDefaultLabel,
  runtimeStateWords,
} from '../../../../../src/features/fleet/runtimes/default-runtime-model.ts';
import { machine, runtime } from '../account-support.ts';

describe('runtimeStateWords', () => {
  it('says the login word of a runtime that is fine', () => {
    expect(runtimeStateWords(runtime({ name: 'a' }), machine())).toBe('ready');
    expect(
      runtimeStateWords(
        runtime({ name: 'a', credential: { id: 'x', store: 'host', status: 'refresh_due' } }),
        machine(),
      ),
    ).toBe('refresh due');
    expect(runtimeStateWords(runtime({ name: 'a', credential: { id: 'x', store: 'host' } }), machine())).toBe(
      'checking',
    );
  });

  it('says a switch-off first, with the day it ends when there is one', () => {
    const off = runtime({ name: 'a', disabled: { source: 'login' } });
    const until = runtime({ name: 'a', disabled: { source: 'runtime', until: '2026-11-04T00:00:00.000Z' } });
    expect(runtimeStateWords(off, machine())).toBe('switched off');
    expect(runtimeStateWords(until, machine())).toBe('switched off until 4 Nov 2026');
  });

  it('says a missing CLI before the login word, and reads a machine that has not answered as installed', () => {
    const codex = runtime({ name: 'a', harness: 'codex' });
    const noCodex = machine({ tools: [{ harness: 'codex', label: 'Codex', installed: false }] });
    expect(runtimeStateWords(codex, noCodex)).toBe('Codex not installed');
    expect(runtimeStateWords(codex, null)).toBe('ready');
  });
});

describe('the control’s words', () => {
  it('joins name and state, keeps only agent runtimes, and says what is kept', () => {
    const plain = runtime({ name: 'plain' });
    const agent = runtime({ name: 'agent', agent: true });
    expect(defaultOptionLabel(agent, machine())).toBe('agent · ready');
    expect(agentRuntimes([plain, agent])).toEqual([agent]);
    expect(isDefaultRuntime(machine({ defaultRuntime: 'agent' }), agent)).toBe(true);
    expect(isDefaultRuntime(null, agent)).toBe(false);
    expect(keepDefaultLabel('agent')).toBe('Keep agent');
    expect(keepDefaultLabel(null)).toBe('Keep automatic');
  });
});
