/**
 * THE RICH TEXT TOOLBAR — one row of formatting buttons above the composer when the editor style is
 * Rich text.
 *
 * Each button is a `FormatCommand` (`lib/live-markdown.ts`) applied to the draft at the editor's
 * selection, so a button and its ⌘/Ctrl shortcut are one edit, and what is sent stays markdown. The
 * shortcut is in every button's tooltip.
 *
 * A button never takes focus from the editor: its `mousedown` is cancelled, so the selection it
 * formats is still the one the reader made. Were it to move anyway (a touch), the editor remembers
 * its selection while unfocused, so the edit lands in the same place.
 */

import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  type LucideIcon,
  SquareCode,
  Strikethrough,
  TextQuote,
} from 'lucide-react';
import type { FormatCommand } from '../lib/live-markdown.ts';

interface ToolbarAction {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly command: FormatCommand;
  /** The shortcut after the modifier, e.g. `B` for ⌘B; `null` when there is none. */
  readonly keys: string | null;
}

const ACTIONS: readonly ToolbarAction[] = [
  { label: 'Bold', icon: Bold, command: { kind: 'wrap', marker: '**' }, keys: 'B' },
  { label: 'Italic', icon: Italic, command: { kind: 'wrap', marker: '*' }, keys: 'I' },
  { label: 'Strikethrough', icon: Strikethrough, command: { kind: 'wrap', marker: '~~' }, keys: '⇧X' },
  { label: 'Inline code', icon: Code, command: { kind: 'wrap', marker: '`' }, keys: 'E' },
  { label: 'Heading', icon: Heading1, command: { kind: 'block', target: 'h1' }, keys: '⌥1' },
  { label: 'Subheading', icon: Heading2, command: { kind: 'block', target: 'h2' }, keys: '⌥2' },
  { label: 'Bulleted list', icon: List, command: { kind: 'block', target: 'bullet' }, keys: '⇧8' },
  { label: 'Numbered list', icon: ListOrdered, command: { kind: 'block', target: 'ordered' }, keys: '⇧7' },
  { label: 'Checklist', icon: ListTodo, command: { kind: 'block', target: 'check' }, keys: null },
  { label: 'Quote', icon: TextQuote, command: { kind: 'block', target: 'quote' }, keys: '⇧9' },
  { label: 'Code block', icon: SquareCode, command: { kind: 'codeBlock' }, keys: '⌥C' },
];

export interface ComposerFormatToolbarProps {
  readonly onFormat: (command: FormatCommand) => void;
  /** How this platform spells the shortcut modifier: `⌘` or `Ctrl+`. */
  readonly modifier: string;
  readonly disabled?: boolean;
}

export function ComposerFormatToolbar({ onFormat, modifier, disabled = false }: ComposerFormatToolbarProps) {
  return (
    <div aria-label="Formatting" className="fy-composer-toolbar" data-composer-toolbar="" role="toolbar">
      {ACTIONS.map(action => {
        const Icon = action.icon;
        const title = action.keys === null ? action.label : `${action.label} (${modifier}${action.keys})`;
        return (
          <button
            aria-label={action.label}
            className="fy-composer-tool"
            data-format={action.label}
            disabled={disabled}
            key={action.label}
            onClick={() => onFormat(action.command)}
            onMouseDown={event => event.preventDefault()}
            title={title}
            type="button"
          >
            <Icon aria-hidden="true" size={16} strokeWidth={2.25} />
          </button>
        );
      })}
    </div>
  );
}
