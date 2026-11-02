/** The passkey prompt for a standing rule: what is approved is listed, and the warnings stand apart from it. */

import { describe, expect, it } from 'bun:test';
import { StepUpDialog } from '../../src/features/step-up/step-up-dialog.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  passkeyWords,
  RULE_ROOT_WARNING,
  RULE_TERMINAL_LIMIT,
  RULE_TERMINAL_RESIDUAL,
} from '../../src/lib/sign-in-rules.ts';
import { StepUpGate } from '../../src/lib/step-up-gate.ts';
import { interact, mount, must } from '../support/dom.ts';
import { machineStage, STAGE_ID, stagedRule } from '../support/sign-in-rule-fixtures.ts';

const studio = daemonConnection({
  daemonId: 'daemon-studio',
  baseUrl: 'https://studio.example',
  deviceId: 'device-one',
});

const asked = async (words: string) => {
  const gate = new StepUpGate({ ceremony: () => new Promise<void>(() => undefined), describe: () => 'unknown' });
  const mounted = await mount(<StepUpDialog gate={gate} machineName={id => `Name of ${id}`} />);
  await interact(() => void gate.require(studio, words, 'explicit', 'approve-sign-in-rule', STAGE_ID));
  await interact(async () => await Promise.resolve());
  return mounted;
};

const lines = (root: Element): string[] => [...root.querySelectorAll('li, p')].map(node => node.textContent ?? '');

describe('the passkey prompt for a terminal rule', () => {
  it('lists what is approved, and puts the root warning, the limit and the residual in a block apart', async () => {
    const mounted = await asked(passkeyWords(machineStage()));
    try {
      const summary = must(mounted.container.querySelector('[data-step-up-summary]'), 'the summary');
      const warnings = must(mounted.container.querySelector('[data-step-up-warnings]'), 'the warnings');
      expect(summary.contains(warnings)).toBe(false);
      expect(warnings.contains(summary)).toBe(false);
      expect(summary.textContent).toContain('until 2026-11-02, with no use limit');
      expect(lines(warnings)).toEqual([RULE_ROOT_WARNING, RULE_TERMINAL_LIMIT, RULE_TERMINAL_RESIDUAL]);
      expect(summary.textContent).not.toContain(RULE_TERMINAL_RESIDUAL);
      expect(summary.textContent).not.toContain(RULE_ROOT_WARNING);
    } finally {
      await mounted.unmount();
    }
  });

  it('draws no warnings block for a page rule with nothing to warn of', async () => {
    const mounted = await asked(passkeyWords(stagedRule()));
    try {
      expect(mounted.container.querySelector('[data-step-up-summary]')).not.toBeNull();
      expect(mounted.container.querySelector('[data-step-up-warnings]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
