import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import {
  BROWSER_WAIT_MAX_MS,
  type BrowserProxySetting,
  BrowserActionResultSchema,
  BrowserLoginStatusSchema,
  BrowserProxyTestResultSchema,
  BrowserStatusSchema,
  SurfaceControlViewSchema,
} from '../../contract/index.ts';
import { BROWSER_WAIT_TOTAL_MAX_MS } from './limits.ts';

/**
 * Every browser verb's one way to the daemon.
 *
 * TWO CALLERS, TWO ROADS. Named with `--ferret`, the verb is a PERSON acting on that ferret's pages, through the
 * declared route `POST /v1/ferrets/:ferretId/surfaces/browser/tools`. Unnamed, it is the ferret this runs inside,
 * calling its own agent tool (`browser_click`, …), which the shell's tool client dispatches.
 */

const ROUTES = {
  tools: 'POST /v1/ferrets/:ferretId/surfaces/browser/tools',
  controlView: 'GET /v1/ferrets/:ferretId/surfaces/browser/control',
  control: 'POST /v1/ferrets/:ferretId/surfaces/browser/control',
  status: 'GET /v1/ferrets/:ferretId/browser',
  act: 'POST /v1/ferrets/:ferretId/browser',
  loginStatus: 'GET /v1/browser/login',
  login: 'POST /v1/browser/login',
  proxyTest: 'POST /v1/browser/proxy/test',
} as const;

/** What the shell's tool client offers a half (`PluginClient.tool`), when it offers one. */
interface ToolCaller {
  tool(name: string, input: unknown): Promise<unknown>;
}

const callsTools = (client: PluginClient): client is PluginClient & ToolCaller =>
  typeof (client as Partial<ToolCaller>).tool === 'function';

/** The kernel's `ToolResult` (text already masked), as both roads answer it. */
const ToolAnswerSchema = z.looseObject({
  text: z.string(),
  isError: z.boolean().optional(),
  data: z.unknown().optional(),
});

const SurfaceLineSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  openerId: z.string().optional(),
  available: z.boolean().optional(),
});

/** What a tool puts beside its sentence: the pages it lists, whether a wait matched, and a picture. */
const ToolDataSchema = z.looseObject({
  surfaces: z.array(SurfaceLineSchema).optional(),
  matched: z.boolean().optional(),
  picture: z.looseObject({ mime: z.string(), base64: z.string() }).optional(),
});

type SurfaceLine = z.infer<typeof SurfaceLineSchema>;

export interface ToolAnswer {
  readonly text: string;
  readonly isError: boolean;
  readonly surfaces: readonly SurfaceLine[];
  readonly matched?: boolean;
  readonly picture?: { readonly mime: string; readonly base64: string };
}

class BrowserCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserCallError';
  }
}

function readAnswer(answer: unknown): ToolAnswer {
  const kernel = ToolAnswerSchema.safeParse(answer);
  if (!kernel.success)
    throw new BrowserCallError('the daemon answered a browser tool in a shape this build does not read');
  const data = ToolDataSchema.safeParse(kernel.data.data);
  return {
    text: kernel.data.text,
    isError: kernel.data.isError === true,
    surfaces: data.success ? (data.data.surfaces ?? []) : [],
    ...(data.success && data.data.matched !== undefined ? { matched: data.data.matched } : {}),
    ...(data.success && data.data.picture !== undefined ? { picture: data.data.picture } : {}),
  };
}

/** `browser_wait_for` → the call a person's route takes. */
const callName = (tool: string): string => tool.replace(/^browser_/u, 'browser.');

export class BrowserClient {
  constructor(private readonly client: PluginClient) {}

  /** One tool call. `ferret` names the ferret a person acts on; absent, the caller is the ferret itself. */
  async tool(tool: string, input: Readonly<Record<string, unknown>>, ferret?: string): Promise<ToolAnswer> {
    if (ferret !== undefined)
      return readAnswer(
        await this.client.call(ROUTES.tools, {
          params: { ferretId: ferret },
          body: { tool: callName(tool), ...input },
        }),
      );
    if (!callsTools(this.client))
      throw new BrowserCallError(
        'this build cannot call a ferret’s own browser tools from the command line yet: pass --ferret <id> to act on a ferret’s pages yourself',
      );
    return readAnswer(await this.client.tool(tool, input));
  }

  /**
   * Waits up to `totalMs` for one page condition, asking the daemon in slices of at most {@link BROWSER_WAIT_MAX_MS}
   * so no single request outlives its idle timeout. A `time` wait is a plain sleep and is asked once. The answer is
   * the last slice's: `matched === false` means the budget ran out.
   */
  async wait(input: Readonly<Record<string, unknown>>, totalMs: number, ferret?: string): Promise<ToolAnswer> {
    if (input.time !== undefined) return await this.tool('browser_wait_for', input, ferret);
    let remaining = Math.min(Math.max(totalMs, 100), BROWSER_WAIT_TOTAL_MAX_MS);
    for (;;) {
      const slice = Math.min(remaining, BROWSER_WAIT_MAX_MS);
      remaining -= slice;
      const answer = await this.tool('browser_wait_for', { ...input, timeoutMs: Math.max(slice, 100) }, ferret);
      if (answer.isError || answer.matched !== false || remaining <= 0) return answer;
    }
  }

  /** A person takes a page over from the ferret, hands it back, or hands one over. */
  async control(action: 'takeover' | 'handback' | 'handover', key: string, ferret: string) {
    return SurfaceControlViewSchema.parse(
      await this.client.call(ROUTES.control, { params: { ferretId: ferret }, body: { action, key } }),
    );
  }

  /** Who drives which of a ferret's pages, and what a person holds. */
  async view(ferret: string) {
    return SurfaceControlViewSchema.parse(await this.client.call(ROUTES.controlView, { params: { ferretId: ferret } }));
  }

  /** The ferret's browser: its status (no body), or one act on it. */
  async browser(ferret: string, body?: Readonly<Record<string, unknown>>) {
    if (body === undefined)
      return {
        status: BrowserStatusSchema.parse(await this.client.call(ROUTES.status, { params: { ferretId: ferret } })),
      };
    return BrowserActionResultSchema.parse(await this.client.call(ROUTES.act, { params: { ferretId: ferret }, body }));
  }

  /** The sign-in window: its status (no body), or one act on it. */
  async login(body?: Readonly<Record<string, unknown>>) {
    return BrowserLoginStatusSchema.parse(
      body === undefined ? await this.client.call(ROUTES.loginStatus) : await this.client.call(ROUTES.login, { body }),
    );
  }

  async proxyTest(proxy?: BrowserProxySetting) {
    return BrowserProxyTestResultSchema.parse(
      await this.client.call(ROUTES.proxyTest, { body: proxy === undefined ? {} : { proxy } }),
    );
  }
}
