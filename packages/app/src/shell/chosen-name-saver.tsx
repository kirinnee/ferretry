import { MachineNameSchema } from '@ferretry/kernel/contract';
import { useEffect } from 'react';
import { useRuntimeVersion, useShell } from './context.tsx';
import { saveMachineName, sentenceOf } from './machine-name-file.ts';

/**
 * SAVES THE NAME A PERSON TYPED ON THE PAIR SCREEN, as soon as the machine they just paired with can be asked.
 *
 * It is mounted by the frame whatever route is open, because the first run comes back from the pair screen to a route
 * that names no machine; a save that waited for a machine's own page would write nothing there. The write is the one the
 * "Name this machine" step makes (`PUT /v1/config/file` on `host.yaml`, the revision read just before), so the daemon
 * governs it as it governs the Settings tab. It draws nothing. A name that cannot be saved is kept in memory (never
 * with the pairing code, which this never sees) with the reason, and the step offers it again.
 */
export function ChosenNameSaver() {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  return (
    <>
      {runtime.daemons
        .snapshot()
        .daemons.filter(paired => runtime.daemons.chosenName(paired.daemon)?.state === 'waiting')
        .map(paired => (
          <SaveChosenName key={paired.daemon} daemon={paired.daemon} />
        ))}
    </>
  );
}

function SaveChosenName({ daemon }: { readonly daemon: string }) {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  const client = runtime.client(daemon, 'kernel');
  useEffect(() => {
    if (client === undefined) return;
    // Taken once: the name moves from waiting to saving, so a second effect run finds nothing to write.
    const chosen = runtime.daemons.startChosenName(daemon);
    if (chosen === undefined) return;
    const parsed = MachineNameSchema.safeParse(chosen);
    if (!parsed.success) {
      runtime.daemons.chosenFailed(
        daemon,
        `The name you chose while pairing was not saved: ${parsed.error.issues[0]?.message ?? 'it cannot be used'}`,
      );
      return;
    }
    void saveMachineName(client, parsed.data).then(
      () => {
        runtime.daemons.learnMachine(daemon, parsed.data);
        runtime.daemons.chosenSaved(daemon);
        runtime.daemons.nameSettled(daemon);
      },
      (cause: unknown) =>
        runtime.daemons.chosenFailed(daemon, `The name you chose while pairing was not saved: ${sentenceOf(cause)}`),
    );
  }, [client, daemon, runtime]);
  return null;
}
