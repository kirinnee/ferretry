/**
 * `no-compat` (§7.9, owner decision A452): `legacy`, `deprecated`, `compat`, `migrat*` or `retired` in a product
 * identifier or string. Product = every workspace package's source except its tests; comments are not read (a
 * comment may say why something is gone). `compatible` is an ordinary word and is not refused; `compat` as a word or
 * an identifier part is.
 */
import { relative, sep } from 'node:path';
import { type Check, type Finding, parseFile, runMain, walk } from '../gen/lib/check.ts';
import { areaOf } from '../gen/lib/imports.ts';
import { loadWorkspace, sourceFiles } from '../gen/lib/workspace.ts';

export const BANNED_WORDS = /legacy|deprecat|migrat|retired|compat(?!ib)/i;

/**
 * Constants whose TEXT may name these words, by `file#name`, or a single literal by `file#name#literal`,
 * each with the lead's reason. Identifiers and every other string are still read.
 */
export const ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    'packages/plugins/codex/daemon/lib/fixed-layer.ts#CODEX_HIDDEN_NOTICES#hide_gpt5_1_migration_prompt',
    "Codex's own config notice key, written verbatim into the harness config",
  ],
  [
    'packages/plugins/codex/daemon/lib/fixed-layer.ts#CODEX_HIDDEN_NOTICES#hide_gpt-5.1-codex-max_migration_prompt',
    "Codex's own config notice key, written verbatim into the harness config",
  ],
  [
    'packages/core/kernel/contract/home.ts#CARRY_OVER_PROMPT',
    'names the carry-over runbook path (docs/migration/); lead decision 2026-11-07',
  ],
  [
    'packages/plugins/runtimes/daemon/lib/account/fixed-layer.ts#CODEX_HIDDEN_NOTICES',
    "Codex's own [notice] config key names, which spell 'migration'; the harness defines them, not Ferretry",
  ],
]);

export function compatIn(file: string, where = file): Finding[] {
  const findings: Finding[] = [];
  const parsed = parseFile(file);
  const seen = new Set<string>();
  const add = (start: number, text: string): void => {
    const match = BANNED_WORDS.exec(text);
    if (match === null) return;
    const at = `${where}:${parsed.line(start)}:${text}`;
    if (seen.has(at)) return;
    seen.add(at);
    findings.push({
      check: 'no-compat',
      where: `${where}:${parsed.line(start)}`,
      message: `"${text.length > 60 ? `${text.slice(0, 57)}…` : text}" carries "${match[0]}"`,
    });
  };
  walk(parsed.program, (node, parents) => {
    const allowed = parents.some(
      p =>
        p.type === 'VariableDeclarator' &&
        ALLOWED.has(`${where}#${(p.id as { name?: string } | undefined)?.name ?? ''}`),
    );
    if (allowed && node.type !== 'Identifier') return;
    if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') add(node.start, node.name as string);
    else if (node.type === 'Literal' && typeof node.value === 'string') {
      const exact = parents.some(
        p =>
          p.type === 'VariableDeclarator' &&
          ALLOWED.has(`${where}#${(p.id as { name?: string } | undefined)?.name ?? ''}#${node.value}`),
      );
      if (!exact) add(node.start, node.value);
    } else if (node.type === 'TemplateElement') add(node.start, (node.value as { raw: string }).raw);
  });
  return findings;
}

export const check: Check = {
  name: 'no-compat',
  summary: 'no compatibility words in product identifiers or strings',
  async run(ctx) {
    const ws = loadWorkspace(ctx.root);
    const findings: Finding[] = [];
    for (const pkg of ws.packages) {
      if (ctx.packageId !== undefined && pkg.id !== ctx.packageId) continue;
      for (const file of sourceFiles(pkg, { tests: false })) {
        if (areaOf(pkg, file) === 'generated') continue;
        findings.push(...compatIn(file, relative(ws.root, file).split(sep).join('/')));
      }
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
