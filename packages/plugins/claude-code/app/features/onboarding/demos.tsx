/** The small demos Claude's pages show in the frame's demo column: the shared ones from the import kit (Codex's pages draw the same), with Claude's words, and the import and conversations scenes. */
import type { CSSProperties } from 'react';
import {
  InstalledDemo as InstalledDemoBox,
  PermissionDemo as PermissionDemoBox,
} from '@ferretry/plugin-runtimes/import-kit';

/** A terminal line typing `claude --version`, then the answer. */
export const InstalledDemo = () => (
  <InstalledDemoBox command="claude --version" answer="2.1.0 (Claude Code)" label="Claude" />
);

/** An agent that asks before running a command, against one that runs it straight through. */
export const PermissionDemo = ({ mode }: { readonly mode: 'auto' | 'skip' }) => (
  <PermissionDemoBox tool="Claude" mode={mode} />
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
  </div>
);

/** The terminal's conversations, listed in Ferretry or left where they are. */
export const ConversationsDemo = ({ show }: { readonly show: boolean }) => (
  <div
    className="cc-demo"
    data-demo={show ? 'conversations-on' : 'conversations-off'}
    role="img"
    aria-label="Conversations"
  >
    <p className="cc-demo__head">{show ? 'Conversations in Ferretry' : 'Conversations stay in the terminal'}</p>
    {['Fix the login bug', 'Plan the release'].map((title, index) => (
      <p key={title} className="cc-demo__row" data-brought={show} style={{ '--cc-i': index } as CSSProperties}>
        <span>{title}</span>
        <span className="cc-demo__mark" aria-hidden="true">
          {show ? '✓' : '·'}
        </span>
      </p>
    ))}
  </div>
);
