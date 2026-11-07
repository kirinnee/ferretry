import type { Log, LogFields } from '../contract/ports.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogRecord {
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly fields?: LogFields;
}
export type LogSink = (record: LogRecord) => void;

/** Logging scoped to the subsystem (§7.4). The sink is the kernel's adapter (`logs/fyd.log`) or the test host's. */
export function scopedLog(sink: LogSink, scope: string): Log {
  const emit =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void =>
      sink(fields === undefined ? { level, scope, message } : { level, scope, message, fields });
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: child => scopedLog(sink, `${scope}.${child}`),
  };
}
