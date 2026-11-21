/**
 * The two small example scenes only Codex's import pages draw (r11 O5), in the import kit's demo box (`.ob-demo`, the
 * same box as the install and permission demos). Each is decorative and follows the card on screen:
 *   - `ImportDemo`: what the person's pick brings over (everything / chosen kinds / nothing);
 *   - `ConversationsDemo`: the terminal's conversations, shown here or left alone;
 *   - `KindDemo`: what one kind of thing (settings, models, AGENTS.md, skills, MCP) becomes once it is brought over.
 * Plain lines that fade in one after the other (`demos.css`); no motion when the person turned it off.
 */
import type { CSSProperties } from 'react';
import type { ImportKind } from '@ferretry/plugin-runtimes/import-kit';
import type { ImportMode } from './import-choice-page.tsx';
import './demos.css';

const stagger = (index: number): CSSProperties => ({ '--cx-delay': `${String(200 + index * 260)}ms` }) as CSSProperties;

const IMPORT_LINES: Readonly<Record<ImportMode, readonly string[]>> = {
  everything: ['› import everything', '✓ settings and models', '✓ AGENTS.md and skills', '✓ MCP servers'],
  choose: ['› choose what to import', '✓ settings and models', '– AGENTS.md (left out)', '✓ MCP servers'],
  fresh: ['› start fresh', '· nothing brought over', '· import later in Settings'],
};
const IMPORT_LABEL: Readonly<Record<ImportMode, string>> = {
  everything: 'Everything in your Codex setup comes over',
  choose: 'Only the kinds you tick come over',
  fresh: 'Nothing comes over',
};

export function ImportDemo({ mode }: { readonly mode: ImportMode }) {
  return (
    <div className="ob-demo" role="img" aria-label={IMPORT_LABEL[mode]} data-demo={`import-${mode}`} key={mode}>
      {IMPORT_LINES[mode].map((line, index) => (
        <p key={line} className="ob-demo__line cx-row" style={stagger(index)}>
          {line}
        </p>
      ))}
    </div>
  );
}

export function ConversationsDemo({ on }: { readonly on: boolean }) {
  const lines = on
    ? ['$ codex resume', '3 conversations', '✓ shown here, read only']
    : ['$ codex resume', '3 conversations', '· not read by Ferretry'];
  return (
    <div
      className="ob-demo"
      role="img"
      aria-label={on ? 'Your terminal conversations are shown here, read only' : 'Your terminal conversations stay out'}
      data-demo={on ? 'conversations-on' : 'conversations-off'}
      key={on ? 'on' : 'off'}
    >
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
