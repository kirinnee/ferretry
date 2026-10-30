/**
 * THE HELD CONFIGURATION CHANGE AN AGENDA CARD CONFIRMS (docs/agenda.md § Confirming a configuration change).
 *
 * A ferret's edit that loosens what the machine may spend or do waits for the owner; the card it raises with
 * `fy agenda add --confirms <file>` carries that change (`item.confirms`), and the owner's Allow puts it into
 * effect. This block is the change itself, read before answering: each loosening as "what: before → after"
 * where the daemon's words say so, the line that says Allow applies it, and — when the change was edited
 * after the card was raised — a warning to read it again, since the card now shows the new one.
 *
 * It draws nothing for an item that confirms nothing. It sends nothing: the card's own answers (Allow, Deny,
 * Discard change) do, and the daemon decides whether the change is still the one shown.
 */

import type { AttentionItem } from '@ferretry/protocol';
import { FileCog, TriangleAlert } from 'lucide-react';

/** One loosening, split into what moves and its two values when the daemon's words name them. */
export interface ConfigChangeLine {
  readonly what: string;
  readonly from?: string;
  readonly to?: string;
}

const MOVED = /^(?<what>.+?) goes (?:up|down) from (?<from>\S+) to (?<to>\S+)$/u;

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * "the Jev price the cap counts with goes down from 2 to 0.042" read as its subject and the two values, so it
 * is drawn "The Jev price the cap counts with: 2 → 0.042"; any other loosening is one sentence as written.
 */
export function configChangeLine(words: string): ConfigChangeLine {
  const moved = MOVED.exec(words.trim())?.groups;
  if (moved?.what === undefined || moved.from === undefined || moved.to === undefined) {
    return { what: capitalised(words.trim()) };
  }
  return { what: capitalised(moved.what), from: moved.from, to: moved.to };
}

function ChangeLine({ line }: { readonly line: ConfigChangeLine }) {
  if (line.from === undefined || line.to === undefined) return <li className="fy-attn-change__item">{line.what}</li>;
  return (
    <li className="fy-attn-change__item">
      {line.what}:{' '}
      <span className="fy-attn-change__values">
        <span className="fy-attn-change__from">{line.from}</span>
        <span aria-hidden="true"> → </span>
        <span className="sr-only"> becomes </span>
        <strong className="fy-attn-change__to">{line.to}</strong>
      </span>
    </li>
  );
}

/** The change an item confirms, or nothing when it confirms none. */
export function AttentionConfigChange({ item }: { readonly item: Pick<AttentionItem, 'confirms'> }) {
  const confirms = item.confirms;
  if (confirms === undefined) return null;
  return (
    <section
      aria-label={`The change to ${confirms.path} that Allow applies`}
      className="fy-attn-change"
      data-attention-confirms={confirms.path}
    >
      {confirms.restated === true ? (
        <p className="fy-attn-change__restated" data-attention-restated="">
          <TriangleAlert aria-hidden="true" size={14} />
          This change was edited after it was raised. Read it again before you answer.
        </p>
      ) : null}
      <p className="fy-attn-change__head">
        <FileCog aria-hidden="true" size={14} />
        <span>
          Held change to <code>{confirms.path}</code>
        </span>
      </p>
      <ul className="fy-attn-change__list">
        {confirms.changes.map(words => (
          <ChangeLine key={words} line={configChangeLine(words)} />
        ))}
      </ul>
      <p className="fy-attn-change__allow" data-attention-allow-applies="">
        <strong>Allow applies this change.</strong> Deny keeps it held; Discard change puts {confirms.path} back.
      </p>
    </section>
  );
}
