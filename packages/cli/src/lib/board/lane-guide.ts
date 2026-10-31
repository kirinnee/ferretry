import { LANE_CATEGORIES, LANE_CATEGORY_USE } from '@ferretry/protocol';

/**
 * The text under `task move --help`: which lane a card belongs in, by CATEGORY so it holds for any
 * project's lane names. `board lanes show` prints the same words for the project's own lanes.
 */
export const laneGuide = (binary: string): string =>
  [
    `Pick the lane by what the work is, not by its name; \`${binary} board lanes show\` lists this project's lanes with "use when":`,
    ...LANE_CATEGORIES.map(category => `  ${category.padEnd(8)}${LANE_CATEGORY_USE[category]}`),
    'A lane the owner gates for planning or designing is an active lane: the owner approves leaving it.',
    `A start, a PR, a merge, a release and \`${binary} signal done\` move a card by themselves, so do not move what they move.`,
    `Blocked is not a lane: \`${binary} task block\`, \`${binary} task depend\` or \`${binary} agenda add --task <id>\`.`,
  ].join('\n');
