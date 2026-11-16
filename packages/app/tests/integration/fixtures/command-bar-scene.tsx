/**
 * The browser entry for "the command bar at v4 parity": the REAL `CommandBar`, the shell's own places and the entries every
 * plugin's own app half contributes (`shell.commands`, from the generated surfaces), over the real manifests' screens and
 * addresses, and one fake machine that answers only its ferret list. No daemon, no network; everything on screen is fake
 * data.
 *
 *   ?theme=<family>-<mode>      the theme
 *   ?ferret=<id>                the reader is on that ferret's page ("Board for <ferret>" is offered)
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { generated } from '../../../src/generated/surfaces.ts';
import { viewsOf } from '../../../src/layout/engine.ts';
import { routeTable } from '../../../src/router/routes.ts';
import { screenHref } from '../../../src/router/screen-href.ts';
import { buildPluginCommandSources, placeSource } from '../../../src/shell/command-sources.ts';
import { CommandBar } from '../../../src/ui/command-bar.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const ferret = params.get('ferret') ?? undefined;

const views = viewsOf(generated.surfaces);
const screens = [...new Set(views.screens.values())];
const routes = routeTable(screens);

const at = (hoursAgo: number): string => new Date(Date.UTC(2026, 10, 12, 12) - hoursAgo * 3_600_000).toISOString();
const summary = (id: string, name: string, folder: string, state: string, hoursAgo: number, title?: string) => ({
  id,
  name,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder,
  state,
  createdAt: at(hoursAgo + 5),
  stateAt: at(hoursAgo),
  ...(title === undefined ? {} : { title }),
});
const FERRETS = [
  summary('zoe', 'zoe', '/work/fixture', 'working', 1, 'Fixture running'),
  summary('kai', 'kai', '/work/release', 'idle', 3, 'Release train'),
  summary('hadi', 'hadi', '/work/docs', 'stopped', 30, 'Docs sweep'),
];
const client = {
  call: async (route: string) => {
    if (route === 'GET /v1/ferrets') return FERRETS;
    throw new Error(`no fake daemon answers ${route}`);
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;

function Scene() {
  const [answers, setAnswers] = useState(0);
  const changed = useCallback(() => setAnswers(current => current + 1), []);
  const navigate = useCallback((href: string) => document.body.setAttribute('data-went', href), []);
  // Built once, as the frame builds a plugin's sources once per daemon the bar opens on.
  const plugins = useMemo(
    () =>
      buildPluginCommandSources({
        surfaces: generated.surfaces,
        daemon: 'ws',
        clientOf: () => client,
        navigate,
        screenHref: (daemon, plugin, screen, address) => screenHref(views, routes, daemon, plugin, screen, address),
        changed,
        ferret,
      }),
    [navigate, changed],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answers` re-lists when a source's answer arrives.
  const sources = useMemo(
    () => [placeSource({ daemons: [], daemon: 'ws', screens, routes, navigate }), ...plugins],
    [plugins, navigate, answers],
  );
  return <CommandBar open focusSignal={1} onClose={() => undefined} sources={sources} />;
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
