/**
 * "DISK IS SATURATED — THE DAEMON IS SLOW, NOT DEAD", in the one place a person looks when a machine
 * stops answering. Without it a daemon whose event loop is stalled on a busy disk looks exactly like a
 * dead one, and the owner restarts it for nothing.
 */

import type { IoPressureView } from '@ferretry/protocol';
import { HardDrive } from 'lucide-react';
import { diskPressureSentence } from '../lib/daemon-health.ts';

export function DiskPressureNote({ io }: { readonly io: IoPressureView }) {
  return (
    <p role="status" data-disk-pressure="" className="m-0 flex items-center gap-xs px-sm py-xs text-meta text-muted">
      <HardDrive aria-hidden="true" size={13} className="shrink-0 text-warn" />
      <span>{diskPressureSentence(io)}</span>
    </p>
  );
}
