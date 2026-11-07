/**
 * The app's half of `POST /v1/models/local/refresh`: ask the daemon to read the models Ollama has installed on ITS
 * machine, now. It spends nothing and is never polled — a surface calls it once when it opens, and again only when a
 * person taps Check again.
 */

import { type LocalModels, LocalModelsSchema } from '../../contract/index.ts';
import type { LoginsClient } from './client.ts';

export const LOCAL_MODELS_REFRESH_ROUTE = 'POST /v1/models/local/refresh' as const;

export const refreshLocalModels = async (client: LoginsClient): Promise<LocalModels> =>
  LocalModelsSchema.parse(await client.call(LOCAL_MODELS_REFRESH_ROUTE, { body: {} }));
