import { type ConfigItemKind, ItemCommandError, itemFlag, itemFlagList } from '@ferretry/kernel/manifest';

/** The tool a person names: `claude` is Claude Code, whose key is the plugin's id. */
function harnessKeyOf(word: string): 'claude-code' | 'codex' {
  if (word === 'claude' || word === 'claude-code') return 'claude-code';
  if (word === 'codex') return 'codex';
  throw new ItemCommandError(`--harness takes claude or codex, got "${word}".`);
}

/**
 * `config/skills/<name>.yaml` from the flags: the skills of the skills store it brings in (`--item <skill>`, repeated; an
 * edit's list REPLACES the one it has, as v4's did) and the one tool it is for (`--harness`).
 */
export const skillsItemKind: ConfigItemKind = {
  collection: 'skills',
  noun: 'skills item',
  layer: 'skills',
  command: 'skill',
  fields(invocation, current) {
    const items = itemFlagList(invocation, 'item');
    const harness = itemFlag(invocation, 'harness');
    const document: Record<string, unknown> = { ...(current ?? {}) };
    if (items.length > 0) document.items = items;
    if (harness !== undefined) document.harness = harnessKeyOf(harness);
    if (!Array.isArray(document.items) || document.items.length === 0)
      throw new ItemCommandError('A skills item needs at least one --item <skill>.');
    return document;
  },
  details(document) {
    const items = Array.isArray(document.items)
      ? document.items.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return [
      `Skills: ${items.length === 0 ? 'none' : items.join(', ')}`,
      ...(typeof document.harness === 'string' ? [`For: ${document.harness}`] : []),
    ];
  },
};
