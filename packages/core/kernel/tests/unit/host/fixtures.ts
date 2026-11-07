import { instantFromEpochMs, milliseconds } from '@ferretry/std';
import type { Admission, AdmissionDecision } from '../../../contract/bound.ts';
import type { CallStanding, MemberStanding } from '../../../contract/route.ts';
import type { ApiRequest } from '../../../contract/http.ts';
import { headersFrom, queryFrom } from '../../../contract/http.ts';
import type { Clock, Log } from '../../../contract/ports.ts';
import { localArrival } from '../../../host/listener.ts';
import type { CarrierKey } from '../../../contract/ids.ts';

export const silentLog: Log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

/** A driven clock: timers fire only when the test advances it. */
export function drivenClock(startMs = Date.parse('2026-11-07T09:00:00Z')): Clock & { advance(ms: number): void } {
  let now = startMs;
  let timers: { at: number; fn: () => void; every?: number; id: number }[] = [];
  let next = 0;
  const add = (delay: number, fn: () => void, every?: number): (() => void) => {
    const id = next++;
    timers.push({ at: now + delay, fn, id, ...(every === undefined ? {} : { every }) });
    return () => {
      timers = timers.filter(timer => timer.id !== id);
    };
  };
  return {
    now: () => instantFromEpochMs(now),
    nowMs: () => now,
    after: (delay, fn) => add(delay, fn),
    every: (interval, fn) => add(interval, fn, interval),
    sleep: delay => new Promise(resolve => add(delay, () => resolve())),
    advance: ms => {
      const until = now + ms;
      for (;;) {
        const due = timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        now = due.at;
        if (due.every === undefined) timers = timers.filter(timer => timer.id !== due.id);
        else due.at += Math.max(1, due.every);
        due.fn();
      }
      now = until;
    },
  };
}

export const ms = milliseconds;

export function request(method: string, path: string, init: { local?: boolean; body?: string } = {}): ApiRequest {
  return {
    method,
    path,
    query: queryFrom([]),
    headers: headersFrom({}),
    arrival:
      init.local === false
        ? { kind: 'carried', carrier: 'relay' as CarrierKey }
        : localArrival(true),
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
