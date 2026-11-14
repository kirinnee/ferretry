import type { VerbsOf } from '@ferretry/kernel/manifest';
import type manifest from '../../../manifest.ts';
import type { VerbSpec } from '../plan.ts';
import { WHOLE_BROWSER_VERBS } from './whole-browser.ts';
import { type FirewallFiles, machineVerbs } from './machine.ts';
import { PAGE_VERBS } from './page.ts';

export type { FirewallFiles };

/** Every verb line the manifest declares. */
export type BrowserVerbLine = VerbsOf<typeof manifest>;

/**
 * THE VERB TABLE: every `browser …` verb the manifest declares, each as its words, its scope and a pure builder from
 * words to a {@link Plan}. The type forces it complete (a verb the manifest declares and this lacks fails to compile;
 * so does one it does not declare), and `tests/unit/cli/verb-table.test.ts` proves the same at run time.
 */
export function verbTable(files: FirewallFiles): Readonly<Record<BrowserVerbLine, VerbSpec>> {
  return { ...WHOLE_BROWSER_VERBS, ...machineVerbs(files), ...PAGE_VERBS };
}
