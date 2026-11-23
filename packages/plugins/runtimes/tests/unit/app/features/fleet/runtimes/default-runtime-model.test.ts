import { describe, expect, it } from 'bun:test';
import { type Instant, InstantSchema } from '@ferretry/std';
import {
  defaultOptionLabel,
  isDefaultRuntime,
  keepDefaultLabel,
  runtimeStateWords,
} from '../../../../../../app/features/fleet/runtimes/default-runtime-model.ts';
import { machine, runtime } from '../account-support.ts';

const at = (value: string): Instant => InstantSchema.parse(value);

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
    const until = runtime({ name: 'a', disabled: { source: 'runtime', until: at('2026-11-04T00:00:00.000Z') } });
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
  it('names the runtime only and says what is kept', () => {
    const agent = runtime({ name: 'agent' });
    expect(defaultOptionLabel(agent, [agent], new Map())).toBe('agent');
    expect(isDefaultRuntime(machine({ defaultRuntime: 'agent' }), agent)).toBe(true);
    expect(isDefaultRuntime(null, agent)).toBe(false);
    expect(keepDefaultLabel('agent')).toBe('Keep agent');
    expect(keepDefaultLabel(null)).toBe('Keep automatic');
  });
});
