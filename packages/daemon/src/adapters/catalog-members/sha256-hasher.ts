import { createHash } from 'node:crypto';
import type { ShareCodeHasher } from '../../lib/catalog-members/ports.ts';

/** The SHA-256 of a share code's text as lowercase hex, synchronously: the admission step cannot await one. */
export class NodeShareCodeHasher implements ShareCodeHasher {
  hex(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }
}
