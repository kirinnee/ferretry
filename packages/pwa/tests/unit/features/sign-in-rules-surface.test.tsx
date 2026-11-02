/** Settings › Secure copy › Standing sign-in rules: a machine's staged rule, and what the owner does with each rule. */

import { describe, expect, it } from 'bun:test';
import { MachineRuleStage, SignInRulesSurface } from '../../../src/features/secure-copy/sign-in-rules-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULE_TERMINAL_RESIDUAL,
  SIGN_IN_RULE_TOTP_WARNING,
} from '@ferretry/protocol';
import { mount, must } from '../../support/dom.ts';
import { click, settle } from '../../support/dom-form.ts';
import { type RuleWorld, refused, ruleClient } from '../../support/sign-in-rule-client.ts';
import {
  codeRule,
  machineStage,
  pageRule,
  RULE_ID,
  ruleList,
  STAGE_ID,
  stagedRule,
  suspendedRule,
} from '../../support/sign-in-rule-fixtures.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' });
const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);

const surface = (world: RuleWorld, askPasskey: (() => Promise<boolean>) | null = async () => true) => {
  const fake = ruleClient(world);
  return {
    fake,
    element: (
      <SignInRulesSurface
        askPasskey={askPasskey ?? undefined}
        connection={connection}
        createClient={async () => fake.client}
        pollMs={60_000}
      />
    ),
  };
};

describe('a machine’s staged rule', () => {
  const stage = (
    staged: Parameters<typeof MachineRuleStage>[0]['staged'],
    phase: Parameters<typeof MachineRuleStage>[0]['phase'],
  ) => (
    <MachineRuleStage
      canUsePasskey
      onConfirm={() => undefined}
      onDeny={() => undefined}
      phase={phase}
      staged={staged}
    />
  );

  it('draws the plain line, the rows and ONE red block from the root flag', async () => {
    const staged = machineStage();
    const mounted = await mount(stage(staged, { kind: 'idle' }));
    try {
      expect(q(mounted.container, '[data-rule-does]').textContent).toBe(staged.does);
      expect(mounted.container.querySelectorAll('[data-rule-row]')).toHaveLength(staged.rows.length);
      const red = q(mounted.container, '[data-rule-warnings]');
      expect(red.getAttribute('role')).toBe('note');
      expect([...red.querySelectorAll('p')].map(p => p.textContent)).toEqual([
        SIGN_IN_RULE_ROOT_WARNING,
        SIGN_IN_RULE_TERMINAL_RESIDUAL,
      ]);
      expect(red.querySelector('[data-rule-row]')).toBeNull();
      expect(q(mounted.container, '[data-rule-checked] summary').textContent).toBe('How it’s checked');
      expect(q(mounted.container, '[data-rule-machine]').textContent).toBe(
        'A machine asked for this rule at 2026-11-01 09:55 UTC',
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('draws the one-factor flag from the code flag and no root sentences for a page rule', async () => {
    const mounted = await mount(stage(stagedRule({ totp: true, fields: ['password', 'totp'] }), { kind: 'idle' }));
    try {
      expect(q(mounted.container, '[data-rule-flag="one-factor"]').textContent).toBe(SIGN_IN_RULE_TOTP_WARNING);
      expect(mounted.container.querySelector('[data-rule-flag="root"]')).toBeNull();
      expect(q(mounted.container, '[data-rule-machine]').textContent).toBe('A machine asked for this rule');
    } finally {
      await mounted.unmount();
    }
  });

  it('shows each step while it works, with both buttons off', async () => {
    const mounted = await mount(stage(machineStage(), { kind: 'working', progress: 'passkey' }));
    try {
      expect(q(mounted.container, '[data-rule-progress]').textContent).toBe('Waiting for your passkey…');
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-machine-confirm]').disabled).toBe(true);
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-machine-deny]').disabled).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });

  it('says a dismissed passkey approved nothing, and shows a failure’s words', async () => {
    const dismissed = await mount(stage(machineStage(), { kind: 'dismissed' }));
    try {
      expect(q(dismissed.container, '[data-rule-dismissed]').textContent).toContain('nothing was approved');
    } finally {
      await dismissed.unmount();
    }
    const failed = await mount(stage(machineStage(), { kind: 'failed', words: 'that stage is gone' }));
    try {
      expect(q(failed.container, '[data-rule-failure]').textContent).toBe('that stage is gone');
    } finally {
      await failed.unmount();
    }
  });
});

describe('Settings › Standing sign-in rules', () => {
  it('says every sign-in asks when there is no rule and no stage', async () => {
    const { element } = surface({});
    const mounted = await mount(element);
    try {
      await settle();
      expect(q(mounted.container, '[data-sign-in-rules-empty]').textContent).toContain('Every sign-in asks you');
    } finally {
      await mounted.unmount();
    }
  });

  it('says why when the client cannot be made', async () => {
    const mounted = await mount(
      <SignInRulesSurface
        connection={connection}
        createClient={async () => {
          throw new Error('no daemon here');
        }}
        pollMs={60_000}
      />,
    );
    try {
      await settle();
      expect(q(mounted.container, '[data-sign-in-rules-error]').textContent).toContain('no daemon here');
    } finally {
      await mounted.unmount();
    }
  });

  it('takes a machine’s stage, asks the passkey for it, commits and reads the list again', async () => {
    const asked: string[] = [];
    const { fake, element } = surface(
      { list: ruleList({ stages: [machineStage()] }), staged: machineStage() },
      async () => {
        asked.push('passkey');
        return true;
      },
    );
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-machine-confirm]'));
      await settle();
      expect(fake.keys()).toEqual([
        'GET /v1/sign-in-rules',
        `POST /v1/sign-in-rules/stages/${STAGE_ID}/bind`,
        `POST /v1/sign-in-rules/stages/${STAGE_ID}/commit`,
        'GET /v1/sign-in-rules',
      ]);
      expect(asked).toEqual(['passkey']);
    } finally {
      await mounted.unmount();
    }
  });

  it('drops a stage whose passkey was dismissed, commits nothing and says so', async () => {
    const { fake, element } = surface(
      { list: ruleList({ stages: [machineStage()] }), staged: machineStage() },
      async () => false,
    );
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-machine-confirm]'));
      await settle();
      expect(q(mounted.container, '[data-rule-dismissed]')).toBeTruthy();
      expect(fake.keys()).toContain(`DELETE /v1/sign-in-rules/stages/${STAGE_ID}`);
      expect(fake.keys().some(key => key.endsWith('/commit'))).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('says the daemon’s refusal under the stage when taking it fails', async () => {
    const { element } = surface({
      list: ruleList({ stages: [machineStage()] }),
      fail: key => (key.endsWith('/bind') ? refused('someone else took it') : undefined),
    });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-machine-confirm]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe('someone else took it');
    } finally {
      await mounted.unmount();
    }
  });

  it('cannot confirm a machine’s stage on a device with no passkey, but can deny it', async () => {
    const { fake, element } = surface({ list: ruleList({ stages: [machineStage()] }) }, null);
    const mounted = await mount(element);
    try {
      await settle();
      expect(q<HTMLButtonElement>(mounted.container, '[data-rule-machine-confirm]').disabled).toBe(true);
      await click(q(mounted.container, '[data-rule-machine-deny]'));
      await settle();
      expect(fake.keys()).toContain(`DELETE /v1/sign-in-rules/stages/${STAGE_ID}`);
    } finally {
      await mounted.unmount();
    }
  });

  it('leaves the stage on screen when dropping it fails', async () => {
    const { element } = surface({
      list: ruleList({ stages: [machineStage()] }),
      fail: key => (key.startsWith('DELETE') ? refused('could not drop it') : undefined),
    });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-machine-deny]'));
      await settle();
      expect(q(mounted.container, '[data-rule-stage]').getAttribute('data-rule-stage')).toBe(STAGE_ID);
    } finally {
      await mounted.unmount();
    }
  });

  it('narrows a rule and reads the list again', async () => {
    const { fake, element } = surface({ list: ruleList({ rules: [codeRule()] }) });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-narrow]'));
      await click(q(mounted.container, '[data-rule-drop-totp]'));
      await click(q(mounted.container, '[data-rule-narrow-apply]'));
      await settle();
      expect(fake.calls.find(call => call.key.endsWith('/narrow'))?.body).toEqual({ dropTotp: true });
      expect(fake.keys().filter(key => key === 'GET /v1/sign-in-rules')).toHaveLength(2);
    } finally {
      await mounted.unmount();
    }
  });

  it('revokes a rule, and shows the refusal on that rule’s card when it fails', async () => {
    let refuse = true;
    const { fake, element } = surface({
      list: ruleList({ rules: [pageRule()] }),
      fail: key => (key.startsWith('DELETE') && refuse ? refused('could not revoke') : undefined),
    });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-revoke]'));
      await settle();
      expect(q(mounted.container, '[data-rule-failure]').textContent).toBe('could not revoke');
      refuse = false;
      await click(q(mounted.container, '[data-rule-revoke]'));
      await settle();
      expect(fake.keys()).toContain(`DELETE /v1/sign-in-rules/${RULE_ID}`);
      expect(mounted.container.querySelector('[data-rule-failure]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('approves a suspended rule again with the rule it replaces, then closes the sheet', async () => {
    const { fake, element } = surface({ list: ruleList({ rules: [suspendedRule()] }) });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-resume]'));
      await settle();
      expect(q(mounted.container, '[data-rule-sheet]').getAttribute('data-rule-origin')).toBe('resume');
      await click(q(mounted.container, '[data-rule-approve]'));
      await settle();
      expect(fake.calls.find(call => call.key === 'POST /v1/sign-in-rules/stages')?.body).toMatchObject({
        replaces: RULE_ID,
      });
      expect(mounted.container.querySelector('[data-rule-sheet]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('closes the approve-again sheet on Cancel without staging anything', async () => {
    const { fake, element } = surface({ list: ruleList({ rules: [pageRule({ status: 'expired' })] }) });
    const mounted = await mount(element);
    try {
      await settle();
      await click(q(mounted.container, '[data-rule-renew]'));
      await settle();
      await click(q(mounted.container, '[data-rule-cancel]'));
      expect(mounted.container.querySelector('[data-rule-sheet]')).toBeNull();
      expect(fake.keys().some(key => key === 'POST /v1/sign-in-rules/stages')).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });
});
