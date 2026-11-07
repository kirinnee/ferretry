/**
 * PLACEHOLDER until `scripts/gen/registries.ts` (SDK slice) lands: it overwrites this file with one entry per
 * workspace plugin and the generator's output is git-ignored from then on. The shell consumes the
 * `CommandRegistry` shape of `../lib/registry.ts`, nothing else; an empty registry leaves only the shell's own verbs.
 */
import type { CommandRegistry } from '../lib/registry.ts';

export const registry: CommandRegistry = { plugins: [] };
