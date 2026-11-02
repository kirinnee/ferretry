/**
 * THE ONE SHAPE of a standing sign-in rule's words, drawn by every rule screen (the card, the sheet, the machine view,
 * Settings): one plain line of what it does, the facts as label/value rows, ONE red block (at most two short sentences,
 * from the structured flags alone), an amber note for an auto-applied recipe, and the kernel-proof detail behind a
 * collapsed "How it's checked". The passkey dialog draws the same rows and red block from the same structure.
 */

import { TriangleAlert } from 'lucide-react';
import { checkedWords, flagSentences, type RuleFlag, type RuleRow } from '../../lib/sign-in-rules.ts';

export interface SignInRuleWordsProps {
  readonly does: string;
  readonly rows: readonly RuleRow[];
  readonly flags: readonly RuleFlag[];
  /** Muted line under the rows (the create sheet's "You signed in here yourself N times."). */
  readonly note?: string | undefined;
}

export function SignInRuleWords({ does, rows, flags, note }: SignInRuleWordsProps) {
  const red = flags.filter(flag => flag.tone === 'err');
  const amber = flags.filter(flag => flag.tone === 'warn');
  const root = flags.some(flag => flag.name === 'root');
  return (
    <div className="flex min-w-0 flex-col gap-2" data-rule-words="">
      <p className="m-0 min-w-0 break-words text-ui font-medium leading-base text-fg" data-rule-does="">
        {does}
      </p>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-meta" data-rule-rows="">
        {rows.map(row => (
          <div className="contents" data-rule-row={row.label} key={`${row.label}\n${row.value}`}>
            <dt className="text-muted">{row.label}</dt>
            <dd className="m-0 min-w-0 break-words text-fg">{row.value}</dd>
          </div>
        ))}
      </dl>
      {note === undefined ? null : (
        <p className="m-0 text-meta text-muted" data-rule-note="">
          {note}
        </p>
      )}
      {red.length === 0 ? null : (
        <div
          className="flex items-start gap-1.5 rounded-control border border-err-border bg-err-bg px-2 py-1.5 text-meta leading-base text-err"
          data-rule-warnings=""
          role="note"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
          <div className="flex min-w-0 flex-col gap-1">
            {red.flatMap(flag =>
              flagSentences([flag]).map((line, index) => (
                <p className="m-0 break-words" data-rule-flag={index === 0 ? flag.name : undefined} key={line}>
                  {line}
                </p>
              )),
            )}
          </div>
        </div>
      )}
      {amber.map(flag => (
        <p
          className="m-0 flex items-start gap-1.5 text-meta font-medium text-warn"
          data-rule-flag={flag.name}
          key={flag.name}
          role="note"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
          <span className="min-w-0 break-words">{flag.words}</span>
        </p>
      ))}
      <details className="text-meta text-muted" data-rule-checked="">
        <summary className="min-h-[44px] cursor-pointer py-3 text-meta font-medium text-muted">
          How it&rsquo;s checked
        </summary>
        <div className="flex flex-col gap-1">
          {checkedWords(root).map(line => (
            <p className="m-0 break-words" key={line}>
              {line}
            </p>
          ))}
        </div>
      </details>
    </div>
  );
}
