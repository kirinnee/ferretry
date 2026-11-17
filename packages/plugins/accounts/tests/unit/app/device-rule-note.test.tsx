/**
 * The note under a paired device's Revoke (Access's `access.device-note` slot): how many standing sign-in rules that
 * device's passkey approved, because revoking the device suspends them. Closes input 130.
 */

import { describe, expect, it } from 'bun:test';
import { INPUT_SETTLED_SLOT } from '@ferretry/core-vault/contract';
import { ACCESS_DEVICE_NOTE_SLOT, ACCOUNTS_CONTRIBUTED_SLOTS } from '../../../contract/slots.ts';
import { DeviceRuleNote } from '../../../app/features/secure-copy/device-rule-note.tsx';
import { deviceRuleNotePanel } from '../../../app/surfaces.tsx';
import { deviceRevokeWarning } from '../../../app/lib/sign-in-rules.ts';
import manifest from '../../../manifest.ts';
import { mount } from '../../support/app/dom.ts';
import { settle } from '../../support/app/dom-form.ts';
import { refused, ruleClient } from '../../support/app/sign-in-rule-client.ts';
import { codeRule, pageRule, ruleList, suspendedRule } from '../../support/app/sign-in-rule-fixtures.ts';

const PHONE = 'fy_device_id_AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'fy_device_id_BBBBBBBBBBBBBBBBBBBBBB';

const noteFor = async (world: Parameters<typeof ruleClient>[0], deviceId: string) => {
  const { client, keys } = ruleClient(world);
  const mounted = await mount(<DeviceRuleNote client={client} deviceId={deviceId} />);
  try {
    await settle();
    return { note: mounted.container.querySelector('[data-device-rules]'), html: mounted.container.innerHTML, keys };
  } finally {
    await mounted.unmount();
  }
};

describe('the rule count under a device’s revoke', () => {
  it('says how many standing rules the device’s passkey approved, leaving out one already suspended', async () => {
    const { note } = await noteFor({ list: ruleList({ rules: [pageRule(), codeRule(), suspendedRule()] }) }, PHONE);
    expect(note?.getAttribute('data-device-rules')).toBe(PHONE);
    expect(note?.textContent).toBe(deviceRevokeWarning(2));
  });

  it('says nothing for a device whose passkey approved no rule', async () => {
    const { html } = await noteFor({ list: ruleList({ rules: [pageRule()] }) }, OTHER);
    expect(html).toBe('');
  });

  it('says nothing on a device that may not read the rules, and shows no rule', async () => {
    const { html } = await noteFor({ fail: () => refused('forbidden', { status: 403 }) }, PHONE);
    expect(html).toBe('');
  });

  it('says nothing when the rules cannot be read, rather than guess a count', async () => {
    const { html } = await noteFor({ fail: () => refused('offline') }, PHONE);
    expect(html).toBe('');
  });

  it('draws only a count: never an account, a username or a rule id', async () => {
    const { html } = await noteFor({ list: ruleList({ rules: [pageRule()] }) }, PHONE);
    expect(html).not.toContain('github work');
    expect(html).not.toContain('kirin@atomi.cloud');
  });
});

describe('the panel Accounts places in Access’s device-note slot', () => {
  it('is declared by the manifest in that slot', () => {
    expect(ACCOUNTS_CONTRIBUTED_SLOTS).toEqual([ACCESS_DEVICE_NOTE_SLOT, INPUT_SETTLED_SLOT]);
    expect((manifest.ui?.panels ?? []).map(panel => ({ slot: panel.slot, id: panel.id }))).toEqual([
      { slot: ACCESS_DEVICE_NOTE_SLOT, id: 'device-rule-note' },
      { slot: INPUT_SETTLED_SLOT, id: 'sign-in-rule-offer' },
    ]);
  });

  it('counts for the device the slot names as its subject', async () => {
    const { client } = ruleClient({ list: ruleList({ rules: [pageRule()] }) });
    const Panel = deviceRuleNotePanel(client);
    const mounted = await mount(<Panel subject={PHONE} />);
    try {
      await settle();
      expect(mounted.container.querySelector('[data-device-rules]')?.textContent).toBe(deviceRevokeWarning(1));
    } finally {
      await mounted.unmount();
    }
  });

  it('draws nothing, and reads nothing, without a subject', async () => {
    const { client, keys } = ruleClient({ list: ruleList({ rules: [pageRule()] }) });
    const Panel = deviceRuleNotePanel(client);
    const mounted = await mount(<Panel />);
    try {
      await settle();
      expect(mounted.container.innerHTML).toBe('');
      expect(keys()).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });
});
