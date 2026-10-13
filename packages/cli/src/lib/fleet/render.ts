import type { RoleOption, TeamRecommendation } from './wire.ts';

const INDENT = '    ';

function optionLine(option: RoleOption, prefix: string): string {
  const caveat = option.caveat === undefined ? '' : ` — ${option.caveat}`;
  return `${prefix}${option.agent} (${option.model}, account ${option.accountId}): ${option.tradeoff}${caveat}`;
}

/**
 * The recommendation as a decision guide, not an order.
 *
 * Alternatives and exclusions are printed alongside the pick because the human, not the recommender,
 * chooses: kteam printed only the winner and a launch command, which read as an instruction and hid
 * the fact that an account had been skipped for being out of quota.
 */
export function renderRecommendation(recommendation: TeamRecommendation): string {
  const sections = [`${recommendation.task}`, `  ${recommendation.classification} — ${recommendation.reasoning}`];
  for (const role of recommendation.roles) {
    const count = role.count === undefined ? '' : ` ×${role.count}`;
    sections.push(`  ${role.role}${count}: ${role.why}`, optionLine(role.primary, `${INDENT}pick  `));
    sections.push(...role.alternatives.map(option => optionLine(option, `${INDENT}or    `)));
  }
  if (recommendation.exclusions.length > 0) {
    sections.push('  not considered:');
    sections.push(
      ...recommendation.exclusions.map(
        exclusion => `${INDENT}${exclusion.agent} (${exclusion.accountId}): ${exclusion.reason}`,
      ),
    );
  }
  sections.push(...recommendation.warnings.map(warning => `  ! ${warning}`));
  return sections.join('\n');
}
