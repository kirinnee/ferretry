import {
  VoiceModelRequestSchema,
  type VoiceEngineCode,
  type VoiceEngineView,
  VOICE_ENGINE_CODES,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import { VoiceInstallError } from '../../voice-install/index.ts';

/**
 * The speech engine on this machine: `GET /v1/voice/engine` and the acts that change it
 * (docs/voice.md › "On my machine: models and Install"; docs/design/voice-modes.md §2.2–§2.3, §4.1).
 *
 * EVERY ROUTE IS `operator` AND `caller: 'person'`. A ferret's session credential (and the Warden's) is
 * ungoverned by grants, so a capability demand alone would let a ferret install a native runtime and
 * download half a gigabyte by simply not being a grant caller; `caller: 'person'` refuses it
 * `403 owner_only` before any handler or body read. Reads demand `voice` / `use`; every act demands
 * `voice` / `configure`, which a governed device also confirms with a passkey (`demandNeedsStepUp`).
 *
 * INSTALL IS A LONG OPERATION, AND ANSWERS AT ONCE. `POST …/install` replies `202` with the view, the
 * download runs on in the daemon, and `GET /v1/voice/engine` carries `install` — how far it is, or how
 * the last one ended — so a client polls one route rather than holding a connection for minutes.
 * Starting a second while one runs is `409 voice_install_busy`.
 */

const USE = { capability: 'voice', axis: 'use' } as const;
const CONFIGURE = { capability: 'voice', axis: 'configure' } as const;

/** What the routes need of the install service; the service itself is `src/lib/voice-install`. */
export interface VoiceEngineSubsystem {
  view(): Promise<VoiceEngineView>;
  install(id: string): Promise<VoiceEngineView>;
  cancel(): Promise<VoiceEngineView>;
  remove(id: string): Promise<VoiceEngineView>;
  use(id: string): Promise<VoiceEngineView>;
}

const STATUS: Readonly<Partial<Record<VoiceEngineCode, number>>> = {
  [VOICE_ENGINE_CODES.unknownModel]: 404,
  [VOICE_ENGINE_CODES.busy]: 409,
  [VOICE_ENGINE_CODES.notInstalled]: 409,
  [VOICE_ENGINE_CODES.inUse]: 409,
  [VOICE_ENGINE_CODES.noDisk]: 507,
  [VOICE_ENGINE_CODES.unsupportedPlatform]: 501,
};

/** Restates a domain refusal as an HTTP answer carrying its code, so the app and `fy` say the right sentence. */
async function answering(act: () => Promise<VoiceEngineView>, status = 200): Promise<ReturnType<typeof jsonResponse>> {
  try {
    return jsonResponse(await act(), status);
  } catch (error) {
    if (!(error instanceof VoiceInstallError)) throw error;
    throw new ApiError(STATUS[error.code] ?? 500, error.message, error.code);
  }
}

export function voiceEngineRoutes(subsystem: VoiceEngineSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/voice/engine',
      minimum: 'operator',
      caller: 'person',
      capability: USE,
      noStore: true,
      handle: async () => await answering(async () => await subsystem.view()),
    },
    {
      method: 'POST',
      path: '/v1/voice/engine/install',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const { id } = await parseBody(context.request, VoiceModelRequestSchema);
        return await answering(async () => await subsystem.install(id), 202);
      },
    },
    {
      method: 'POST',
      path: '/v1/voice/engine/cancel',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async () => await answering(async () => await subsystem.cancel()),
    },
    {
      method: 'POST',
      path: '/v1/voice/engine/remove',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const { id } = await parseBody(context.request, VoiceModelRequestSchema);
        return await answering(async () => await subsystem.remove(id));
      },
    },
    {
      method: 'POST',
      path: '/v1/voice/engine/use',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const { id } = await parseBody(context.request, VoiceModelRequestSchema);
        return await answering(async () => await subsystem.use(id));
      },
    },
  ];
}
