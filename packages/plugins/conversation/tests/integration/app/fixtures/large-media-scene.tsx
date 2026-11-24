/**
 * The browser entry for the large-media proof: the REAL `FyRenderBlock` and the REAL `readWorkspaceMedia` reading a
 * `media:` file over a client that sends each call to the test's server (`POST /wire`) and decodes the answer the way the
 * app's session transport does (`answerBody`, after the range header went through `allowedCallHeaders`). The server runs
 * the contract's own `mediaAnswer` and puts the answer on the session wire with the kernel's `answerRecords`, so the
 * bytes the browser plays crossed the same encoding a remote device's did.
 *
 * `?src=media:<file>&type=audio|video` picks the block; `?theme=studio-light` the look (as the other fy-render scenes).
 */
import { answerBody, DaemonCallError, swatchAttributes } from '@ferretry/app';
import { allowedCallHeaders, type PluginClient } from '@ferretry/kernel/manifest';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FyRenderBlock } from '../../../../app/render/fy-render-block.tsx';
import { isFyRenderEmbedBlock, parseFyRender } from '../../../../app/render/fy-render.ts';
import { readWorkspaceMedia } from '../../../../app/render/fy-render-workspace-media.ts';

const query = new URLSearchParams(location.search);
const setLook = (name: string): void => {
  const root = document.documentElement;
  const { 'data-style': style, 'data-palette': palette, 'data-mode': mode } = swatchAttributes(name);
  root.setAttribute('data-style', style);
  root.setAttribute('data-palette', palette);
  root.setAttribute('data-mode', mode);
  root.setAttribute('data-theme', name);
};
setLook(query.get('theme') ?? 'studio-dark');

interface Wire {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const client = {
  call: async (
    route: string,
    init?: {
      params?: Record<string, string>;
      query?: Record<string, string>;
      headers?: Parameters<typeof allowedCallHeaders>[0];
      signal?: AbortSignal;
    },
  ) => {
    const reply = await fetch('/wire', {
      body: JSON.stringify({
        headers: allowedCallHeaders(init?.headers),
        params: init?.params,
        query: init?.query,
        route,
      }),
      method: 'POST',
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    });
    const wire = (await reply.json()) as Wire;
    const body = answerBody(wire.headers, wire.body);
    if (wire.status >= 400) {
      const refusal = body as { code?: string; error?: string } | undefined;
      throw new DaemonCallError(wire.status, refusal?.code ?? `http_${wire.status}`, refusal?.error ?? '');
    }
    return body;
  },
} as unknown as PluginClient;

const parsed = parseFyRender(
  [
    'type: ' + (query.get('type') ?? 'audio'),
    'alt: A recording',
    `src: ${query.get('src') ?? 'media:song.wav'}`,
    '---',
  ].join('\n'),
);
if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.reason}`);
if (isFyRenderEmbedBlock(parsed.block)) throw new Error('fixture is an embed block');
const block = parsed.block;

const root = document.getElementById('root');
if (root === null) throw new Error('the scene has no #root to mount into');
createRoot(root).render(
  <StrictMode>
    <div className="scene-pad md">
      <FyRenderBlock
        block={block}
        readWorkspaceMedia={(path, signal, folder) =>
          readWorkspaceMedia(client, 'ferret-1', path, '/repo', signal, folder)
        }
      />
    </div>
  </StrictMode>,
);
