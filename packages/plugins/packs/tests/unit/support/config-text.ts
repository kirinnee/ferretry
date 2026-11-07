import { config } from '@ferretry/kernel/host';
import type { ConfigText } from '../../../app/lib/config-text.ts';

/** The kernel's own YAML editor, behind the seam the app half takes (the shell hands the same code in). */
export const kernelConfigText: ConfigText = {
  read: text => {
    const read = config.readConfigText(text);
    return read.ok ? { ok: true, value: read.read.value } : { ok: false };
  },
  edit: config.editConfigText,
};

/** A file's plain value, or `undefined` for text that is not YAML. */
export const parsedConfig = (text: string): unknown => {
  const read = config.readConfigText(text);
  return read.ok ? read.read.value : undefined;
};
