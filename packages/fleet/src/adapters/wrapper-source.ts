/** Reading a generated wrapper off disk, so a caller can learn which variables it depends on. */
export type FleetWrapperSource = (path: string) => Promise<string | undefined>;

/** Where a bare harness CLI lives on `PATH`, when it is installed at all. */
export type FleetBinaryLookup = (binary: string) => string | undefined;

/** Reads a generated wrapper. A wrapper that is missing or unreadable yields nothing. */
export const readFleetWrapperScript: FleetWrapperSource = async path => {
  try {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : undefined;
  } catch {
    return undefined;
  }
};
