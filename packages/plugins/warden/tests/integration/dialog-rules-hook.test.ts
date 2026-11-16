/**
 * The Warden's built-in dialog rules come from the harness plugins, over the REAL host: a plugin standing where Claude Code
 * stands takes `warden.dialog-rules.claude:dialog-rules`, and `GET /v1/warden/dialog/rules` lists what it provided — a
 * valid rule, never one that picks a granting row — while Codex, which provides nothing here, contributes none.
 */
import { expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { type DialogRule, type DialogRulesView, WardenDialogRulesClaude } from '../../contract/index.ts';
import { fakeLogins, sampleLogin } from '../../../logins/contract/testing/index.ts';
import { FakeVault } from '../../../../core/vault/contract/testing/index.ts';
import warden from '../../daemon/index.ts';

const declines: DialogRule = {
  id: 'claude-fake',
  harness: 'claude',
  kind: 'other',
  title: '^a fake screen$',
  action: { choose: 'No, not now' },
};
const grants: DialogRule = { ...declines, id: 'claude-grants', action: { choose: 'Yes, always allow' } };

const claudeCode = implementDaemon(
  definePlugin({
    id: 'claude-code',
    title: 'Claude Code (fake)',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    hooks: { takes: [{ hook: WardenDialogRulesClaude, key: 'dialog-rules' }] },
  }),
  {
    build: () => ({ hooks: { 'warden.dialog-rules.claude:dialog-rules': { rules: [declines, grants] } } }),
  },
);

test('the Warden lists the built-in rules a harness plugin provides, and refuses a rule that grants', async () => {
  const host = await testHost({
    plugins: [warden, claudeCode],
    fakes: {
      ferrets: new FakeFerrets(),
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
      vault: new FakeVault(),
      asks: new FakeAsks(),
    },
  });
  try {
    const view = (await host.request('GET', '/v1/warden/dialog/rules')).json<DialogRulesView>();
    expect(view.builtIn.map(rule => rule.id)).toEqual(['claude-fake']);
    expect(view.builtIn[0]?.does).toBe('chooses “No, not now”');
  } finally {
    await host.stop();
  }
});
