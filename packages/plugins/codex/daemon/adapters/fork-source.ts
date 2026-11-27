import {
  MAX_ROOT_WINDOW_BYTES,
  type FencedPath,
  type RootHandle,
  type RootOpenedBytes,
} from '@ferretry/kernel/contract';

const decoder = new TextDecoder();
/** Start the no-link proof. The same descriptor stays held through the header, correlation and snapshot reads. */
export async function holdForkSource(root: RootHandle, file: FencedPath): Promise<RootOpenedBytes | undefined> {
  const handle = await root.openBytes?.(file).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    if (!(await handle.stillNames())) throw new Error('the source conversation changed after it was proved');
    return handle;
  } catch {
    await handle.close();
    return undefined;
  }
}

/** The strict fork proof's head/tail windows from its held object, with no path reopen and no inode-reuse gap. */
export async function forkWindow(
  handle: RootOpenedBytes | undefined,
  offset: number,
  length: number,
): Promise<string | undefined> {
  if (handle === undefined) return undefined;
  try {
    if (!(await handle.stillNames())) return undefined;
    const text = decoder.decode(await handle.read(offset, length));
    return (await handle.stillNames()) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Read a bounded snapshot through one descriptor; concurrent appends stay in the source, never a replacement's bytes. */
export async function forkSource(handle: RootOpenedBytes | undefined, limit: number): Promise<string> {
  if (handle === undefined) throw new Error('the source conversation has no held file identity');
  try {
    if (!(await handle.stillNames())) throw new Error('the source conversation changed after it was proved');
    const { size } = await handle.stat();
    if (size > limit) throw new Error('the conversation is too large to copy (over 256 MB)');
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = await handle.read(offset, Math.min(MAX_ROOT_WINDOW_BYTES, size - offset));
      if (chunk.length === 0) throw new Error('the source conversation shrank while it was being read');
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (!(await handle.stillNames())) throw new Error('the source conversation changed while it was being read');
    return decoder.decode(bytes);
  } finally {
    await handle.close();
  }
}
