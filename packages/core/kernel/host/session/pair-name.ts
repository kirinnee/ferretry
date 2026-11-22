/**
 * The paired answer with the machine's name in it as the host answered it after a pairing brought a name, or the answer
 * untouched when no name was typed, the layer has no host to ask, or the host could not answer.
 */
export async function answerWithMachineName(
  response: unknown,
  typed: string | undefined,
  nameMachine: ((name: string) => Promise<string>) | undefined,
): Promise<unknown> {
  if (typed === undefined || nameMachine === undefined) return response;
  const current = await nameMachine(typed).catch(() => undefined);
  return current === undefined || typeof response !== 'object' || response === null
    ? response
    : { ...response, daemonName: current };
}
