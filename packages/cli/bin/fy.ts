#!/usr/bin/env bun
/**
 * The `fy` host file (≤150 lines, names no subsystem): decide which composition root this invocation needs, then load
 * only that one. The BINARY name is this package's `bin` key and the PRODUCT name is the root package's `name`; neither
 * is written anywhere else.
 *
 * Nothing is imported statically but the pure routing rule, because everything imported here is evaluated by EVERY `fy`
 * process before it reads its arguments. A ferret's `fy mcp serve`, which lives as long as its pane, loads the slim root
 * (`bin/mcp-serve.ts`); every other invocation loads the full program, `bin/program.ts`, exactly as before. The rule and
 * why it is narrow: `src/lib/entry/route.ts`.
 */
import { entrySlice } from '../src/lib/entry/route.ts';

if (import.meta.main) {
  const slice = entrySlice(process.argv.slice(2));
  const { execute } = slice === 'mcp-serve' ? await import('./mcp-serve.ts') : await import('./program.ts');
  process.exitCode = await execute(process.argv);
}
