/**
 * Settings › Appearance › Message marks: what the clock, ticks and ! under a message mean.
 *
 * It holds no state and no choice — it is a key to the marks drawn in the transcript, printed from
 * `RECEIPT_LEGEND` and drawn with the same `ReceiptMark`, so the key can never describe a mark the
 * transcript no longer draws.
 */

import { ReceiptMark } from '../../components/receipt-mark.tsx';
import { RECEIPT_LEGEND } from '../../lib/send-receipt.ts';

export function MessageMarksLegend() {
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-2" data-message-marks-legend="">
      {RECEIPT_LEGEND.map(row => (
        <div className="contents" key={row.kind}>
          <dt
            className={
              row.kind === 'answered'
                ? 'flex items-center gap-2 text-accent'
                : row.kind === 'failed'
                  ? 'flex items-center gap-2 text-err'
                  : 'flex items-center gap-2 text-muted'
            }
          >
            <span aria-hidden="true" className="inline-flex w-5 justify-center" data-legend-mark={row.kind}>
              <ReceiptMark kind={row.kind} />
            </span>
            <span className="text-ui font-semibold text-fg">{row.name}</span>
          </dt>
          <dd className="m-0 min-w-0 text-meta leading-base text-muted">{row.meaning}</dd>
        </div>
      ))}
    </dl>
  );
}
