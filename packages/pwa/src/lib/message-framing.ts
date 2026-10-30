// THE APP NEVER SHOWS FRAMING. A producer may put "[ferretry] [board] …", "[re !A12 …]" or a peer envelope and its
// "No reply needed…" footer on the front or back of what the agent is typed, because the agent has no other way to
// know who spoke. A person reads none of it: the words are the bubble, and who said them is a small sender chip.

import { parseFerretryNotice, parsePeerEnvelope } from '@ferretry/protocol';

/** A leading producer tag: `[ferretry]`, `[board]`, `[agenda]`, `[warden]`, `[re !A12 …]`, `[answer to !A3 …]`. */
const LEADING_TAG = /^\s*\[(ferretry|board|agenda|warden|learning|re\s[^\]\n]*|answer to\s[^\]\n]*)\]\s*/iu;
const TRAILING_FOOTER = /\n*No reply needed\.[^\n]*\s*$/u;

export interface FramedText {
  /** The words, with every tag, envelope and footer taken off. */
  readonly body: string;
  /** The producer feature a tag named (`Board`, `Agenda`…), when one did and it is not `Ferretry` itself. */
  readonly feature?: string;
  /** A tag or notice marked this as Ferretry's own message. */
  readonly ferretry: boolean;
}

const title = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;

export const stripFraming = (text: string): FramedText => {
  let rest = text;
  let ferretry = false;
  let feature: string | undefined;
  const peer = parsePeerEnvelope(rest.trimStart());
  if (peer !== null) rest = peer.body;
  const notice = parseFerretryNotice(rest);
  if (notice !== null) {
    ferretry = true;
    rest = notice;
  }
  for (let match = LEADING_TAG.exec(rest); match !== null; match = LEADING_TAG.exec(rest)) {
    const tag = (match[1] ?? '').toLowerCase();
    if (tag === 'ferretry') ferretry = true;
    else {
      ferretry = ferretry || tag === 'board' || tag === 'warden' || tag === 'learning';
      feature ??= tag.startsWith('re ') || tag.startsWith('answer to') ? 'Agenda' : title(tag);
    }
    rest = rest.slice(match[0].length);
  }
  const body = rest.replace(TRAILING_FOOTER, '').trim();
  return { body, ...(feature === undefined ? {} : { feature }), ferretry };
};

/** The sender chip for a Ferretry message: `Ferretry · Board`, or `Ferretry` alone. */
export const ferretryChip = (framed: FramedText): string =>
  framed.feature === undefined ? 'Ferretry' : `Ferretry · ${framed.feature}`;

/** The chip from the daemon's own word on who sent a queued message; `undefined` for the owner or when it is silent. */
export const chipFromSender = (
  by: { readonly kind: 'owner' | 'ferret' | 'ferretry'; readonly name?: string; readonly feature?: string } | undefined,
  nameOf: (name: string) => string,
): string | undefined => {
  if (by === undefined || by.kind === 'owner') return undefined;
  if (by.kind === 'ferret') return by.name === undefined ? undefined : nameOf(by.name);
  return ferretryChip({ body: '', ferretry: true, ...(by.feature === undefined ? {} : { feature: by.feature }) });
};
