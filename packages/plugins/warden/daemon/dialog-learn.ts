import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { ConfigPort, StatePort } from '@ferretry/kernel/contract';
import {
  DialogProposalSchema,
  type DialogRule,
  type DialogRulesView,
  doesOf,
  WARDEN_DIALOG_FRAMES,
  WARDEN_DIALOG_RULES,
} from '../contract/dialog-rules.ts';
import { WardenConfigMoved, WardenConfigRefused } from './adapters/index.ts';
import { ferretClearPane } from './dialog-clear.ts';
import {
  CLAUDE_DIALOG_RULES,
  CODEX_DIALOG_RULES,
  type DialogLearnPorts,
  type MachineMembersStore,
  permissionAsDialog,
  WardenDialogLearn,
  WatchedDialogSchema,
} from './lib/index.ts';

/** The state file name a ferret's frame is kept under: its id, as one plain name. */
const frameName = (ferret: string): string => ferret.replaceAll(/[^\w-]/gu, '_');

/**
 * What teaching Ferretry a screen reads and writes, over the daemon's ports: the ferret's recorded dialog and live frame
 * (Ferrets), the secret masker, the Warden's own owner-only state, and `config/warden-dialogs.yaml` through the kernel's
 * config writer — which holds an edit by anyone but the owner.
 */
export function dialogLearnService(deps: {
  readonly ferrets: Pick<FerretsApi, 'harness' | 'prompt'>;
  readonly config: ConfigPort;
  readonly state: StatePort;
  readonly mask: (text: string) => Promise<string>;
  readonly proposals: MachineMembersStore;
  readonly record: DialogLearnPorts['record'];
}): WardenDialogLearn {
  const pane = ferretClearPane(deps.ferrets);
  return new WardenDialogLearn({
    dialogOf: async ferret => {
      const prompt = await deps.ferrets.prompt?.(ferret as FerretId).catch(() => undefined);
      const screen = WatchedDialogSchema.safeParse(prompt?.dialog);
      return screen.success ? screen.data : permissionAsDialog(prompt?.permissionRequest);
    },
    frame: pane.frame,
    mask: deps.mask,
    saveFrame: async (ferret, masked) => {
      await deps.state.write(WARDEN_DIALOG_FRAMES, masked, frameName(ferret));
    },
    proposals: deps.proposals,
    saveRule: async rule => {
      const rules = (deps.config.file(WARDEN_DIALOG_RULES)?.rules ?? []).filter(known => known.id !== rule.id);
      const result = await deps.config.write(WARDEN_DIALOG_RULES, undefined, { patch: { rules: [...rules, rule] } });
      if (result.kind === 'refused')
        throw new WardenConfigRefused(result.issues.map(issue => issue.message).join('; '));
      if (result.kind === 'conflict') throw new WardenConfigMoved();
      return result.kind === 'held' ? result.sentences : [];
    },
    record: deps.record,
  });
}

const viewOf = (rules: readonly DialogRule[]) =>
  rules.map(rule => ({ id: rule.id, harness: rule.harness, kind: rule.kind, does: doesOf(rule) }));

/** What the app lists: the built-in rules, the ones taught, and the proposals waiting for a yes. */
export async function dialogRulesView(
  config: Pick<ConfigPort, 'file'>,
  proposals: MachineMembersStore,
): Promise<DialogRulesView> {
  const waiting = Object.values(await proposals.read()).flatMap(entry => {
    const parsed = DialogProposalSchema.safeParse(JSON.parse(entry[0] ?? 'null'));
    return parsed.success ? [parsed.data] : [];
  });
  return {
    builtIn: viewOf([...CLAUDE_DIALOG_RULES, ...CODEX_DIALOG_RULES]),
    taught: viewOf(config.file(WARDEN_DIALOG_RULES)?.rules ?? []),
    pending: waiting,
  };
}
