import type { ToTestCard } from '../../lib/to-test-inbox.ts';
import { StackPager } from './stack-pager.tsx';
import { type ToTestAnswers, ToTestList } from './to-test-rows.tsx';

/** One card waiting for a try, as a step of the Inbox's quick-answer run: where it is in the run, then the shared row. */
export function ToTestStep({
  row,
  index,
  total,
  answers,
  now,
  onNavigate,
  onPrevious,
  onNext,
}: {
  readonly row: ToTestCard;
  readonly index: number;
  readonly total: number;
  readonly answers: ToTestAnswers;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly onPrevious: (() => void) | undefined;
  readonly onNext: (() => void) | undefined;
}) {
  return (
    <section aria-label="Card to test" className="fy-inbox-step" data-inbox-open-to-test={row.key}>
      <div className="fy-inbox-step__bar">
        <span className="fy-inbox-step__rank">Ready to test</span>
        <div className="fy-inbox-step__pager">
          <StackPager index={index} noun="card" onNext={onNext} onPrevious={onPrevious} total={total} />
        </div>
      </div>
      <ToTestList answers={answers} now={now} onNavigate={onNavigate} rows={[row]} />
    </section>
  );
}
