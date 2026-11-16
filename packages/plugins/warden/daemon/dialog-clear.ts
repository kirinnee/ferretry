import type { ConfigPort } from '@ferretry/kernel/contract';
import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import { type DialogRule, WARDEN_DIALOG_RULES } from '../contract/dialog-rules.ts';
import { CLAUDE_DIALOG_RULES, CODEX_DIALOG_RULES, type ClearFrame, type DialogClearPorts } from './lib/index.ts';

/**
 * The rules in effect: the built-in tables, then the ones the owner taught (`config/warden-dialogs.yaml`, the version
 * in effect — a held or broken edit is not read). A built-in rule wins a tie, so a taught rule never overrides one.
 */
export function dialogRulesInEffect(config: Pick<ConfigPort, 'file'>): () => Promise<readonly DialogRule[]> {
  return async () => [
    ...CLAUDE_DIALOG_RULES,
    ...CODEX_DIALOG_RULES,
    ...(config.file(WARDEN_DIALOG_RULES)?.rules ?? []),
  ];
}

/**
 * A ferret's own pane, through Ferrets' form seam (`FerretHarness.form`): the runner reads it masked and guards every key
 * with `kernel.act(<pane>, 'keys')`, so a Vault hold presses NOTHING and answers a refusal. Nothing here names a tmux pane.
 */
export function ferretClearPane(ferrets: Pick<FerretsApi, 'harness'>): Pick<DialogClearPorts, 'frame' | 'key'> {
  const form = async (sessionId: string) => (await ferrets.harness?.(sessionId as FerretId))?.form;
  return {
    frame: async (sessionId): Promise<ClearFrame | undefined> => {
      const read = await (await form(sessionId))?.capture().catch(() => undefined);
      return read?.ok === true
        ? { visible: read.value.visible, blocking: read.value.blocking !== undefined }
        : undefined;
    },
    key: async (sessionId, key) => {
      const typed = await (await form(sessionId))?.key(key).catch(() => undefined);
      return typed?.ok === true;
    },
  };
}
