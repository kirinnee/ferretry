#!/usr/bin/env bun
/**
 * The binary's entry: decide which part of the CLI this invocation needs, then load only that.
 *
 * Nothing is imported statically but the pure routing rule, because everything imported here is
 * evaluated by EVERY `fy` process before it reads its arguments. A long-lived command a slice owns
 * (`fy wait`, `fy mcp serve`, …) loads that slice (`bin/reads-group.ts`, `bin/mcp-group.ts`); every
 * other command loads the full composition root, `bin/program.ts`, exactly as before. The rule and why
 * it is narrow: `src/lib/entry/route.ts`.
 */
import { entrySlice } from '../src/lib/entry/route';

if (import.meta.main) {
  const slice = entrySlice(process.argv.slice(2));
  if (slice === 'reads') await (await import('./reads-group')).execute(process.argv);
  else if (slice === 'mcp') await (await import('./mcp-group')).execute(process.argv);
  else await (await import('./program')).execute(process.argv);
}
