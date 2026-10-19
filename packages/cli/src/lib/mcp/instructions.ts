/**
 * What an agent runtime's MCP `initialize` instructions carry: the hypermedia teaching when this ferret
 * may communicate with hypermedia (`FY_HYPERMEDIA=1`), the built-in "Set up Ferretry" skill, then the
 * lessons teaching when this ferret is instructed to learn passively (`FY_LEARNING_PASSIVE=1`). Both
 * variables are read by the composition root, never here.
 *
 * Both per-ferret switches ride this text rather than a launch argument, because a runtime's wrapper
 * is materialised once and serves every ferret launched on it (fleet's fixed-layer.ts). The short
 * hypermedia teaching goes FIRST so a long skill can never be what pushes it out (docs/hypermedia.md).
 */
export interface McpInstructionParts {
  readonly skill: string;
  /** Present iff this ferret is instructed to file lessons. */
  readonly lessons?: string;
  /** Present iff this ferret may communicate with hypermedia. */
  readonly hypermedia?: string;
}

export function mcpInitializeInstructions(parts: McpInstructionParts): string {
  return [parts.hypermedia, parts.skill, parts.lessons].filter(part => part !== undefined).join('\n\n');
}
