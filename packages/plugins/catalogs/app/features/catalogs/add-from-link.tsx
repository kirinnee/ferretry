/**
 * "Subscribe with a link": the PRIMARY way to follow a catalog someone shared.
 *
 * A paste field and one button. A share link goes to the same /join page the phone's camera opens, so there is one path
 * into joining. Any other link is named in a sentence; nothing is sent from here and the pasted text is cleared the
 * moment it is read, because a share link holds a live code.
 *
 * GAP(shell): the shell mounts no daemon-less screen yet, so /join is not drawn and a link carried there would sit in
 * the address bar and the history, unredeemed. Until it does, a valid share link is refused with a sentence and is
 * NEVER written to the address bar or pushed into the history.
 */

import { Link2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { classifyCatalogLink } from '../../lib/catalog-link.ts';

import { Button } from '@ferretry/app/ui';
import { FailureLine } from './catalog-parts.tsx';

const ADD_FROM_LINK_TITLE = 'Subscribe with a link';
const ADD_FROM_LINK_HELP =
  'Paste the invite link someone sent you. Subscribing installs nothing: you pick what to install.';

/** What a valid share link is answered with while the shell cannot draw the join page. */
export const JOINING_FROM_A_LINK_UNAVAILABLE = "Joining from a link isn't available yet.";

export function AddCatalogFromLink() {
  const inputId = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const link = classifyCatalogLink(text);
    if (link.kind !== 'join') {
      setProblem(link.sentence);
      return;
    }
    setText('');
    setProblem(JOINING_FROM_A_LINK_UNAVAILABLE);
  };

  return (
    <form className="flex min-w-0 flex-col gap-xs" onSubmit={submit} data-catalog-link-form="">
      <label htmlFor={inputId} className="text-meta font-semibold text-muted">
        {ADD_FROM_LINK_TITLE}
      </label>
      <p className="m-0 text-meta text-muted">{ADD_FROM_LINK_HELP}</p>
      <div className="flex min-w-0 items-center gap-xs">
        <input
          id={inputId}
          className="kt-input min-w-0 flex-1"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Paste a link"
          value={text}
          onChange={event => {
            setText(event.target.value);
            setProblem(null);
          }}
          data-catalog-link-input=""
        />
        <Button type="submit" variant="primary" data-catalog-link-add="">
          <Link2 size={16} aria-hidden="true" />
          Subscribe
        </Button>
      </div>
      {problem === null ? null : <FailureLine sentence={problem} />}
    </form>
  );
}
