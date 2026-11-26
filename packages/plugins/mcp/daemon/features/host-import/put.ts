/**
 * MCP's side of the setup import (`ProfileComponentSource.put`, Runtimes' `component-source.ts`): the owner writes its own
 * `config/mcp/<name>.yaml` for a server the import found in the host's Claude Code or Codex setup.
 *
 * Runtimes hands over the component in the account model's shape (JSON-formatted YAML 1.2). The write goes through the
 * kernel's config service, so the schema check, the refusal of a raw secret and the hold on a loosening all still apply:
 * this module adds no second reading of the document and never holds a value. It only decides three things the config
 * service does not:
 *
 * - **Create-only**, except for an update the person accepted (`options.replace`), which replaces the server, pinned to
 *   the file's current etag, and only while the file still has the etag the import left (`options.etags`). An import
 *   never replaces a server it did not make (one made again by hand under the same name included): a name that is taken (in effect, held or broken)
 *   is refused in a sentence, and the write itself is pinned to "no file there" (`ifMatch: 'absent'`), so a file that
 *   appears between the check and the write is a refusal too, never an overwrite.
 * - **A missing program is a warning, not a refusal.** The server's `command` is not looked up on this machine: a server
 *   whose program is not installed yet is written like any other, and a check says so later.
 * - **A refusal is a sentence** naming the file and the rule, never an environment value.
 * - **The harness id is this plugin's own.** Runtimes names a harness `claude` or `codex`; an MCP item's `harness` is the
 *   harness key (`claude-code`, `codex`). The write accepts Runtimes' word (and the key itself) and writes the key, so a
 *   server that only one harness had in a dual-harness import still reads back; any other word is refused in a sentence.
 *
 * **The explicit MCP exception to "never run an imported command".** An MCP stdio server's `command` is the whole point of
 * the server, so it is imported as written: it is shown to the person and ticked in the import wizard, it is not looked up
 * on `PATH` and nothing is spawned at import. It runs only when a ferret launches with that server, and only because the
 * person ticked it.
 */
import { recordedKeyOfWord } from '@ferretry/core-ferrets/contract';
import type { ComponentPutOptions, ComponentPutResult } from '@ferretry/plugin-runtimes/contract';
import { ITEM_NAME_PATTERN } from '@ferretry/std';
import type { McpConfigWrite } from './ports.ts';

const refused = (reason: string): ComponentPutResult => ({ ok: false, reason });

/** The sentences a refused write gives, each one a path and a rule (the config service never quotes a value). */
const sentencesOf = (issues: readonly { readonly path: string; readonly message: string }[]): string =>
  issues.length === 0 ? '' : ` ${issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`;

export function hostImportPut(
  config: McpConfigWrite,
): (name: string, documentText: string, files?: unknown, options?: ComponentPutOptions) => Promise<ComponentPutResult> {
  return async (name, documentText, _files, options) => {
    const file = `mcp/${name}.yaml`;
    const current = options?.replace === true && config.taken(name) ? await config.etag(name) : '';
    const replacing = current !== '' && options?.etags?.[name] === current;
    if (!ITEM_NAME_PATTERN.test(name)) return refused(`${name} is not a name an MCP server can have.`);
    let document: unknown;
    try {
      document = JSON.parse(documentText);
    } catch {
      return refused(`The server for ${file} could not be read.`);
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document))
      return refused(`The server for ${file} is not a server description.`);
    if (config.taken(name) && !replacing)
      return refused(`${file} already exists and is not as an import left it, so it was left as it is.`);

    const harness = (document as { harness?: unknown }).harness;
    let text = documentText;
    if (harness !== undefined) {
      const key = typeof harness === 'string' ? recordedKeyOfWord(harness) : undefined;
      if (key === undefined) return refused(`The server for ${file} names a harness this plugin does not know.`);
      text = `${JSON.stringify({ ...document, harness: key }, null, 2)}\n`;
    }

    const outcome = replacing ? await config.replace(name, text, current) : await config.create(name, text);
    switch (outcome.kind) {
      case 'written':
        return { ok: true, etags: { [name]: outcome.etag } };
      case 'held':
        return { ok: true, held: true, etags: { [name]: outcome.etag } };
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
