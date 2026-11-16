import type { PluginClient } from '@ferretry/kernel/manifest';
import { CodexUpdateFinished, type HarnessCliView } from '../contract/index.ts';
import { startRefusal, type StartRefusal } from './lib/model.ts';

const UPDATE = 'GET /v1/codex/update';
const START = 'POST /v1/codex/update';

/** What the Codex settings tab does: read the view, and start an update (with the person's yes when it is needed). */
export interface CodexSettings {
  load(): Promise<HarnessCliView>;
  watch(listener: () => void): () => void;
  /** Starts an update. A refusal is returned as data, so the view can ask the question it needs. */
  update(request: {
    readonly target?: string;
    readonly confirmUnverified?: boolean;
  }): Promise<
    | { readonly started: true; readonly view: HarnessCliView }
    | { readonly started: false; readonly refusal: StartRefusal }
  >;
}

export function codexSettings(client: Pick<PluginClient, 'call' | 'subscribe'>): CodexSettings {
  return {
    watch: listener => client.subscribe(CodexUpdateFinished, listener),
    load: async () => await client.call<HarnessCliView>(UPDATE),
    update: async request => {
      try {
        return { started: true, view: await client.call<HarnessCliView>(START, { body: request }) };
      } catch (error) {
        return { started: false, refusal: startRefusal(error) };
      }
    },
  };
}
