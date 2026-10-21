/**
 * The one sentence a settings field shows when the machine's value moved while the person was editing
 * it (`useKeptDraft().changedElsewhere`): their text is kept, and loading the new value is one press.
 */

import { RefreshCw } from 'lucide-react';

const CHANGED_ELSEWHERE_SENTENCE = 'This was changed elsewhere while you were editing. Your text is kept.';

export function ChangedElsewhereNote({ onReload, field }: { readonly onReload: () => void; readonly field: string }) {
  return (
    <p
      role="status"
      className="m-0 mt-1 flex flex-wrap items-center gap-2 rounded-control border border-warn-border bg-warn-bg px-2 py-1 text-meta leading-base text-warn"
      data-changed-elsewhere={field}
    >
      <span className="min-w-0">{CHANGED_ELSEWHERE_SENTENCE}</span>
      <button type="button" className="kt-btn min-h-[44px]" data-changed-elsewhere-reload={field} onClick={onReload}>
        <RefreshCw size={14} aria-hidden="true" />
        Load the new value
      </button>
    </p>
  );
}
