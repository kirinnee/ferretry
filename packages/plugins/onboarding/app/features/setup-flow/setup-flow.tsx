/**
 * THE SETUP FLOW SCREEN (`/d/<machine>/onboarding/setup`): every plugin's declared steps as ONE multi-page stepper, drawn
 * alone (the screen declares `chrome: 'none'`: no drawer, no bottom nav, no side column) over the living background.
 *
 * It decides nothing about any plugin's page: `flow-model.ts` walks them, `use-setup-flow.ts` records the answers, and
 * `page-frame.tsx` draws one page under its loading cover.
 */
import { Button, LivingBackground, Loading } from '@ferretry/app/ui';
import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { EndPage } from './end-page.tsx';
import { type FlowDeps, useSetupFlow } from './use-setup-flow.ts';
import { FlowPage } from './page-frame.tsx';
import { END } from './flow-model.ts';
import './flow.css';

export function createSetupFlow(client: PluginClient, deps: FlowDeps = {}) {
  return function SetupFlow(_props: ScreenProps): ReactNode {
    const flow = useSetupFlow(client, deps);
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
      if (flow.at === END || flow.page === undefined)
        return (
          <EndPage
            daemon={flow.target}
            onBack={flow.canBack ? () => flow.back(END, flow.visit) : undefined}
            summary={flow.summary}
            unsaved={flow.unsaved}
            onRetry={flow.retryStep}
          />
        );
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
          onSkip={why => flow.skip(page, why)}
          onNext={() => flow.next(page.key, visit)}
          onBack={() => flow.back(page.key, visit)}
          onLater={() => flow.later(page, visit)}
          unsaved={flow.unsaved.length === 0 ? undefined : { count: flow.unsaved.length, retry: flow.retrySave }}
          {...(deps.silenceMs === undefined ? {} : { silenceMs: deps.silenceMs })}
        />
      );
    })();
    return (
      <div className="fy-sf-root" data-setup-flow="" data-journey={flow.journey}>
        <LivingBackground />
        {body}
      </div>
    );
  };
}
