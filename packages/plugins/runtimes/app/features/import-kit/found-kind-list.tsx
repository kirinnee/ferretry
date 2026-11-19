/**
 * One kind's checklist (settings, model set, instructions, skills, MCP): the wizard's own rows, each with what it BECOMES, for
 * the groups of that kind only. Hooks are drawn greyed on the settings page ("Not imported: Ferretry doesn't use hooks") and
 * project instructions on the instructions page; conversations belong to their own page.
 */
import type { ImportItemId } from '../../../contract/index.ts';
import { FoundList } from './found-list.tsx';
import { type ImportKind, kindGroups } from './kinds.ts';
import type { ToolModel } from './model.ts';

export interface FoundKindListProps {
  readonly model: ToolModel;
  readonly kind: ImportKind;
  /** Ids the person UNticked. */
  readonly left: ReadonlySet<ImportItemId>;
  readonly onToggle: (id: ImportItemId, on: boolean) => void;
  /** The GitHub-token variables the person ticked (settings page only). */
  readonly tickedEnv?: ReadonlySet<string>;
  readonly onTickEnv?: (name: string, on: boolean) => void;
}

const NONE: ReadonlySet<string> = new Set();

export function FoundKindList({ model, kind, left, onToggle, tickedEnv = NONE, onTickEnv }: FoundKindListProps) {
  return (
    <FoundList
      harness={`${model.harness}:${kind}`}
      groups={kindGroups(model, kind)}
      left={left}
      leftAlone={{
        hooks: kind === 'settings' ? model.leftAlone.hooks : 0,
        projectFolders: kind === 'instructions' ? model.leftAlone.projectFolders : 0,
      }}
      showConversations={false}
      onToggle={onToggle}
      tickedEnv={tickedEnv}
      onTickEnv={onTickEnv ?? (() => undefined)}
      updates={[]}
      declined={NONE}
      onTakeUpdate={() => undefined}
    />
  );
}
