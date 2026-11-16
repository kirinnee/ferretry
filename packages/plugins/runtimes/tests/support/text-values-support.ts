import { componentCatalog } from '../../daemon/lib/service/catalog.ts';
import { parseAccountModel } from '../../daemon/lib/account/schema.ts';

// What the Resolved/detail views of an instructions text and a hooks file show; shared by the unit and perf tiers.

const FACTS = {
  format: 'present',
  machineName: 'box',
  tools: { claude: undefined, codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
} as const;

/** What the detail shows for an instructions text: kept in a file, or held in the component YAML. */
export function instructionsShown(text: string, held: boolean): { text: string; redacted: boolean } {
  const model = parseAccountModel({
    version: 1,
    components: { instructions: { notes: held ? { text } : { file: 'notes.md' } } },
  });
  const content = componentCatalog(model, { ...FACTS, instructionBodies: { notes: text } }).kinds.flatMap(
    kind => kind.components,
  )[0]?.content;
  if (content?.form !== 'text') throw new Error('expected text content');
  return { text: content.text, redacted: content.redacted };
}

/** What the detail shows for a hooks file holding `text`. */
export function hooksShown(text: string): { text: string; redacted: boolean } {
  const model = parseAccountModel({
    version: 1,
    components: { hooks: { notes: { harness: 'claude', file: 'components/hooks/notes.json' } } },
  });
  const content = componentCatalog(model, { ...FACTS, hooksTexts: { notes: text } }).kinds.flatMap(
    kind => kind.components,
  )[0]?.content;
  if (content?.form !== 'text') throw new Error('expected text content');
  return { text: content.text, redacted: content.redacted };
}

/** A hooks document in the shapes the harness reads, around one `command` and its `args`. */
export const hook = (command: string, args?: readonly string[]): unknown => ({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, ...(args ? { args } : {}) }] }] },
});
