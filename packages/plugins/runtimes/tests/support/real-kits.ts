/** The real kits of the two shipped harnesses, for a test that materialises runtimes (a missing kit leaves its harness's runtimes unavailable). */
import { claudeRuntimesKit } from '../../../claude-code/daemon/lib/runtimes-kit/index.ts';
import { codexRuntimesKit } from '../../../codex/daemon/lib/runtimes-kit/index.ts';

export const REAL_KITS = new Map([
  ['claude', claudeRuntimesKit],
  ['codex', codexRuntimesKit],
] as const);
