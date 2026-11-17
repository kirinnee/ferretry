import type { Harness } from '@ferretry/core-ferrets/contract';
import type { ClaudeCore } from './core.ts';
import { CLAUDE_PARTS } from './list.ts';

type Intersection<U> = (U extends unknown ? (member: U) => void : never) extends (member: infer I) => void ? I : never;

/** Every `Harness` member Claude Code serves, as the parts together give them. */
export type ClaudeMembers = Intersection<ReturnType<(typeof CLAUDE_PARTS)[number]>>;

/** The harness: each part's members side by side. A member two parts both serve is a mistake, refused at once. */
export function composeClaudeHarness(core: ClaudeCore): ClaudeMembers {
  const members: Record<string, unknown> = {};
  for (const part of CLAUDE_PARTS) {
    for (const [name, member] of Object.entries(part(core))) {
      if (name in members) throw new Error(`the Claude harness member "${name}" is served by two parts (${part.name})`);
      members[name] = member;
    }
  }
  return members as ClaudeMembers satisfies Harness;
}
