/**
 * MCP's side of the setup import (`ProfileComponentSource.put`, Runtimes' `component-source.ts`): the owner writes its own
 * `config/mcp/<name>.yaml` for a server the import found in the host's Claude Code or Codex setup.
 *
 * Runtimes hands over the component in the account model's shape (JSON-formatted YAML 1.2). The write goes through the
 * kernel's config service, so the schema check, the refusal of a raw secret and the hold on a loosening all still apply:
 * this module adds no second reading of the document and never holds a value. It only decides three things the config
 * service does not:
 *
 * - **Create-only.** An import never replaces a server it did not make: a name that is taken (in effect, held or broken)
 *   is refused in a sentence, and the write itself is pinned to "no file there" (`ifMatch: 'absent'`), so a file that
 *   appears between the check and the write is a refusal too, never an overwrite.
 * - **A missing program is a warning, not a refusal.** The server's `command` is not looked up on this machine: a server
 *   whose program is not installed yet is written like any other, and a check says so later.
 * - **A refusal is a sentence** naming the file and the rule, never an environment value.
 */
import type { ComponentPutResult } from '@ferretry/plugin-runtimes/contract';
import { ITEM_NAME_PATTERN } from '@ferretry/std';
import type { McpConfigWrite } from './ports.ts';

const refused = (reason: string): ComponentPutResult => ({ ok: false, reason });

/** The sentences a refused write gives, each one a path and a rule (the config service never quotes a value). */
const sentencesOf = (issues: readonly { readonly path: string; readonly message: string }[]): string =>
  issues.length === 0 ? '' : ` ${issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`;

export function hostImportPut(
  config: McpConfigWrite,
): (name: string, documentText: string) => Promise<ComponentPutResult> {
  return async (name, documentText) => {
    const file = `mcp/${name}.yaml`;
    if (!ITEM_NAME_PATTERN.test(name)) return refused(`${name} is not a name an MCP server can have.`);
    let document: unknown;
    try {
      document = JSON.parse(documentText);
    } catch {
      return refused(`The server for ${file} could not be read.`);
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document))
      return refused(`The server for ${file} is not a server description.`);
    if (config.taken(name))
      return refused(`${file} already exists, so it was left as it is: an import never replaces a server.`);

    const outcome = await config.create(name, documentText);
    switch (outcome.kind) {
      case 'written':
        return { ok: true };
      case 'held':
        return { ok: true, held: true };
      case 'conflict':
        return refused(`${file} appeared while it was being written, so it was left as it is.`);
      case 'refused':
        return refused(
          outcome.reason === 'raw_secret'
            ? `${file} has a secret written into it as a plain value; it belongs in the secret store as a \${secret:NAME} reference.${sentencesOf(outcome.issues)}`
            : `${file} was refused.${sentencesOf(outcome.issues)}`,
        );
    }
  };
}
