/**
 * THE SETUP FLOW SCREEN (`/d/<machine>/onboarding/setup`): every plugin's declared steps as ONE multi-page stepper, drawn
 * alone (the screen declares `chrome: 'none'`: no drawer, no bottom nav, no side column) over the living background.
 *
 * It decides nothing about any plugin's page: `flow-model.ts` walks them, `use-setup-flow.ts` records the answers, and
 * `page-frame.tsx` draws one page under its loading cover.
 */
import { PanelSlot } from '@ferretry/app';
import { Button, LivingBackground, Loading } from '@ferretry/app/ui';
import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { ONBOARDING_STEP_SLOT } from '../../../contract/index.ts';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { EndPage } from './end-page.tsx';
import { NextPagePrefetch } from './next-page-prefetch.tsx';
import { type FlowDeps, useSetupFlow } from './use-setup-flow.ts';
import { FlowPage } from './page-frame.tsx';
import { END } from './flow-model.ts';
import './flow.css';

/**
 * Every page of the flow opens at its top. The shell's main area (not the flow) owns the scroll, so a long page left
 * scrolled (Voice with every engine shown) carried its offset onto the next page and drew the End heading above the fold.
 * On each arrival the scroll of every scrolling ancestor, and of the window, goes back to 0 before the page paints.
 */
function resetScroll(from: HTMLElement | null): void {
  for (let el = from; el !== null; el = el.parentElement) if (el.scrollTop !== 0) el.scrollTop = 0;
  if (window.scrollY !== 0) window.scrollTo(0, 0);
}

/** The plugin whose last page is project setup: its step memory says where the end page goes on. */
const PROJECTS_PLUGIN = 'projects';

export function createSetupFlow(client: PluginClient, deps: FlowDeps = {}) {
  return function SetupFlow(_props: ScreenProps): ReactNode {
    const flow = useSetupFlow(client, deps);
    const root = useRef<HTMLDivElement>(null);
    // One arrival per page visit (the key of the page and which visit of it), so a re-render alone never moves the scroll.
    const here = `${flow.at}:${flow.visit}`;
    const arrivedAt = useRef<string | undefined>(undefined);
    useLayoutEffect(() => {
      if (arrivedAt.current === here) return;
      arrivedAt.current = here;
      resetScroll(root.current);
    }, [here]);
    const body = ((): ReactNode => {
      if (flow.loading === 'failed')
        return (
          <div className="fy-sf-fail" data-flow-failed="">
            <p role="alert" className="fy-sf-note">
              Could not read the setup steps from this machine.
            </p>
            <Button onClick={flow.retry} data-flow-retry="">
              Try again
            </Button>
          </div>
        );
      if (flow.loading === 'loading' || flow.target === undefined)
        return (
          <div className="fy-sf-cover" data-flow-loading="">
            <Loading kind="page" label="Looking at what this machine can set up…" />
          </div>
        );
      if (flow.at === END || flow.page === undefined) {
        // Project setup (the last page) leaves where its project is: the end page opens it instead of the machine's Home.
        const { openLabel, openHref } = flow.memoryOf(PROJECTS_PLUGIN);
        return (
          <EndPage
            daemon={flow.target}
            {...(typeof openLabel === 'string' && typeof openHref === 'string'
              ? { opens: { label: openLabel, href: openHref } }
              : {})}
            onBack={flow.canBack ? () => flow.back(END, flow.visit) : undefined}
            summary={flow.summary}
            unsaved={flow.unsaved}
            onRetry={flow.retryStep}
          />
        );
      }
      const { page, visit } = flow;
      return (
        <FlowPage
          key={page.key}
          step={page}
          daemon={
            page.appliesTo.some(row => row.daemon === flow.target)
              ? flow.target
              : (page.appliesTo[0]?.daemon ?? flow.target)
          }
          progress={flow.progress}
          direction={flow.direction}
          canBack={flow.canBack}
          segment={() => flow.memoryOf(page.plugin)}
          remember={patch => flow.remember(page.plugin, patch)}
          onDone={() => flow.done(page)}
          onSkip={why => flow.skip(page, why, visit)}
          onNotNeeded={() => flow.notNeeded(page, visit)}
          onNext={() => flow.next(page.key, visit)}
          onBack={() => flow.back(page.key, visit)}
          onLater={() => flow.later(page, visit)}
          {...(page.plugin === PROJECTS_PLUGIN ? { laterLabel: 'Skip for now' } : {})}
          unsaved={flow.unsaved.length === 0 ? undefined : { count: flow.unsaved.length, retry: flow.retrySave }}
          {...(deps.silenceMs === undefined ? {} : { silenceMs: deps.silenceMs })}
          {...(deps.report === undefined ? {} : { report: deps.report })}
        />
      );
    })();
    const { target, upcoming } = flow;
    return (
      <div className="fy-sf-root" ref={root} data-setup-flow="" data-journey={flow.journey}>
        <LivingBackground />
        {body}
        {target === undefined ? null : (
          // The next pages, drawn hidden while this one shows, so their first real draw does not wait out React's 300 ms hold.
          <NextPagePrefetch
            steps={upcoming}
            render={(host, step) => (
              <PanelSlot
                daemon={
                  step.appliesTo.some(row => row.daemon === target) ? target : (step.appliesTo[0]?.daemon ?? target)
                }
                slot={ONBOARDING_STEP_SLOT}
                subject={step.key}
                props={{ step: host }}
              />
            )}
          />
        )}
      </div>
    );
  };
}
