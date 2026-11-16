import { implementCli, type VerbHandler } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import verbs from './generated/verbs.ts';
import { type CliVerb, verbContext } from './verbs/context.ts';

/** Every verb some file under `cli/verbs/` handles, read from the generated list (`generated/verbs.ts`). */
type Handled = (typeof verbs)[number] extends infer V ? (V extends CliVerb<infer K> ? K : never) : never;

/**
 * Ferrets' `fy` verbs (§2.2): list, read, start, stop, resume, rename and signal ferrets, revoke a ferret's token,
 * pin one, restart ferrets and manage the worktrees the daemon made for them. Each verb file under `cli/verbs/` is one
 * `*.verb.ts` that default-exports its handlers (`defineVerbs`); the generator lists them into `cli/generated/verbs.ts`,
 * so a verb is added by adding a file (and its manifest declaration) and this file is not edited.
 *
 * A manifest verb no file handles fails the typecheck here (`Handled` must cover every declared verb); a file's key the
 * manifest does not declare fails the typecheck in that file; a verb two files handle, or a declared verb no list holds
 * (a stale `generated/verbs.ts`), fails when the half builds.
 *
 * The shell hands a half no environment: `--session` names the ferret a `signal` is for, and a start begins in the
 * folder `fy` was run in unless `--cwd` names another.
 */
export default implementCli(manifest, {
  build(shell) {
    const context = verbContext(shell);
    const table = new Map<string, VerbHandler>();
    for (const file of verbs)
      for (const [key, handler] of Object.entries(file.build(context))) {
        if (table.has(key)) throw new Error(`the verb "${key}" is handled by two files in cli/verbs`);
        table.set(key, handler);
      }
    const missing = manifest.actions.cli.map(declared => declared.verb).filter(key => !table.has(key));
    if (missing.length > 0) throw new Error(`no file in cli/verbs handles: ${missing.join(', ')}`);
    return { verbs: Object.fromEntries(table) as { readonly [K in Handled]: VerbHandler } };
  },
});
