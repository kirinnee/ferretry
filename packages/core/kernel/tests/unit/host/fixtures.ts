import type { Admission, AdmissionDecision } from '../../../contract/bound.ts';
import type { CallStanding, MemberStanding } from '../../../contract/route.ts';
import type { ApiRequest } from '../../../contract/http.ts';
import { headersFrom, queryFrom } from '../../../contract/http.ts';
import type { Log } from '../../../contract/ports.ts';
import { localArrival } from '../../../host/listener.ts';
import type { CarrierKey } from '../../../contract/ids.ts';

export const silentLog: Log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

export function request(method: string, path: string, init: { local?: boolean; body?: string } = {}): ApiRequest {
  return {
    method,
    path,
    query: queryFrom([]),
    headers: headersFrom({}),
    arrival: init.local === false ? { kind: 'carried', carrier: 'relay' as CarrierKey } : localArrival(true),
    text: async () => init.body ?? '',
  };
}

/** A stand-in admission: admits what `allow` says, records every question. */
export function recordingAdmission(allow: (path: string) => boolean = () => true): Admission & {
  readonly asked: string[];
} {
  const asked: string[] = [];
  const decide = (path: string): AdmissionDecision =>
    allow(path)
      ? { outcome: 'admitted', standing: { actor: 'owner' } as unknown as CallStanding, actor: 'owner-tools' }
      : {
          outcome: 'refused',
          response: { status: 401, headers: new Map(), body: '{"error":"who are you","code":"unauthenticated"}' },
        };
  return {
    asked,
    admit: input => {
      asked.push(`${input.table} ${input.descriptor.method} ${input.descriptor.path}`);
      return decide(input.request.path);
    },
    admitMember: input => {
      asked.push(`member ${input.descriptor.path}`);
      return decide(input.request.path) as unknown as AdmissionDecision<MemberStanding>;
    },
    readmit: () => true,
    inventory: (_request, entries) => entries,
  };
}
