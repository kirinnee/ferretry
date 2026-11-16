import { daemonConnection } from '../../../../../app/shell-voice.ts';

export const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'fy_device_id_alpha00000000000000000',
});

export interface ConfigFileView {
  readonly path: string;
  readonly kind: string;
  readonly schema: string;
  readonly exists: boolean;
  readonly text: string;
  readonly etag: string;
  readonly state: string;
  readonly issues: readonly unknown[];
}

/** One configuration file as the configuration door reads it back. */
export const fileView = (overrides: Partial<ConfigFileView> = {}): ConfigFileView => ({
  path: 'voice.yaml',
  kind: 'voice',
  schema: 'voice',
  exists: true,
  text: '',
  etag: 'etag-voice-1',
  state: 'ok',
  issues: [],
  ...overrides,
});
