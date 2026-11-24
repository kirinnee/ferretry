/**
 * The two small example scenes only Codex's import pages draw (r11 O5), in the import kit's demo box (`.ob-demo`, the
 * same box as the install and permission demos). Each is decorative and follows the card on screen:
 *   - `ImportDemo`: what the person's pick brings over: the kinds the scan REALLY found (or generic example words before it is read);
 *   - `ConversationsDemo`: the terminal's conversations read one way, in generic example words;
 *   - `KindDemo`: what one kind of thing (settings, models, AGENTS.md, skills, MCP) becomes once it is brought over.
 * Plain lines that fade in one after the other (`demos.css`); no motion when the person turned it off.
 */
import type { CSSProperties } from 'react';
import type { ImportKind } from '@ferretry/plugin-runtimes/import-kit';
import type { ImportMode } from './import-choice-page.tsx';
import './demos.css';

const stagger = (index: number): CSSProperties => ({ '--cx-delay': `${String(200 + index * 260)}ms` }) as CSSProperties;

/** The words each kind goes by in the demo (what the scan found, named as the pages name them). */
const FOUND_WORDS: Readonly<Record<ImportKind, string>> = {
  settings: 'settings',
  'model-set': 'models',
  instructions: 'AGENTS.md',
  skills: 'skills',
  mcp: 'MCP servers',
};

/**
 * The demo's lines. `found` is what the scan REALLY found, kind by kind; `null` is "not read yet" (waiting for the person's OK,
 * or it failed), and then the lines are generic words marked as an example. A made-up list that reads as found is never drawn.
 */
const importLines = (mode: ImportMode, found: readonly ImportKind[] | null): readonly string[] => {
  if (mode === 'fresh') return ['› start fresh', '· nothing brought over', '· import later in Settings'];
  const head = mode === 'everything' ? '› import everything' : '› choose what to import';
  if (found === null) return [head, '✓ the kinds Codex keeps', '· an example: nothing is read yet'];
  if (found.length === 0) return [head, '· nothing found on this computer'];
  return [head, ...found.map(kind => (mode === 'everything' ? '✓ ' : '· ') + FOUND_WORDS[kind])];
};
const importLabel = (mode: ImportMode, found: readonly ImportKind[] | null): string => {
  if (mode === 'fresh') return 'Nothing comes over';
  if (found === null) return 'An example: what comes over depends on what Codex keeps here';
  if (found.length === 0) return 'Nothing was found to bring over';
  return mode === 'everything'
    ? 'Everything found in your Codex setup comes over'
    : 'Only the kinds you tick come over';
};

/** `found`: the kinds the scan found on this computer, or `null` while it has not been read. */
export function ImportDemo({
  mode,
  found,
}: {
  readonly mode: ImportMode;
  readonly found: readonly ImportKind[] | null;
}) {
  return (
    <div className="ob-demo" role="img" aria-label={importLabel(mode, found)} data-demo={`import-${mode}`} key={mode}>
      {importLines(mode, found).map((line, index) => (
        <p key={line} className="ob-demo__line cx-row" style={stagger(index)}>
          {line}
        </p>
      ))}
    </div>
  );
}

/** How the terminal's conversations reach Ferretry: read, one way. Generic words, never a made-up conversation shown as found. */
export function ConversationsDemo() {
  const lines = ['$ codex resume', '· an example, not your conversations', '✓ read here, one way'];
  return (
    <div className="ob-demo" role="img" aria-label="An example of conversations read one way" data-demo="conversations">
      {lines.map((line, index) => (
        <p key={line} className="ob-demo__line cx-row" style={stagger(index)}>
          {line}
        </p>
      ))}
    </div>
  );
}

const KIND_LINES: Readonly<Record<ImportKind, readonly string[]>> = {
  settings: ['› your Codex settings', '✓ read from this computer', '· hooks are never imported'],
  'model-set': ['› models and profiles', '✓ named in your settings', '✓ become a model set'],
  instructions: ['› AGENTS.md', '✓ becomes an instruction', '✓ every runtime starts with it'],
  skills: ['› skills you wrote', '✓ become Ferretry skills'],
  mcp: ['› MCP servers', '✓ set up here', '✓ secrets go to the Vault'],
};
const KIND_LABEL: Readonly<Record<ImportKind, string>> = {
  settings: 'Your Codex settings come over; hooks never do',
  'model-set': 'Your models and profiles become a model set',
  instructions: 'Your AGENTS.md becomes an instruction',
  skills: 'Your skills become Ferretry skills',
  mcp: 'Your MCP servers come over; secrets go to the Vault',
};

export function KindDemo({ kind }: { readonly kind: ImportKind }) {
  return (
    <div className="ob-demo" role="img" aria-label={KIND_LABEL[kind]} data-demo={`kind-${kind}`} key={kind}>
      {KIND_LINES[kind].map((line, index) => (
        <p key={line} className="ob-demo__line cx-row" style={stagger(index)}>
          {line}
        </p>
      ))}
    </div>
  );
}
