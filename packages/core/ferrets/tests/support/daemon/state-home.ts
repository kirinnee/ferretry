declare const stateHomeBrand: unique symbol;

/** Absolute root of one Ferretry installation (the kernel resolves it; a test names one). */
export type StateHome = string & { readonly [stateHomeBrand]: true };
