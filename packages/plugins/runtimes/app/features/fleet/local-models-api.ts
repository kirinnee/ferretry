/**
 * The app's half of `POST /v1/logins/models/local/refresh`: ask the daemon to read the models Ollama has
 * installed on ITS machine, now. It spends nothing and is never polled — a surface calls it once when it
 * opens, and again only when a person taps Check again.
 */

import { type LocalModels, LocalModelsSchema } from '../../../contract/index.ts';
import type { RuntimesClient } from '../../lib/client.ts';

// Logins owns this route; Runtimes' contract carries the same answer shape (`LocalModels`) for its runtime view.
export const LOCAL_MODELS_REFRESH_ROUTE = 'POST /v1/logins/models/local/refresh' as const;

export const refreshLocalModels = async (client: RuntimesClient): Promise<LocalModels> =>
  LocalModelsSchema.parse(await client.call(LOCAL_MODELS_REFRESH_ROUTE, { body: {} }));
