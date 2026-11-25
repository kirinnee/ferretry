import { useEffect, useRef } from 'react';
import { BrandMark } from '../ui/brand-mark.tsx';
import { DEVICE_SETTINGS_HREF, HOME_HREF, pairAgainHref } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { useRuntimeVersion, useShell } from './context.tsx';
import { PAIR_SCREEN } from './first-run.ts';
import { Link } from './link.tsx';
import { describeStop, type StopFacts } from './machine-stop.ts';
import './machine-stop-page.css';

/**
 * THE ONE FULL-PAGE SCREEN for a machine this browser cannot use at all (`machine-stop.ts` says which states and in what
 * words). It replaces the whole frame, never a line over a drawer and nav that could do nothing: a headline in plain words,
 * one sentence of why, one main button, and quieter ways out. The headline takes focus when the page appears (a screen reader
 * reads it once, from the focus: the page adds no live region of its own), and a reference line is for a person helping.
 */
export function MachineStopPage({ daemon, facts }: { readonly daemon: string | undefined; readonly facts: StopFacts }) {
  const { runtime, views, routes } = useShell();
  useRuntimeVersion(runtime);
  const { navigate } = useRouter();
  const headline = useRef<HTMLHeadingElement>(null);
  const stop = describeStop(facts);
  // Focus follows the state, not every render: a machine that moves from one stop to another is a new page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stop.kind` IS the trigger.
  useEffect(() => {
    headline.current?.focus({ preventScroll: true });
  }, [stop.kind]);
  const others = runtime.daemons.snapshot().daemons.filter(paired => paired.daemon !== daemon);
  const pair = views.screens.get(PAIR_SCREEN);
  const main = (): void => {
    switch (stop.primary.action) {
      case 'pair-again':
        if (daemon !== undefined) navigate(pairAgainHref(daemon));
        return;
      case 'reload':
        window.location.reload();
        return;
      case 'pair-new':
        navigate(pair === undefined ? HOME_HREF : routes.href(pair, {}));
        return;
    }
  };
  return (
    <section className="fy-stop" data-machine-stop={stop.kind} aria-labelledby="fy-stop-headline">
      <div className="fy-stop__card">
        <BrandMark size={28} className="fy-stop__mark" />
        <h1 id="fy-stop-headline" ref={headline} tabIndex={-1} className="fy-stop__headline">
          {stop.headline}
        </h1>
        <p className="fy-stop__why">{stop.why}</p>
        {stop.command === undefined ? null : <code className="fy-stop__command">{stop.command}</code>}
        <button
          type="button"
          className="kt-btn fy-stop__main"
          data-variant="primary"
          data-device-refused-pair={stop.primary.action === 'pair-again' ? '' : undefined}
          onClick={main}
        >
          {stop.primary.label}
        </button>
        <p className="fy-stop__ways" data-whole-daemon-connection="">
          <Link to={DEVICE_SETTINGS_HREF}>Connection settings</Link>
          {others.length === 0 ? null : (
            <>
              <span aria-hidden="true"> · </span>
              <Link to={HOME_HREF}>Use another machine</Link>
            </>
          )}
        </p>
        <p className="fy-stop__reference">{stop.reference}</p>
      </div>
    </section>
  );
}
