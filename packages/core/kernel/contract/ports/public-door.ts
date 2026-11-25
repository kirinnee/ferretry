import type { ApiHeaders } from '../http.ts';

/** The security allow-list for public HTTP routes and listeners; declaring a permission cannot extend it. */
export const PUBLIC_DOOR_PLUGINS = ['connector'] as const;

/** The manifest opt-in, checked in addition to the fixed security allow-list. */
export interface PublicDoorPermission {
  readonly publicDoor?: true;
}

/** A listener that reaches only the opener's public routes, never the daemon API or a sealed session. */
export interface PublicDoorPort {
  open(input: {
    /** Bound on 127.0.0.1 only. Zero asks the OS for a free port. */
    readonly port: number;
    /** Rate-limit identity only; no address or header can make the arrival local or privileged. */
    readonly peer?: (headers: ApiHeaders) => string;
  }): Promise<PublicDoorHandle>;
}

export interface PublicDoorHandle {
  readonly port: number;
  /** Idempotent; plugin and daemon shutdown also close every open handle. */
  close(): Promise<void>;
}
