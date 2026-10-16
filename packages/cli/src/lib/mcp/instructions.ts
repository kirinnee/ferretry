/**
 * What an agent runtime's MCP `initialize` instructions carry: the built-in "Set up Ferretry" skill,
 * with the lessons teaching appended exactly when this ferret is instructed to learn passively
 * (`FY_LEARNING_PASSIVE=1` in its environment — read by the composition root, never here).
 *
 * The passive-learning switch rides this text rather than a launch argument, because a runtime's
 * wrapper is materialised once and serves every ferret launched on it (fleet's fixed-layer.ts).
 */
export function mcpInitializeInstructions(skill: string, passiveLearning: boolean, lessonsInstruction: string): string {
  return passiveLearning ? `${skill}\n\n${lessonsInstruction}` : skill;
}
