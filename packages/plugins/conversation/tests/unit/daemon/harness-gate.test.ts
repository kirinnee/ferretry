import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  HARNESS_OPEN,
  HARNESS_PENDING,
  INTERRUPT_UNAVAILABLE,
  SEND_EXTRAS_UNAVAILABLE,
  SEND_UNAVAILABLE,
} from '../../../daemon/harness-seam.ts';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the harness gate is closed by one wiring line, and this fails the day it can open', () => {
  test('the daemon is wired with HARNESS_PENDING on ONE line, and nothing else reads the gate’s values', () => {
    const wiring = read('../../../daemon/index.ts')
      .split('\n')
      .filter(line => line.startsWith('export default'));

    expect(wiring).toEqual(['export default conversationDaemon(HARNESS_PENDING);']);
    expect(HARNESS_PENDING).toEqual({ send: false, interrupt: false });
    expect(HARNESS_OPEN).toEqual({ send: true, interrupt: true });
  });

  // When this fails, Ferrets' harness seam has changed: if `deliver` now ANSWERS a closed refusal taxonomy and `interrupt`
  // presses the harness's own stop key (core/harness-refusals.md), open the gate (change the wiring line above to
  // HARNESS_OPEN), map the new refusals to today's 409 answers, and delete this file. Do not just edit the expectation.
  test('Ferrets’ harness still answers only no_pane / plugin_unavailable and a RefusalCode, and its interrupt is still the runner’s raw signal', () => {
    const port = read('../../../../../core/ferrets/contract/port.ts');

    expect(port).toContain(
      "export type HarnessRefusal = { readonly refused: RefusalCode | 'no_pane' | 'plugin_unavailable' };",
    );
    expect(port).toContain(
      "/** The harness's interrupt (the runner's `signal(handle, 'interrupt')`), as the same kind of act. */",
    );
  });

  test('the sentences say WHAT is unavailable and WHY, and name no internals', () => {
    for (const sentence of [SEND_UNAVAILABLE, INTERRUPT_UNAVAILABLE, SEND_EXTRAS_UNAVAILABLE]) {
      expect(sentence).toMatch(/not available yet/);
      expect(sentence).toMatch(/because|so a|so the|could|would/);
      expect(sentence).not.toMatch(/tmux|C-c|Escape|runner|deliver|FerretHarness|kernel|\.ts\b|503|HARNESS/i);
    }
    expect(SEND_UNAVAILABLE).toMatch(/busy.*dialog.*draft/);
    expect(INTERRUPT_UNAVAILABLE).toMatch(/quit the agent/);
  });
});
