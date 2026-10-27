/**
 * Signing in to a remote MCP server, on pages of their own (`?mcp-sign-in=<frame>`): the real Components
 * tab opened on an `auth: oauth` server, answered locally, so the Sign-in section and its sheet are
 * walkable without a daemon or a provider.
 *
 * A page rather than a gallery card because the sheet is fixed to the viewport. Its own module rather than
 * more lines in `main.tsx`: two units appending to the same object is the conflict that file keeps teaching.
 *
 * Every address is a fake: no state here is a real single-use state and no code is a real code.
 */

import { FyHttpError } from '@ferretry/protocol/client';
import { useState } from 'react';
import { ComponentsTab } from '../src/features/fleet/components/components-tab.tsx';
import { itemHref } from '../src/features/fleet/components/machine-links.ts';
import type { FleetClientFactory } from '../src/features/fleet/fleet-client.ts';
import { useAppViewport } from '../src/hooks/use-app-viewport.ts';
import { daemonConnection } from '../src/lib/daemon-connection.ts';
import { harnessCatalogAnswer } from './account-model-catalog.ts';

const MCP_SIGN_IN_FRAMES = ['needs-sign-in', 'signed-in', 'sheet-pwa', 'sheet-paste'] as const;
export type McpSignInFrame = (typeof MCP_SIGN_IN_FRAMES)[number];

/** The frame `?mcp-sign-in=<frame>` names, or `undefined`. */
export const mcpSignInFrame = (search: string): McpSignInFrame | undefined => {
  const named = new URLSearchParams(search).get('mcp-sign-in');
  return MCP_SIGN_IN_FRAMES.find(frame => frame === named);
};

const MACHINE = 'studio-mac';
const CONNECTION = daemonConnection({ daemonId: 'harness-daemon', baseUrl: 'http://127.0.0.1:1', deviceId: 'harness' });
const in_ = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

const LINEAR = {
  reference: 'mcp/linear',
  kind: 'mcp',
  name: 'linear',
  detail: { kind: 'mcp', url: 'https://mcp.linear.app/mcp', auth: 'oauth', env: [] },
  partial: [],
  warnings: [],
  usedBy: { profiles: ['Default'], runtimes: ['claude-default', 'codex-default'] },
  editNote: 'Used by 1 profile and 2 runtimes.',
  remove: { available: true },
};

const SIGNED_IN = {
  component: 'linear',
  state: 'signed-in',
  issuer: 'https://mcp.linear.app',
  signedInAt: in_(-5),
  expiresAt: in_(179),
  renewable: true,
  secrets: ['MCP_LINEAR_6F1C2A9B_ACCESS', 'MCP_LINEAR_6F1C2A9B_REFRESH'],
};

const flow = (paste: boolean) => ({
  flowId: paste ? 'harness-flow-paste' : 'harness-flow-pwa',
  component: 'linear',
  authorizeUrl: `https://mcp.linear.app/authorize?response_type=code&client_id=harness&code_challenge=harness&code_challenge_method=S256&state=${paste ? 'harness-paste' : 'harness-pwa'}`,
  mode: paste ? 'paste' : 'pwa',
  redirectUri: paste
    ? 'http://localhost:51234/callback'
    : `${window.location.origin}/oauth/mcp-callback/0123456789abcdef`,
  issuer: 'mcp.linear.app',
  expiresAt: in_(10),
  ...(paste ? { note: 'You asked for the paste way, so the browser won’t come back here by itself.' } : {}),
});

/** The components the shared harness catalogue answers, with `linear` added to the MCP servers. */
const components = (): unknown => {
  const catalog = harnessCatalogAnswer('/v1/fleet/components') as { kinds: { kind: string; components: unknown[] }[] };
  return {
    ...catalog,
    kinds: catalog.kinds.map(group =>
      group.kind === 'mcp' ? { ...group, components: [LINEAR, ...group.components] } : group,
    ),
  };
};

const answer = (frame: McpSignInFrame, path: string, init?: RequestInit): unknown => {
  const method = init?.method ?? 'GET';
  if (path === '/v1/fleet/components') return components();
  if (path === '/v1/fleet/machine')
    return {
      name: MACHINE,
      format: 'version-2',
      setUp: true,
      agentPermissions: 'auto',
      defaultRuntime: 'claude-default',
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
      tools: [],
      runtimeCount: 5,
      runningSessions: 0,
      authority: { mayApply: true, applyRefusal: 'granted' },
    };
  if (path === '/v1/fleet/mcp-auth') return { connections: frame === 'signed-in' ? [SIGNED_IN] : [] };
  if (path === '/v1/fleet/mcp-auth/linear' && method === 'POST')
    return flow(!('redirectUri' in (JSON.parse(String(init?.body ?? '{}')) as object)));
  if (path.startsWith('/v1/fleet/mcp-auth/flows/') && method === 'DELETE')
    return { flowId: decodeURIComponent(path.split('/').at(-1) ?? ''), cancelled: true };
  if (path.startsWith('/v1/fleet/mcp-auth/flows/') && method === 'POST')
    return new FyHttpError(
      'That address is from a different sign-in. Start again, then paste the address the newest sign-in ended on.',
      409,
      'conflict',
    );
  return harnessCatalogAnswer(path, init);
};

const clientFor =
  (frame: McpSignInFrame): FleetClientFactory =>
  async () => ({
    request: (async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      const value = answer(frame, path, init);
      if (value instanceof Error) throw value;
      return schema.parse(value);
    }) as Awaited<ReturnType<FleetClientFactory>>['request'],
  });

export function McpSignInFrameHarness({ frame }: { readonly frame: McpSignInFrame }) {
  useAppViewport();
  // The tab opens the page its address names, exactly as a link from Settings does.
  useState(() => {
    window.history.replaceState(null, '', `${window.location.search}${itemHref(MACHINE, 'components', 'mcp/linear')}`);
    return null;
  });
  const [createClient] = useState(() => clientFor(frame));
  return (
    <main
      aria-label={`MCP sign-in ${frame}`}
      className="min-h-dvh bg-bg px-4 py-4"
      id={`harness-mcp-sign-in-${frame}-page`}
      data-harness-mcp-sign-in={frame}
    >
      <div className="mx-auto w-full max-w-[760px]">
        <ComponentsTab
          connection={CONNECTION}
          machineName={MACHINE}
          machine={null}
          online
          checking={false}
          onRetry={() => undefined}
          createClient={createClient}
        />
      </div>
    </main>
  );
}
