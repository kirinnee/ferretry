/**
 * The browser's half of `POST /v1/models/local/refresh`: ask the daemon to read the models Ollama has
 * installed on ITS machine, now. It spends nothing and is never polled — a surface calls it once when it
 * opens, and again only when a person taps Check again.
 */

import { LOCAL_MODELS_REFRESH_PATH, type LocalModels, LocalModelsSchema } from '@ferretry/protocol';
import type { FleetClient } from './fleet-client.ts';

export const refreshLocalModels = async (client: FleetClient): Promise<LocalModels> =>
  await client.request(LOCAL_MODELS_REFRESH_PATH, LocalModelsSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
