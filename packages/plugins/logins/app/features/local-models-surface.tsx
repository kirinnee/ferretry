/** The `local-models` panel: what Ollama has installed on this machine, read once when it opens and on Check again. */

import type { LoginsClient } from '../lib/client.ts';
import { LocalModelsPanel } from './local-models-panel.tsx';
import { useLocalModels } from './use-local-models.ts';

export function LocalModelsSurface({ client }: { readonly client: LoginsClient }) {
  const read = useLocalModels({ client, enabled: true });
  return <LocalModelsPanel machineName="this machine" read={read} onCheck={read.check} />;
}
