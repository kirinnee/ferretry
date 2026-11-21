/**
 * The browser entry for the first-run Start page (r11 O14): the REAL "Start fresh / Copy from another machine" step body,
 * drawn the way the setup flow draws it: inside Onboarding's REAL setup flow (`createSetupFlow`, reached through its `flow`
 * screen), so the footer's Next is the real Next and the answer it records is the production one. One fake machine answers
 * from memory; no daemon, no network. Every name is made up.
 *
 *   ?theme=<family>-<mode>
 *
 * Every call the page or the flow makes is recorded: `window.__calls` is the route keys in order, and `window.__answers` is
 * the step answers the machine was sent (`POST /v1/onboarding/steps/:plugin/:stepId`, as `<plugin>.<step>=<state>`), so a
 * test can prove "choosing a card writes nothing settings-wise, and Next records the step done exactly once".
 */

import {
  deviceViewHarness,
  fakeReachRow,
  noteClientDaemon,
  type PlacedPanel,
  WithSlotPanels,
} from '@ferretry/app/testing/flow-host';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import onboardingApp from '@ferretry/plugin-onboarding/app';
import onboardingManifest from '@ferretry/plugin-onboarding/manifest';
import { createElement, type FunctionComponent } from 'react';
import { createRoot } from 'react-dom/client';
import { createStartStep } from '../../../../app/views/setup-transfer.tsx';
import { type Call, READS, scripted } from '../../../unit/app/features/fleet/account-support.ts';

declare global {
  interface Window {
    __calls: string[];
    __answers: string[];
  }
}

const DAEMON = 'fy_daemon_studio';
const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
window.__answers = [];

const STEP = {
  plugin: 'runtimes',
  id: 'start',
  title: 'Start from',
  order: 10,
  side: 'daemon' as const,
  stepHost: true,
};

const calls: Call[] = [];
const client = {
  ...scripted(
    {
      ...READS(),
      // What the flow reads (the machine's steps) and writes (an answer): the machine keeps nothing, it only counts.
      'GET /v1/onboarding': { steps: [{ ...STEP, state: 'pending' }], complete: false, setUp: false },
      'POST /v1/onboarding/steps/:plugin/:stepId': (call: Call) => {
        const body = call.body as { state: string };
        window.__answers.push(`${call.params?.plugin ?? ''}.${call.params?.stepId ?? ''}=${body.state}`);
        return { ...STEP, state: body.state };
      },
    },
    calls,
  ),
  subscribe: () => () => undefined,
};
noteClientDaemon(client as unknown as PluginClient, DAEMON);
// The page's calls are read live: `calls` is the scripted client's own log.
Object.defineProperty(window, '__calls', { get: () => calls.map(call => call.route) });

const Start = createStartStep(client) as unknown as FunctionComponent<PanelProps>;
const placed: PlacedPanel[] = [
  { plugin: 'runtimes', id: 'onboarding-start', view: props => createElement(Start, props as unknown as PanelProps) },
];
const Flow = onboardingApp.build?.({ manifest: onboardingManifest, client } as never)?.screens?.flow;
if (Flow === undefined) throw new Error('the onboarding plugin has no flow screen');

const harness = deviceViewHarness({ plugin: 'onboarding', fragments: [] });
harness.setRows([fakeReachRow({ daemon: DAEMON, machine: 'Studio', client: client as unknown as PluginClient })]);

createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ height: '100vh', overflow: 'auto' }}>
    <harness.Harness place="daemon">
      <WithSlotPanels slots={{ 'onboarding.step': placed }}>
        {createElement(Flow as never, { params: {} })}
      </WithSlotPanels>
    </harness.Harness>
  </div>,
);
requestAnimationFrame(() => {
  document.body.dataset.scene = 'ready';
});
