/**
 * WHAT A BLOCKED TASK WAS WAITING ON, read from its reason (`board-design.md` §5). The reason is free text a
 * ferret wrote, so the reading is a heuristic and its default is the safe one: when unsure, the block is
 * EXTERNAL, which keeps the words on the card and invents no link.
 */
export type BlockReading =
  | { readonly on: 'tasks'; readonly ids: readonly string[] }
  | { readonly on: 'owner' }
  | { readonly on: 'external' };

const TASK_ID = /(?<![A-Za-z0-9])[&#]?([BFIC][1-9][0-9]{0,8})(?![A-Za-z0-9])/gu;

const OWNER_WORDS = [
  /\bowner\b/iu,
  /\bhuman\b/iu,
  /\bthe user\b/iu,
  /\byou(?:r)?\b/iu,
  /\bapprov(?:al|e|ed)\b/iu,
  /\bsign[- ]?off\b/iu,
  /\bgo[- ]ahead\b/iu,
  /\bdecision\b/iu,
  /\bwaiting (?:on|for) (?:an? )?(?:answer|reply|response|input)\b/iu,
];

/**
 * Reads a block reason. A reason naming another task of the SAME session (one of `knownIds`, never `selfId`)
 * is a dependency; failing that, a reason that asks something of the owner is an ask on the owner; anything
 * else is external.
 */
export const readBlockReason = (reason: string, selfId: string, knownIds: ReadonlySet<string>): BlockReading => {
  const named = [...reason.matchAll(TASK_ID)]
    .map(match => match[1]?.toUpperCase() ?? '')
    .filter(id => id !== selfId && knownIds.has(id));
  const ids = [...new Set(named)];
  if (ids.length > 0) return { on: 'tasks', ids };
  return OWNER_WORDS.some(pattern => pattern.test(reason)) ? { on: 'owner' } : { on: 'external' };
};
