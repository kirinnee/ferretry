/**
 * "Add a catalog from a link": the PRIMARY way to get a catalog someone shared.
 *
 * A paste field and one button. A share link goes to the same /join page the phone's camera opens, so
 * there is one path into joining. Any other link is named in a sentence; nothing is sent from here and the
 * pasted text is cleared the moment it is handed over, because a share link holds a live code.
 */

import { Link2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { classifyCatalogLink } from '../../lib/catalog-link.ts';
import { joinPath } from '../../lib/pages/routes.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import { Button } from '../../shell/primitives.tsx';
import { FailureLine } from './catalog-parts.tsx';

const ADD_FROM_LINK_TITLE = 'Add a catalog from a link';
const ADD_FROM_LINK_HELP = 'Paste the link someone sent you.';

interface AddCatalogFromLinkProps {
  /** Where a share link goes. Defaults to the router, or the address bar where there is no router. */
  readonly onJoin?: (fragment: string) => void;
}

export function AddCatalogFromLink({ onJoin }: AddCatalogFromLinkProps) {
  const router = useOptionalRouter();
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
    setProblem(null);
    if (onJoin !== undefined) onJoin(link.fragment);
    else if (router !== null) router.navigate(`${joinPath()}${link.fragment}`);
    else window.location.assign(`${joinPath()}${link.fragment}`);
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
          Add
        </Button>
      </div>
      {problem === null ? null : <FailureLine sentence={problem} />}
    </form>
  );
}
