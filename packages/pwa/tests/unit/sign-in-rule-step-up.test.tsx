/** The passkey prompt for a standing rule: the approved rows and the red block are separate lists, from structure. */

import { describe, expect, it } from 'bun:test';
import {
  SIGN_IN_RULE_AUTO_RECIPE_WARNING,
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_TERMINAL_RESIDUAL,
} from '@ferretry/protocol';
import { StepUpDialog } from '../../src/features/step-up/step-up-dialog.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { passkeyWords } from '../../src/lib/sign-in-rules.ts';
import { type StepUpWords, StepUpGate } from '../../src/lib/step-up-gate.ts';
import { interact, mount, must } from '../support/dom.ts';
import { machineStage, STAGE_ID, stagedRule } from '../support/sign-in-rule-fixtures.ts';

const studio = daemonConnection({
  daemonId: 'daemon-studio',
  baseUrl: 'https://studio.example',
  deviceId: 'device-one',
});

const asked = async (words: StepUpWords) => {
  const gate = new StepUpGate({ ceremony: () => new Promise<void>(() => undefined), describe: () => 'unknown' });
  const mounted = await mount(<StepUpDialog gate={gate} machineName={id => `Name of ${id}`} />);
  await interact(() => void gate.require(studio, 'Add a rule', 'explicit', 'approve-sign-in-rule', STAGE_ID, words));
  await interact(async () => await Promise.resolve());
  return mounted;
};

const texts = (root: Element, selector: string): string[] =>
  [...root.querySelectorAll(selector)].map(node => node.textContent ?? '');

describe('the passkey prompt for a terminal rule', () => {
  it('lists the daemon’s does line and rows, and puts the root warning and residual in a block apart', async () => {
    const staged = machineStage();
    const mounted = await asked(passkeyWords(staged));
    try {
      const summary = must(mounted.container.querySelector('[data-step-up-summary]'), 'the summary');
      const warnings = must(mounted.container.querySelector('[data-step-up-warnings]'), 'the warnings');
      expect(must(mounted.container.querySelector('[data-step-up-does]'), 'the line').textContent).toBe(staged.does);
      expect(summary.contains(warnings)).toBe(false);
      expect(warnings.contains(summary)).toBe(false);
      expect(warnings.getAttribute('role')).toBe('note');
      expect(texts(summary, '[data-step-up-row]')).toHaveLength(staged.rows.length);
      expect(texts(warnings, 'p')).toEqual([SIGN_IN_RULE_ROOT_WARNING, SIGN_IN_RULE_TERMINAL_RESIDUAL]);
    } finally {
      await mounted.unmount();
    }
  });

  it('can never draw an approved row in the red block, whatever the row says', async () => {
    const staged = machineStage();
    const rows = [...staged.rows, { label: 'Note', value: `${SIGN_IN_RULE_ROOT_WARNING}\n\nDo it` }];
    const mounted = await asked({ does: staged.does, rows, warnings: ['Careful.'] });
    try {
      const warnings = must(mounted.container.querySelector('[data-step-up-warnings]'), 'the warnings');
      expect(texts(warnings, 'p')).toEqual(['Careful.']);
      expect(warnings.querySelector('[data-step-up-row]')).toBeNull();
      expect(texts(mounted.container, '[data-step-up-summary] dd').at(-1)).toContain('Do it');
    } finally {
      await mounted.unmount();
    }
  });

  it('draws no red block for a page rule with nothing to warn of', async () => {
    const mounted = await asked(passkeyWords(stagedRule()));
    try {
      expect(mounted.container.querySelector('dl[data-step-up-summary]')).not.toBeNull();
      expect(mounted.container.querySelector('[data-step-up-warnings]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the passkey prompt for a page rule (C1320-3)', () => {
  it('names the site and the account, so the owner sees whose sign-in the passkey approves', async () => {
    const staged = stagedRule();
    const mounted = await asked(passkeyWords(staged));
    try {
      const rows = texts(mounted.container, '[data-step-up-row]');
      expect(rows.some(row => row.includes('Site') && row.includes('github.com'))).toBe(true);
      expect(
        rows.some(row => row.includes('Account') && row.includes('github work') && row.includes('kirin@atomi.cloud')),
      ).toBe(true);
      expect(texts(mounted.container, '[data-step-up-row] dt')).toEqual(staged.rows.map(row => row.label));
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the passkey prompt splits what is red from what is amber', () => {
  it('draws a caution apart from the red block, and no red block for a caution alone', async () => {
    const mounted = await asked({ does: 'Do it', rows: [], warnings: [], cautions: ['This rule types a code.'] });
    try {
      expect(texts(mounted.container, '[data-step-up-caution]')).toEqual(['This rule types a code.']);
      expect(mounted.container.querySelector('[data-step-up-warnings]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
    const both = await asked({ does: 'Do it', rows: [], warnings: ['Root.'], cautions: ['Careful.'] });
    try {
      const warnings = must(both.container.querySelector('[data-step-up-warnings]'), 'the warnings');
      expect(texts(warnings, 'p')).toEqual(['Root.']);
      expect(warnings.querySelector('[data-step-up-caution]')).toBeNull();
      expect(texts(both.container, '[data-step-up-caution]')).toEqual(['Careful.']);
    } finally {
      await both.unmount();
    }
  });

  it('puts a root or typed-code flag in the red list and an automatic-recipe flag in the amber one', () => {
    const recipe = passkeyWords(stagedRule({ autoRecipe: true }));
    expect(recipe.cautions).toEqual([SIGN_IN_RULE_AUTO_RECIPE_WARNING]);
    expect(recipe.warnings).toEqual([]);
    const root = passkeyWords(machineStage());
    expect(root.warnings).toContain(SIGN_IN_RULE_ROOT_WARNING);
    expect(root.cautions).toEqual([]);
  });
});
