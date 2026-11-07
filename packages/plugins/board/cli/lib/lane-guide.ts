import { LANE_CATEGORIES, LANE_CATEGORY_USE } from '../../contract/index.ts';

/**
 * The text under `task move --help`: which lane a card belongs in, by CATEGORY so it holds for any
 * project's lane names. `board lanes show` prints the same words for the project's own lanes.
 */
export const laneGuide = (binary: string): string =>
  [
    `Pick the lane by what the work is, not by its name; \`${binary} board lanes show\` lists this project's lanes with "use when":`,
    ...LANE_CATEGORIES.map(category => `  ${category.padEnd(8)}${LANE_CATEGORY_USE[category]}`),
    "Lanes show progress. The owner's OK to build, and Done / Not good, ride the card's agenda: never move a card past them yourself.",
    `A start, a PR, a merge, a release and \`${binary} signal done\` move a card by themselves, so do not move what they move.`,
    `Blocked is not a lane: \`${binary} card block\`, \`${binary} card depend\` or \`${binary} ask add\`.`,
  ].join('\n');
