import type { FerretRuntimeRecord, FerretRuntimeRename } from '../../../contract/index.ts';
import type { FerretsCore } from './core.ts';

/** Every ferret and the runtime it launched as (`FerretsApi.runtimeRecords`): the record, with the session config's words. */
export async function runtimeRecords({ registry, ports }: FerretsCore): Promise<readonly FerretRuntimeRecord[]> {
  await ports.ready?.();
  const read = ports.session?.runtimeFacts?.bind(ports.session);
  const rows = await Promise.all(
    registry.list().map(async (ferret): Promise<FerretRuntimeRecord | undefined> => {
      const facts = await read?.(ferret.id).catch(() => undefined);
      const agent = facts?.agent ?? ferret.runtime;
      if (agent === undefined) return undefined;
      return {
        id: ferret.id,
        name: ferret.name,
        harness: ferret.harness === 'codex' ? 'codex' : 'claude',
        agent,
        ...(facts?.executable === undefined ? {} : { executable: facts.executable }),
        state: ferret.state,
      };
    }),
  );
  return rows.filter(row => row !== undefined);
}

/**
 * Re-points every ferret on a renamed runtime (`FerretsApi.repointRuntime`). Each ferret is rewritten on its own mutation
 * lane, so a start, stop or resume of it is never interleaved: the record's `runtime` through the ordinary durable write,
 * the session config's `agent` and `command[0]` through the session storage's locked read-modify-write. A ferret that
 * does not name the old runtime is not written at all, and one that cannot be rewritten is skipped, never reported moved.
 */
export async function repointRuntime(
  { registry, ports, serial, write }: FerretsCore,
  rename: FerretRuntimeRename,
): Promise<number> {
  await ports.ready?.();
  let moved = 0;
  for (const { id } of registry.list()) {
    try {
      const done = await serial.run(id, async () => {
        const configMoved = (await ports.session?.repointRuntime?.(id, rename)) ?? false;
        const record = registry.get(id);
        if (record?.runtime !== rename.from) return configMoved;
        await write({ ...record, runtime: rename.to }, record.state, 'moved');
        return true;
      });
      if (done) moved += 1;
    } catch {
      // One ferret that cannot be rewritten still resolves through the runtime's former names; the rest still move.
    }
  }
  return moved;
}
