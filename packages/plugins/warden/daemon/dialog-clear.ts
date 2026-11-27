import type { ConfigPort } from '@ferretry/kernel/contract';
import type { FerretId, FerretsApi, HarnessForm } from '@ferretry/core-ferrets/contract';
import { type DialogRule, WARDEN_DIALOG_RULES } from '../contract/dialog-rules.ts';
import type { BuiltInDialogRules } from './dialog-rules-source.ts';
import { type ClearFrame, type DialogClearPorts, dialogWordsOf } from './lib/index.ts';

/**
 * The rules in effect: the built-in ones the harness plugins provide, then the ones the owner taught
 * (`config/warden-dialogs.yaml`, the version in effect — a held or broken edit is not read). A built-in rule wins a tie,
 * so a taught rule never overrides one. A harness with no provider has no built-in rules.
 */
export function dialogRulesInEffect(
  config: Pick<ConfigPort, 'file'>,
  builtIn: Pick<BuiltInDialogRules, 'rules'>,
): () => Promise<readonly DialogRule[]> {
  return async () => [...builtIn.rules(), ...(config.file(WARDEN_DIALOG_RULES)?.rules ?? [])];
}

/** One read of a ferret's pane through its form seam, or `undefined` when it cannot be read. */
async function readFrame(seam: HarnessForm | undefined): Promise<ClearFrame | undefined> {
  const read = await seam?.capture().catch(() => undefined);
  return read?.ok === true ? { visible: read.value.visible, blocking: read.value.blocking ?? false } : undefined;
}

/**
 * A ferret's own pane, through Ferrets' form seam (`FerretHarness.form`): the runner reads it masked and guards every key
 * with `kernel.act(<pane>, 'keys')`, so a Vault hold presses NOTHING and answers a refusal. Nothing here names a tmux pane.
 */
export function ferretClearPane(
  ferrets: Pick<FerretsApi, 'harness' | 'prompt'>,
): Pick<DialogClearPorts, 'frame' | 'key' | 'nudge' | 'words'> {
  const form = async (sessionId: string) => (await ferrets.harness?.(sessionId as FerretId))?.form;
  return {
    words: async sessionId => dialogWordsOf(await ferrets.prompt?.(sessionId as FerretId).catch(() => undefined)),
    frame: async (sessionId): Promise<ClearFrame | undefined> => await readFrame(await form(sessionId)),
    // The write path: ONE fresh read of the pane, the caller's test on it, then the key. A frame that is unreadable or no
    // longer the screen the key was planned for presses nothing (a composer swapped in after the look must not get an Esc).
    key: async (sessionId, key, stillOn) => {
      const seam = await form(sessionId);
      const live = await readFrame(seam);
      if (live === undefined || !stillOn(live)) return false;
      const typed = await seam?.key(key).catch(() => undefined);
      return typed?.ok === true;
    },
    // After a declined prompt the pane is idle (or its turn goes on): type the message, else queue it. Never awaited.
    nudge: (sessionId, text) => {
      void (async () => {
        const harness = await ferrets.harness?.(sessionId as FerretId);
        if ((await harness?.deliver({ text }))?.ok !== true) await harness?.queue(text);
      })().catch(() => undefined);
    },
  };
}
