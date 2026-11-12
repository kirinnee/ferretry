import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { RUNTIME_START_KEY, RuntimeStart } from '../../../../contract/index.ts';
import { FakeRuntimeStart } from '../../../../contract/testing/index.ts';

/** A stand-in Runtimes for a Ferrets half booted whole: it lets every login through (see {@link FakeRuntimeStart}). */
export const runtimesPlugin = () =>
  implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'Runtimes (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: RuntimeStart, key: RUNTIME_START_KEY }] },
    }),
    { build: () => ({ hooks: { 'runtime.start:runtimes': new FakeRuntimeStart() } }) },
  );
