/**
 * What Ferretry asks GitHub for, BEFORE the code is shown. The words are one constant (`consent-words.ts`); this only
 * draws them. `repo` is the strong one and is said plainly in the list, not tucked behind a link.
 */
import { Fragment, useState } from 'react';
import type { GitKeyFormat } from '../../../contract/index.ts';
import { SigningChoice } from './signing-choice.tsx';
import { richParts } from '../../lib/rich.ts';
import {
  CONSENT_CONTINUE,
  CONSENT_HEADING,
  CONSENT_ITEMS,
  CONSENT_LIMIT,
  CONSENT_MEANING,
  CONSENT_MEANING_HEADING,
  GPG_CONSENT_ITEM,
} from './consent-words.ts';

function Rich({ text }: { readonly text: string }) {
  return (
    <>
      {richParts(text).map(part => (
        <Fragment key={part.at}>
          {part.kind === 'bold' ? (
            <strong className="font-semibold text-fg">{part.text}</strong>
          ) : part.kind === 'code' ? (
            <code className="mono text-fg">{part.text}</code>
          ) : (
            part.text
          )}
        </Fragment>
      ))}
    </>
  );
}

export function ConsentCard({
  onContinue,
  onCancel,
}: {
  readonly onContinue: (format: GitKeyFormat) => void;
  readonly onCancel: () => void;
}) {
  const [format, setFormat] = useState<GitKeyFormat>('ssh');
  return (
    <section
      className="flex flex-col gap-3 border-t border-border pt-4"
      aria-labelledby="git-consent-heading"
      data-testid="git-consent"
    >
      <h3 id="git-consent-heading" className="m-0 text-row font-semibold text-fg">
        {CONSENT_HEADING}
      </h3>
      <SigningChoice name="connect-signing" value={format} onChange={setFormat} />
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {[...CONSENT_ITEMS, ...(format === 'gpg' ? [GPG_CONSENT_ITEM] : [])].map(item => (
          <li key={item.title} className="text-cell leading-base text-muted" data-consent-item={item.scopes.join(' ')}>
            <strong className="font-semibold text-fg">{item.title}</strong>{' '}
            <span className="mono text-meta text-faint">({item.scopes.join(', ')})</span>: <Rich text={item.text} />
          </li>
        ))}
      </ul>
      <p className="m-0 text-cell leading-base text-muted">
        <strong className="font-semibold text-fg">{CONSENT_MEANING_HEADING}</strong> <Rich text={CONSENT_MEANING} />
      </p>
      <p className="m-0 text-meta leading-base text-faint">{CONSENT_LIMIT}</p>
      <div className="sticky bottom-0 flex flex-wrap gap-2 bg-surface py-2">
        <button type="button" className="kt-btn min-h-[44px]" data-variant="primary" onClick={() => onContinue(format)}>
          {CONSENT_CONTINUE}
        </button>
        <button type="button" className="kt-btn min-h-[44px]" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
