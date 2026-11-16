import type { DialogReader, HarnessDialog as FerretDialog } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { parseHarnessDialog } from '../../lib/pane/harness-dialog.ts';
import { parsePermissionPrompt } from '../../lib/pane/permission-prompt.ts';
import { type ClaudeCore, type Serves, TMUX_TIMEOUT_MS } from './core.ts';

async function capture(core: ClaudeCore, ferret: FerretId): Promise<string | undefined> {
  try {
    const pane = core.deps.panes.require(ferret);
    const result = await core.deps.spawn.run('tmux', ['capture-pane', '-p', '-t', pane], {
      timeout: milliseconds(TMUX_TIMEOUT_MS),
    });
    return result.exitCode === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

export const dialogsPart = (core: ClaudeCore): Serves<'dialogs'> => {
  const dialogs: DialogReader = {
    current: async ferret => {
      const frame = await capture(core, ferret);
      if (frame === undefined) return undefined;
      const permission = parsePermissionPrompt(frame);
      if (permission !== undefined)
        return {
          id: permission.id,
          kind: 'permission',
          prompt: permission.question,
          choices: permission.options.map(option => option.label),
        } satisfies FerretDialog;
      const dialog = parseHarnessDialog(frame);
      return dialog === undefined
        ? undefined
        : ({
            id: dialog.id,
            kind: 'harness',
            prompt: dialog.title,
            choices: dialog.options.map(option => option.label),
          } satisfies FerretDialog);
    },
    answer: async (ferret, dialog, choice) => {
      const number = Number(choice);
      const current = await dialogs.current(ferret);
      if (current === undefined || current.id !== dialog)
        return { status: 'refused', id: dialog, reason: 'that prompt is gone, so nothing was sent' };
      const answer = Number.isInteger(number)
        ? ({ kind: 'choice', number } as const)
        : choice === 'deny' || choice === 'escape'
          ? null
          : undefined;
      if (answer === undefined) return { status: 'refused', id: dialog, reason: `${choice} is not a choice` };
      try {
        if (current.kind === 'permission') {
          const result = await core.deps.permission.answer(
            ferret,
            answer === null ? { kind: 'deny', requestId: dialog } : { ...answer, requestId: dialog },
          );
          return { status: result.cleared ? 'delivered' : 'queued', id: dialog };
        }
        const result = await core.deps.dialog.answer(
          ferret,
          answer === null ? { kind: 'escape', dialogId: dialog } : { ...answer, dialogId: dialog },
        );
        return { status: result.cleared ? 'delivered' : 'queued', id: dialog };
      } catch (error) {
        return { status: 'refused', id: dialog, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  return { dialogs };
};
