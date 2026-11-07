import { implementApp } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { browserLongTaskObserver, observeLongTasks } from './lib/performance/main-thread.ts';
import { PerformanceRecorder } from './lib/performance/recorder.ts';
import { recordingClient } from './lib/performance/recording-client.ts';
import { daemonUsagePort } from './lib/usage-store.ts';
import { DaemonUsageStore } from './lib/usage-store.ts';
import {
  BudgetsTab,
  ComposerQuotaPanel,
  FerretInsightsPanel,
  InsightsScreen,
  ModelPricingTab,
  PerformanceTab,
  QuotaPanel,
} from './views.tsx';

/**
 * The Usage app half (§2.3): the Insights screens, the quota readout in the top bar, a ferret's own insights beside
 * it, and Settings › Budgets, Model pricing and Performance. Each view is today's component, given the daemon's
 * client the shell built this half with (§9.6). The shell builds one half per daemon, so the feed store and the
 * performance recorder below belong to one daemon each.
 */
export default implementApp(manifest, {
  build: ({ client: shellClient }) => {
    // This browser's half of a performance report: every call this half makes, by route pattern.
    const recorder = new PerformanceRecorder({ now: () => globalThis.performance.now() });
    observeLongTasks(recorder, browserLongTaskObserver());
    const client = recordingClient(shellClient, recorder);
    const usage = new DaemonUsageStore(daemonUsagePort(client));
    return {
      screens: {
        insights: () => createElement(InsightsScreen, { client, view: 'overview' }),
        'insights-query': () => createElement(InsightsScreen, { client, view: 'query' }),
      },
      panels: {
        quota: ({ subject }) =>
          createElement(QuotaPanel, { store: usage, ...(subject === undefined ? {} : { subject }) }),
        'composer-quota': ({ subject }) =>
          createElement(ComposerQuotaPanel, { store: usage, ...(subject === undefined ? {} : { subject }) }),
        insights: ({ subject }) =>
          createElement(FerretInsightsPanel, { client, ...(subject === undefined ? {} : { subject }) }),
      },
      settings: {
        budgets: () => createElement(BudgetsTab, { client }),
        'model-pricing': () => createElement(ModelPricingTab, { client }),
        performance: () => createElement(PerformanceTab, { client, recorder }),
      },
    };
  },
});
