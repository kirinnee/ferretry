/**
 * A FAKE PLUGIN'S STEPS, for every plugin unit and the setup flow's shots (r10 O1): three daemon steps (the second is
 * conditional: it skips when the segment memory says `mode: 'everything'`) and one client step. Pages are in `pages.tsx`;
 * this file is data only. Fake names, no secrets.
 */
import type { StepView } from '../../../contract/index.ts';

export const FAKE_PLUGIN = 'fake-pack';

const step = (id: string, title: string, order: number, side: 'daemon' | 'client', group?: string): StepView => ({
  plugin: FAKE_PLUGIN,
  id,
  title,
  order,
  side,
  state: 'pending',
  ...(group === undefined ? {} : { group }),
});

/** What one daemon with the fake plugin returns from `GET /v1/onboarding` (plus Onboarding's own two pages). */
export const fakeStepViews = (options: { readonly withFake?: boolean } = {}): readonly StepView[] => [
  { plugin: 'onboarding', id: 'name', title: 'Name this machine', order: 5, side: 'daemon', state: 'pending' },
  { plugin: 'onboarding', id: 'appearance', title: 'Appearance', order: 1, side: 'client', state: 'pending' },
  ...(options.withFake === false
    ? []
    : [
        step('welcome', 'Welcome', 20, 'daemon', 'Fake Pack'),
        step('choose', 'Choose how', 21, 'daemon', 'Fake Pack'),
        step('finish', 'Finish', 22, 'daemon', 'Fake Pack'),
        step('look', 'How it looks', 3, 'client', 'Fake Pack'),
      ]),
];

export const fakeDaemon = (id: string, name: string, options: { readonly withFake?: boolean } = {}) => ({
  id,
  name,
  steps: fakeStepViews(options),
});
