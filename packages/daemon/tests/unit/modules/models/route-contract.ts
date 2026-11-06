/**
 * The `models` module's route contract: who may call each of its routes, and which of its mutating routes the
 * security log deliberately does not record. See the README at the top of `../route-contracts.ts`.
 *
 * The module contributes no audit rule: both mutating routes are reads that spend nothing, and say why below.
 */
export const callers: readonly string[] = [
  'GET /v1/models operator any',
  'POST /v1/models/local/refresh operator any',
  'POST /v1/models/refresh operator any',
];

export const notAudited: Readonly<Record<string, string>> = {
  'POST /v1/models/refresh': 'asks the hosted app for a newer model catalog; labels and ids, grants nothing',
  'POST /v1/models/local/refresh':
    'reads the model names Ollama has installed on this machine, as `ollama list` does; spends and changes nothing',
};
