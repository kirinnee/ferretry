/** Where a bare harness CLI lives on `PATH`, when it is installed at all. */
export type FleetBinaryLookup = (binary: string) => string | undefined;
