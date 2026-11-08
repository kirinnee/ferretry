import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PANE_NOT_READY_REASONS } from '@ferretry/core-ferrets/contract';
import {
  HARNESS_OPEN,
  INTERRUPT_UNAVAILABLE,
  NOT_READY_SENTENCES,
  SEND_EXTRAS_UNAVAILABLE,
  SEND_UNAVAILABLE,
  STRANDED_SENTENCE,
  UNCONFIRMED_SENTENCE,
} from '../../../daemon/harness-seam.ts';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Words no answer of the seam may carry: the machinery, never the person's words. */
const INTERNALS = /tmux|C-c|Escape|runner|deliver|FerretHarness|kernel|\.ts\b|503|409|HARNESS|session \S+ pane/i;

describe('the harness gate is OPEN, and the mapping it opened on cannot drift from Ferrets’ seam unnoticed', () => {
  test('the daemon is wired with HARNESS_OPEN on ONE line', () => {
    const wiring = read('../../../daemon/index.ts')
      .split('\n')
      .filter(line => line.startsWith('export default'));

    expect(wiring).toEqual(['export default conversationDaemon(HARNESS_OPEN);']);
    expect(HARNESS_OPEN).toEqual({ send: true, interrupt: true });
  });

  // When this fails, Ferrets' harness seam has changed. Re-read `deliveryAnswer` and the interrupt's `refusalAnswer` in
  // daemon/harness-seam.ts (and the session-layer refusals in daemon/delivery/lib/interrupt.ts) against the new surface,
  // answer every new kind there, then move these pins. Do not just edit the expectation.
  test('Ferrets’ deliver, queue and interrupt answer exactly the taxonomy Conversation maps', () => {
    const port = read('../../../../../core/ferrets/contract/port.ts');
    const kinds = read('../../../../../core/ferrets/contract/kinds.ts');

    for (const line of [
      "export type HarnessRefusal = { readonly refused: RefusalCode | 'no_pane' | 'plugin_unavailable' };",
      [
        'export type HarnessDeliveryRefusal =',
        '  | HarnessRefusal',
        "  | { readonly refused: 'not_ready'; readonly why: PaneNotReadyReason }",
        "  | { readonly refused: 'composer_occupied'; readonly draft: string }",
        "  | { readonly refused: 'composer_unreadable' };",
      ].join('\n'),
      [
        'export interface HarnessUnconfirmed {',
        '  readonly unconfirmed: true;',
        '  readonly stranded: boolean;',
        '}',
      ].join('\n'),
      'export type HarnessDeliveryFailure = HarnessDeliveryRefusal | HarnessUnconfirmed;',
      [
        'export interface HarnessInterrupted {',
        '  readonly pressed: boolean;',
        '  readonly working?: boolean;',
        '}',
      ].join('\n'),
      '  deliver(delivery: RunnerDelivery): Promise<Result<DeliveryOutcome, HarnessDeliveryFailure>>;',
      '  queue(text: string): Promise<Result<QueueOutcome, HarnessDeliveryFailure>>;',
      '  interrupt(): Promise<Result<HarnessInterrupted, HarnessRefusal>>;',
    ])
      expect(port).toContain(line);
    expect(kinds).toContain("export type DeliveryOutcome = 'turn-started' | 'handled-local';");
    expect(kinds).toContain("export const PANE_NOT_READY_REASONS = ['busy', 'dialog', 'exited'] as const;");
  });

  test('every reason a pane is not ready has its ONE fixed sentence, and no other reason has one', () => {
    expect(Object.keys(NOT_READY_SENTENCES).sort()).toEqual([...PANE_NOT_READY_REASONS].sort());
    for (const why of PANE_NOT_READY_REASONS) {
      expect(NOT_READY_SENTENCES[why]).toMatch(/nothing was typed/);
      expect(NOT_READY_SENTENCES[why]).not.toMatch(INTERNALS);
    }
    // Each says its own remedy: the three are not one sentence with a word swapped.
    expect(new Set(Object.values(NOT_READY_SENTENCES)).size).toBe(PANE_NOT_READY_REASONS.length);
    expect(NOT_READY_SENTENCES.busy).toMatch(/once its turn ends/);
    expect(NOT_READY_SENTENCES.dialog).toMatch(/answer the prompt on its screen/);
    expect(NOT_READY_SENTENCES.exited).toMatch(/revive the ferret/);
  });

  test('a typed send that nothing proved says it was not typed again, and names no internals', () => {
    for (const sentence of [UNCONFIRMED_SENTENCE, STRANDED_SENTENCE]) {
      expect(sentence).toMatch(/was typed into the agent's box/);
      expect(sentence).toMatch(/not typed again/);
      expect(sentence).not.toMatch(INTERNALS);
    }
    expect(STRANDED_SENTENCE).toMatch(/stayed there after Enter/);
  });

  test('the closed-gate sentences say WHAT is unavailable and WHY, and name no internals', () => {
    for (const sentence of [SEND_UNAVAILABLE, INTERRUPT_UNAVAILABLE, SEND_EXTRAS_UNAVAILABLE]) {
      expect(sentence).toMatch(/not available yet/);
      expect(sentence).toMatch(/because|so a|so the|could|would/);
      expect(sentence).not.toMatch(INTERNALS);
    }
    expect(SEND_UNAVAILABLE).toMatch(/busy.*dialog.*draft/);
    expect(INTERRUPT_UNAVAILABLE).toMatch(/quit the agent/);
    expect(SEND_EXTRAS_UNAVAILABLE).toMatch(/fyi/);
  });
});
