/**
 * Type-level tests for the manifest SDK: a half must implement exactly what its manifest declares.
 * Compiled by `tsc --noEmit`, never run.
 */
import { z } from 'zod';
import { ALLOW, defineEvent, defineHook, definePort, jsonResponse, policyRef } from '../../contract/index.ts';
import { definePlugin, implementCli, implementDaemon, route, tool, verb } from '../../manifest/index.ts';

interface SampleApi {
  count(): number;
}
interface OtherApi {
  name(): string;
}
const SamplePort = definePort<SampleApi>('sample');
const OtherPort = definePort<OtherApi>('other');
const Started = defineEvent('other.started', z.strictObject({ id: z.string() }));
const StartDecide = defineHook('start.decide', { mode: 'decide', input: z.strictObject({ ferret: z.string() }) });
const Sources = defineHook('ask.sources', {
  mode: 'provide',
  key: z.string(),
  value: z.strictObject({ form: z.boolean() }),
});

const cap = policyRef('capability', 'sample');

const manifest = definePlugin({
  id: 'sample',
  title: 'Sample',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  needs: { other: OtherPort },
  provides: { sample: SamplePort },
  actions: {
    routes: [
      route('GET /v1/sample', {
        minimum: 'operator',
        caller: 'any',
        capability: { capability: cap, axis: 'use' },
        audit: { skip: 'read' },
        guard: { none: 'no pane text' },
      }),
    ],
    agentTools: [
      tool('sample_count', {
        minimum: 'authenticated',
        caller: 'any',
        audit: { skip: 'read' },
        guard: { none: 'counts only' },
      }),
    ],
    cli: [verb('sample count')],
  },
  data: { subscribes: [Started] },
  hooks: {
    takes: [{ hook: StartDecide }, { hook: Sources, key: 'sample' }],
  },
});

export const daemon = implementDaemon(manifest, {
  build: ctx => {
    const other: OtherApi = ctx.needs.other;
    return {
      routes: { 'GET /v1/sample': async () => jsonResponse({ name: other.name() }) },
      tools: { sample_count: async () => ({ text: '1' }) },
      provides: { sample: { count: () => 1 } },
      hooks: {
        'start.decide': input => (input.ferret === 'x' ? ALLOW : { allow: false, reason: 'no' }),
        'ask.sources:sample': { form: true },
      },
      subscribers: { 'other.started': payload => void payload.id },
    };
  },
});

export const missingRoute = implementDaemon(manifest, {
  build: () => ({
    // @ts-expect-error a declared route with no handler does not compile
    routes: {},
    tools: { sample_count: async () => ({ text: '1' }) },
    provides: { sample: { count: () => 1 } },
    hooks: { 'start.decide': () => ALLOW, 'ask.sources:sample': { form: true } },
    subscribers: { 'other.started': () => undefined },
  }),
});

// A handler for an UNDECLARED route type-checks (TypeScript does not check excess keys in a returned object); the
// generator's `manifest-match` check refuses it (§7.9).

export const cli = implementCli(manifest, { build: () => ({ verbs: { 'sample count': async () => 0 } }) });

// A plugin that declares nothing need implement nothing.
const empty = definePlugin({ id: 'empty', title: 'Empty', version: '5.0.0', api: 5, core: false, kinds: [] });
export const emptyDaemon = implementDaemon(empty, { build: () => ({}) });
