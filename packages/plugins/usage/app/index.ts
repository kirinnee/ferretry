import { provideToShell } from '@ferretry/app';
import { implementApp, type PanelProps } from '@ferretry/kernel/manifest';
import type { FerretListRowMarkSlotProps } from '@ferretry/core-ferrets/contract';
import type { LoginMeterSlotProps } from '@ferretry/plugin-logins/contract';
import type { ComposerToolsProps } from '@ferretry/plugin-conversation/contract';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { usageCommands } from './command-bar.ts';
import { browserLongTaskObserver, observeLongTasks } from './lib/performance/main-thread.ts';
import { PerformanceRecorder } from './lib/performance/recorder.ts';
import { recordingClient } from './lib/performance/recording-client.ts';
import { BudgetMeter } from './features/settings/budget-meter.tsx';
import { forgetUsageOf, holdUsageStore } from './lib/forget-usage.ts';
import { daemonUsagePort } from './lib/usage-store.ts';
import { DaemonUsageStore } from './lib/usage-store.ts';
import {
  BudgetsTab,
  ComposerQuotaPanel,
  FerretInsightsPanel,
  FerretUsageInfoPanel,
  InsightsScreen,
  ModelPricingTab,
  PerformanceTab,
  QuotaPanel,
  SpendTodayPanel,
} from './views.tsx';

/**
 * The Usage app half (§2.3): the Insights screens, the quota on a ferret's row in the list, a ferret's own insights beside
 * it, and Settings › Budgets, Model pricing and Performance. Each view is today's component, given the daemon's
 * client the shell built this half with (§9.6). The shell builds one half per daemon, so the feed store and the
 * performance recorder below belong to one daemon each.
 */
const half = implementApp(manifest, {
  build: ({ client: shellClient }) => {
    // This browser's half of a performance report: every call this half makes, by route pattern.
    const recorder = new PerformanceRecorder({ now: () => globalThis.performance.now() });
    observeLongTasks(recorder, browserLongTaskObserver());
    const client = recordingClient(shellClient, recorder);
    const usage = new DaemonUsageStore(daemonUsagePort(client));
    holdUsageStore(shellClient, usage);
    return {
      screens: {
        insights: () => createElement(InsightsScreen, { client, view: 'overview' }),
        'insights-query': () => createElement(InsightsScreen, { client, view: 'query' }),
      },
      panels: {
        // `props` are Ferrets' (`ferrets.list-row-mark`): narrowed here, a row that hands none draws nothing.
        quota: (props: PanelProps & Partial<FerretListRowMarkSlotProps>) =>
          createElement(QuotaPanel, {
            store: usage,
            ...(typeof props.login === 'string' ? { login: props.login } : {}),
          }),
        'composer-quota': (props: PanelProps & Partial<ComposerToolsProps>) =>
          createElement(ComposerQuotaPanel, {
            store: usage,
            ...(props.account === undefined ? {} : { account: props.account }),
          }),
        usage: ({ subject }) =>
          createElement(FerretUsageInfoPanel, { client, store: usage, ...(subject === undefined ? {} : { subject }) }),
        'spend-today': () => createElement(SpendTodayPanel, { client }),
        // `logins.login-meter`: Logins' card hands the budget the list carries; this draws its meter.
        'login-budget': (props: PanelProps & Partial<LoginMeterSlotProps>) =>
          props.budget === undefined
            ? null
            : createElement(BudgetMeter, { budget: props.budget, machineName: props.machineName ?? 'this machine' }),
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

// S12: an unpaired machine's cached usage leaves this browser with it.
export default provideToShell(half, { commands: usageCommands, forget: forgetUsageOf });
