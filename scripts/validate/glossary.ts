/**
 * `glossary` (§1.3, §7.9): owner-facing text uses an "instead of" word. Owner-facing text read here: every manifest's
 * title, nav and settings labels, verb and tool summaries, app action labels and onboarding titles, and every
 * package's `instructions/*.md`. Matching is whole-word and case-insensitive; a word's own `means` is not read.
 * A reviewed phrase in {@link PHRASE_EXCEPTIONS} is blanked out before matching, so its words pass only inside that
 * exact phrase.
 */
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Manifest } from '../../packages/core/kernel/manifest/index.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';

/**
 * Reviewed phrases whose words name a real thing, not the idea an "instead of" word replaced. Exact phrases only (whole
 * phrase, case-insensitive): no pattern, no single word. The bare banned word anywhere else still fails. phrase → reason.
 */
export const PHRASE_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['browser proxy', 'a real HTTP proxy the browser goes through; not a relay (docs/browser-proxy.md)'],
  ['routing prompt', 'the one text Pack mode picks helper models with (docs/pack-mode.md); not a message to a ferret'],
  ['firewall timer', 'a systemd .timer unit that runs the loopback-firewall verify unit; not a job'],
]);

const BOUNDARY_BEFORE = '(^|[^\\p{L}\\p{N}_-])';
const BOUNDARY_AFTER = '(?=$|[^\\p{L}\\p{N}_-])';
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with every reviewed exception phrase blanked out (its boundaries kept). */
export function withoutExceptions(text: string): string {
  let out = text;
  for (const phrase of PHRASE_EXCEPTIONS.keys())
    out = out.replace(new RegExp(`${BOUNDARY_BEFORE}${escapeRegExp(phrase)}${BOUNDARY_AFTER}`, 'giu'), '$1');
  return out;
}

export function ownerTexts(manifest: Manifest): { readonly where: string; readonly text: string }[] {
  const out: { where: string; text: string }[] = [{ where: 'title', text: manifest.title }];
  for (const s of manifest.ui?.screens ?? [])
    if (s.nav !== undefined) out.push({ where: `screen ${s.id}`, text: s.nav.label });
  for (const s of manifest.ui?.settings ?? []) out.push({ where: `settings ${s.id}`, text: s.label });
  for (const v of manifest.actions?.cli ?? [])
    if (v.summary !== undefined) out.push({ where: `verb ${v.verb}`, text: v.summary });
  for (const t of manifest.actions?.agentTools ?? [])
    if (t.summary !== undefined) out.push({ where: `tool ${t.name}`, text: t.summary });
  for (const a of manifest.actions?.app ?? []) out.push({ where: `action ${a.id}`, text: a.label });
  for (const o of manifest.onboarding ?? []) out.push({ where: `onboarding ${o.id}`, text: o.title });
  return out;
}

export function insteadOfIndex(manifests: readonly Manifest[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const m of manifests)
    for (const word of m.words ?? []) for (const old of word.insteadOf ?? []) index.set(old.toLowerCase(), word.word);
  return index;
}

export function glossaryFindings(where: string, text: string, index: ReadonlyMap<string, string>): Finding[] {
  const findings: Finding[] = [];
  const read = withoutExceptions(text);
  for (const [old, word] of index) {
    const pattern = new RegExp(`${BOUNDARY_BEFORE}${escapeRegExp(old)}${BOUNDARY_AFTER}`, 'iu');
    if (pattern.test(read))
      findings.push({ check: 'glossary', where, message: `says "${old}"; the word is "${word}"` });
  }
  return findings;
}

export const check: Check = {
  name: 'glossary',
  summary: 'owner-facing text uses the words, not what they replace',
  async run(ctx) {
    const model = await ctx.model();
    const index = insteadOfIndex(model.loaded.map(s => s.manifest));
    const findings: Finding[] = [];
    for (const s of model.loaded) {
      if (ctx.packageId !== undefined && s.id !== ctx.packageId) continue;
      for (const { where, text } of ownerTexts(s.manifest))
        findings.push(...glossaryFindings(`${s.id} ${where}`, text, index));
      for (const rel of new Bun.Glob('instructions/**/*.md').scanSync({ cwd: s.pkg.dir, onlyFiles: true })) {
        const file = join(s.pkg.dir, rel);
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, at) =>
          findings.push(
            ...glossaryFindings(`${relative(model.ws.root, file).split(sep).join('/')}:${at + 1}`, line, index),
          ),
        );
      }
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
