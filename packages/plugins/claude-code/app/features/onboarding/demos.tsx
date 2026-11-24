/** The small demos Claude's pages show in the frame's demo column: Claude's own install, import, kind and conversations scenes. */
import type { CSSProperties } from 'react';

/** A terminal typing the command the Install button runs (the installer's own plan, never made up here), then the answer. */
export const InstalledDemo = ({ command }: { readonly command: string }) => (
  <div
    className="cc-term"
    role="img"
    aria-label={`A terminal running ${command}, then Claude Code is installed`}
    data-demo="installed"
    data-demo-tool="Claude"
  >
    <p className="cc-term__line">
      <span aria-hidden="true">$ </span>
      <span className="cc-term__cmd" data-demo-command="">
        {command}
      </span>
    </p>
    <p className="cc-term__line cc-term__done">Claude Code is installed.</p>
  </div>
);

const ITEMS = ['Settings', 'CLAUDE.md', 'Skills', 'MCP servers'] as const;
/** How many of the four things each answer brings across. */
const BROUGHT: Readonly<Record<'everything' | 'choose' | 'fresh', number>> = { everything: 4, choose: 2, fresh: 0 };

/** The four things Claude Code keeps, and how many reach this machine for the chosen answer. Plays once, rests on its last frame. */
export const ImportDemo = ({ mode }: { readonly mode: 'everything' | 'choose' | 'fresh' }) => (
  <div className="cc-demo" data-demo={`import-${mode}`} role="img" aria-label="What comes over from Claude Code">
    <p className="cc-demo__head">Claude Code → this machine</p>
    {ITEMS.map((item, index) => (
      <p
        key={item}
        className="cc-demo__row"
        data-brought={index < BROUGHT[mode]}
        style={{ '--cc-i': index } as CSSProperties}
      >
        <span>{item}</span>
        <span className="cc-demo__mark" aria-hidden="true">
          {index < BROUGHT[mode] ? '✓' : '·'}
        </span>
      </p>
    ))}
    {mode === 'choose' ? (
      <p className="cc-demo__note" data-demo-example="">
        An example: you tick what comes over.
      </p>
    ) : null}
  </div>
);

/** What each kind page's list becomes on this machine: the kind as Claude Code keeps it, then what Ferretry makes of it. */
const BECOMES: Readonly<
  Record<'settings' | 'model-set' | 'instructions' | 'skills' | 'mcp', readonly [string, string]>
> = {
  settings: ['Settings', 'Ferretry settings'],
  'model-set': ['Models', 'A model set'],
  instructions: ['CLAUDE.md', 'An instruction'],
  skills: ['Skills', 'Ferretry skills'],
  mcp: ['MCP servers', 'Ferretry MCP servers'],
};

/** One kind of thing Claude Code keeps, and what it becomes here. Plays once, rests on its last frame. */
export const KindDemo = ({ kind }: { readonly kind: keyof typeof BECOMES }) => (
  <div className="cc-demo" data-demo={`kind-${kind}`} role="img" aria-label="What this becomes on this machine">
    <p className="cc-demo__head">Claude Code → this machine</p>
    {BECOMES[kind].map((label, index) => (
      <p key={label} className="cc-demo__row" data-brought="true" style={{ '--cc-i': index } as CSSProperties}>
        <span>{label}</span>
        <span className="cc-demo__mark" aria-hidden="true">
          {index === 0 ? '→' : '✓'}
        </span>
      </p>
    ))}
  </div>
);

/** How the terminal's conversations reach Ferretry: read, one way. Generic words on purpose: it never shows a made-up conversation as found. */
export const ConversationsDemo = () => (
  <div className="cc-demo" data-demo="conversations" role="img" aria-label="An example of conversations read one way">
    <p className="cc-demo__head">Your terminal conversations → Ferretry</p>
    {['A conversation'].map((title, index) => (
      <p key={title} className="cc-demo__row" data-brought="true" style={{ '--cc-i': index } as CSSProperties}>
        <span>{title}</span>
        <span className="cc-demo__mark" aria-hidden="true">
          →
        </span>
      </p>
    ))}
    <p className="cc-demo__note" data-demo-example="">
      An example, not your conversations. Read only.
    </p>
  </div>
);
