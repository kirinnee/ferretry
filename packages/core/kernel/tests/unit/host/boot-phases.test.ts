import { describe, expect, test } from 'bun:test';
import { createBootPhases } from '../../../host/boot-phases.ts';

/** A stand-in clock: every read answers the next time in the list, so a test says exactly how long each phase took. */
function steppedClock(times: readonly number[]): () => number {
  let index = 0;
  return () => {
    const at = times[Math.min(index, times.length - 1)] as number;
    index += 1;
    return at;
  };
}

describe('boot phase timings', () => {
  test('the line lists the phases in boot order with their durations, and the total', () => {
    const trace: string[] = [];
    // One read per mark, then one at the line: the phase lasts until the next read.
    const phases = createBootPhases(
      steppedClock([0, 2, 3, 10, 1_234, 1_240, 7_240, 7_800, 7_801, 7_830, 7_831, 11_000]),
      trace,
    );
    for (const label of [
      'home',
      'lock',
      'identity',
      'config',
      'check',
      'state:ferrets',
      'build:ferrets',
      'bind',
      'snapshot',
      'listen',
      'jobs',
    ])
      phases.mark(label);
    expect(phases.line(new Set(['ferrets']))).toBe(
      'boot phases: home 2ms, lock 1ms, identity 7ms, config 1224ms, check 6ms, ' +
        'state 6000ms (state:ferrets 6000ms), build 560ms (build:ferrets 560ms), bind 1ms, snapshot 29ms, listen 1ms, ' +
        'jobs 3169ms; total 11000ms',
    );
    // The recorder is also the boot trace: one spelling for a phase.
    expect(trace).toEqual([
      'home',
      'lock',
      'identity',
      'config',
      'check',
      'state:ferrets',
      'build:ferrets',
      'bind',
      'snapshot',
      'listen',
      'jobs',
    ]);
  });

  test('a repeated phase is a total, and only the slowest three plugins are named', () => {
    const phases = createBootPhases(steppedClock([0, 10, 510, 560, 1_560, 1_660, 1_760]), []);
    for (const label of ['state:a', 'state:b', 'state:c', 'state:d', 'state:a', 'build:b']) phases.mark(label);
    // a = 10 + 100, b = 500, c = 50, d = 1000, build:b = 100 (to the line).
    expect(phases.line(new Set(['a', 'b', 'c', 'd']))).toBe(
      'boot phases: state 1660ms (state:d 1000ms, state:b 500ms, state:a 110ms), build 100ms (build:b 100ms); total 1760ms',
    );
  });

  test('a phase labelled with a path, an account or a runtime is counted by its kind and never printed', () => {
    const phases = createBootPhases(steppedClock([0, 100, 200, 300, 400, 500, 600, 700]), []);
    for (const label of [
      'state:/home/kirin/.ferretry/fleet/homes/b52b4b30',
      'build:kirin@durian.cloud',
      'beforeListen:claude-llm2',
      'carrier:https://example.invalid/tunnel?token=abc',
      'config:/home/kirin/.claude-kirin/settings.json',
      'runtime:claude-llm2',
    ])
      phases.mark(label);
    const line = phases.line(new Set(['ferrets']));
    expect(line).toBe(
      'boot phases: state 100ms, build 100ms, beforeListen 100ms, carrier 100ms, config 100ms, other 100ms; total 600ms',
    );
    for (const leaked of ['/home', 'kirin', 'durian', 'claude', 'llm2', 'token', 'example', '@'])
      expect(line).not.toContain(leaked);
  });

  test('a plugin the host does not hold is not named, though its time still counts', () => {
    const phases = createBootPhases(steppedClock([0, 40, 100]), []);
    phases.mark('state:mine');
    phases.mark('state:stranger');
    expect(phases.line(new Set(['mine']))).toBe('boot phases: state 100ms (state:mine 40ms); total 100ms');
  });

  test('a carrier is named from the kernel vocabulary only', () => {
    const phases = createBootPhases(steppedClock([0, 5, 9]), []);
    phases.mark('carrier:relay');
    phases.mark('carrier:somebody');
    expect(phases.line(new Set())).toBe('boot phases: carrier 9ms (carrier:relay 5ms); total 9ms');
  });

  test('a mark after the line extends the trace only', () => {
    const trace: string[] = [];
    const phases = createBootPhases(steppedClock([0, 10]), trace);
    phases.mark('jobs');
    const first = phases.line(new Set());
    phases.mark('carrier:relay');
    expect(trace).toEqual(['jobs', 'carrier:relay']);
    expect(first).toBe('boot phases: jobs 10ms; total 10ms');
  });

  test('a clock that steps back never prints a negative duration, and an empty boot still has a line', () => {
    const backwards = createBootPhases(steppedClock([50, 20, 10]), []);
    backwards.mark('home');
    backwards.mark('lock');
    expect(backwards.line(new Set())).toBe('boot phases: home 0ms, lock 0ms; total 0ms');
    expect(createBootPhases(() => 0, []).line(new Set())).toBe('boot phases: ; total 0ms');
  });
});
