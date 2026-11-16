/**
 * ONE FERRET'S LIVE READOUT (Ferrets' `FerretLiveActivity`, kept generic here), as the page's host receives it
 * off the event stream.
 *
 * The host owns the socket (`App.tsx` opens one per session, `?live=1`) and publishes each `live`
 * frame here; the chat page reads the latest. Only the latest is kept — a readout is the present, and
 * an older sample is simply superseded. One hub per daemon and session, built where the stream is, so
 * a sample can never be read as another session's.
 */
export interface LiveActivityFeed<Sample = unknown> {
  readonly subscribe: (listener: () => void) => () => void;
  /** The latest sample, or `null` before the first one. */
  readonly current: () => Sample | null;
}

export interface LiveActivityHub<Sample = unknown> extends LiveActivityFeed<Sample> {
  readonly publish: (live: Sample) => void;
}

export const createLiveActivityHub = <Sample>(): LiveActivityHub<Sample> => {
  const listeners = new Set<() => void>();
  let latest: Sample | null = null;
  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    current: () => latest,
    publish: live => {
      latest = live;
      for (const listener of [...listeners]) listener();
    },
  };
};
