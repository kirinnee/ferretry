import type { ReactNode } from 'react';
import { rendererOwners } from '../surfaces/halves.ts';
import { useOptionalShell } from './context.tsx';
import { PluginView } from './views.tsx';

/**
 * MOUNTS THE OWNER'S RENDERER (§5.2). A plugin that has a thing to draw which another plugin owns — a `&F12` card, a
 * `!A3` ask, a `%terminal:` surface, a question — names the renderer key (`reference:&`, `ask:question`) and the value;
 * the one plugin that declared that key draws it, through the same containment as every plugin view. Nobody imports
 * the owner. Nothing owns the key, or no shell is mounted (a harness, a test): `fallback`, so a reference stays prose.
 */
export function RendererView({
  daemon,
  rendererKey,
  value,
  fallback = null,
}: {
  readonly daemon: string;
  /** `reference:<prefix>` or `ask:<source>`. */
  readonly rendererKey: string;
  readonly value: unknown;
  readonly fallback?: ReactNode;
}) {
  const shell = useOptionalShell();
  if (shell === null) return <>{fallback}</>;
  const owner = rendererOwners(shell.runtime.surfaces).get(rendererKey);
  if (owner === undefined) return <>{fallback}</>;
  return <PluginView daemon={daemon} plugin={owner} section="renderers" id={rendererKey} props={{ value }} />;
}
