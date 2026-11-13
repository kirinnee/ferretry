/**
 * Values a fleet starts from without anybody choosing them.
 *
 * Pure and value-only: nothing here reads a filesystem, mints an identifier, or renders YAML.
 */

import type { HarnessKind } from './manifest.ts';

/**
 * The model a first runtime starts with, per harness.
 *
 * EXPORTED because more than one consumer needs the same value: the first-run import writes it when a
 * harness declares no model of its own, and a surface that offers it says out loud that it is
 * Ferretry's starter rather than something the host declared. Two copies of a model identifier would
 * drift the first time either moved.
 */
export const FLEET_STARTER_MODELS: Readonly<Record<HarnessKind, string>> = {
  claude: 'claude-opus-5',
  codex: 'gpt-5.6',
};
