/**
 * The React half of a camera scan: one live scan per screen, and never one
 * that outlives the screen.
 *
 * The decode rules live in `lib/pair-scan.ts`. What is here is the part React
 * owns — which phase the surface is in, and the guarantee that unmounting
 * aborts the scan so the camera indicator goes out with the screen. A scan
 * abandoned by navigation is exactly the failure a reader cannot recover from
 * on their own, so the abort is in a cleanup rather than in a handler.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { type QrPreview, type QrScanHost, ScanError } from '../lib/pair-scan.ts';

/**
 * `failed` carries a sentence; `idle` is both "not started" and "stopped on
 * purpose", because a reader who pressed stop needs no explanation of it.
 */
export type QrScanPhase = 'idle' | 'scanning' | 'failed';

export interface QrScanController {
  readonly phase: QrScanPhase;
  /** The refusal to show, or `null` when there is nothing to explain. */
  readonly message: string | null;
  /** Whether this browser can scan at all — false hides the action entirely. */
  readonly supported: boolean;
  readonly start: () => void;
  readonly stop: () => void;
}

interface ScanState {
  readonly phase: QrScanPhase;
  readonly message: string | null;
}

const IDLE: ScanState = { phase: 'idle', message: null };

/**
 * Runs one scan at a time against an injected host.
 *
 * `onText` receives the raw decoded string. This hook does not know what a
 * pairing link is, so a QR from a cereal box arrives here as text and is the
 * caller's problem to reject.
 */
export const useQrScan = (
  host: QrScanHost | null,
  preview: QrPreview,
  onText: (text: string) => void,
): QrScanController => {
  const [state, setState] = useState<ScanState>(IDLE);
  const running = useRef<AbortController | null>(null);
  // The callback is read through a ref so a caller that rebuilds it every
  // render cannot restart a live scan — the effect below depends only on the
  // host, and restarting would drop the camera mid-aim.
  const deliver = useRef(onText);
  deliver.current = onText;

  const stop = useCallback((): void => {
    running.current?.abort();
    running.current = null;
    setState(IDLE);
  }, []);

  useEffect(() => () => running.current?.abort(), []);

  const start = useCallback((): void => {
    if (host === null) return;
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setState({ phase: 'scanning', message: null });
    void host.scan(preview, controller.signal).then(
      text => {
        if (controller.signal.aborted) return;
        running.current = null;
        setState(IDLE);
        deliver.current(text);
      },
      (reason: unknown) => {
        // A stop the reader asked for is not a failure to report back to them.
        if (controller.signal.aborted) return;
        running.current = null;
        setState({
          phase: 'failed',
          message: reason instanceof ScanError ? reason.message : 'The camera could not be started.',
        });
      },
    );
  }, [host, preview]);

  return { phase: state.phase, message: state.message, supported: host?.supported ?? false, start, stop };
};
