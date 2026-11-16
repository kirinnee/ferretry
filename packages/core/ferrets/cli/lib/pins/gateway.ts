import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { PinSchema } from '../../../contract/index.ts';

/** The pin board's two route keys, as the manifest declares them. */
export const PIN_ROUTES = {
  list: 'GET /v1/ferrets/:ferretId/pins',
  apply: 'POST /v1/ferrets/:ferretId/pins',
} as const;

/** One ferret's pins as the daemon answers a read or a change (the daemon's own copy is a shape, not a parser). */
const PinSnapshotSchema = z.object({ sessionId: z.string().min(1), pins: z.array(PinSchema) });
export type PinSnapshot = z.infer<typeof PinSnapshotSchema>;

/** The three changes the route takes (`add` here is a note: the verbs pin text, never a message block). */
export type PinChange =
  | { readonly action: 'add'; readonly kind: 'note'; readonly text: string }
  | { readonly action: 'edit'; readonly id: string; readonly text: string }
  | { readonly action: 'remove'; readonly id: string };

export interface IPinGateway {
  list(ferret: string): Promise<PinSnapshot>;
  apply(ferret: string, change: PinChange): Promise<PinSnapshot>;
}

/** Speaks the pin routes through the shell's guarded client; both directions are parsed, never cast. */
export class ClientPinGateway implements IPinGateway {
  constructor(private readonly client: PluginClient) {}

  async list(ferret: string): Promise<PinSnapshot> {
    return PinSnapshotSchema.parse(await this.client.call<unknown>(PIN_ROUTES.list, { params: { ferretId: ferret } }));
  }

  async apply(ferret: string, change: PinChange): Promise<PinSnapshot> {
    return PinSnapshotSchema.parse(
      await this.client.call<unknown>(PIN_ROUTES.apply, { params: { ferretId: ferret }, body: change }),
    );
  }
}
