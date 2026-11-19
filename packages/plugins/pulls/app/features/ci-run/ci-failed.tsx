/** A read that did not answer: the daemon's own words, or the one budget sentence with the time in the device's local time. */
import { budgetSentence } from '../../../contract/wire.ts';
import { PauseCircle } from 'lucide-react';
import type { CiFailure } from './ci-api.ts';

export function CiFailedPanel({ failure, onRetry }: { readonly failure: CiFailure; readonly onRetry: () => void }) {
  const until = failure.pausedUntil;
  return (
    <div className="kt-panel m-0 p-panel" role="status" data-ci-failed="true">
      <p className="m-0 flex items-center gap-1.5 text-ui text-fg">
        {until !== undefined && <PauseCircle aria-hidden="true" size={16} className="shrink-0 text-pend" />}
        {until === undefined
          ? failure.message
          : budgetSentence(new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}
      </p>
      {until === undefined && (
        <button type="button" className="kt-btn kt-btn--sm mt-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
