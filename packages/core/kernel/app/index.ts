import { createElement } from 'react';
import { implementApp } from '../manifest/index.ts';
import manifest from '../plugin.ts';
import { ConfigFilesSurface } from './config-files/panel.tsx';
import { DoctorSettings } from './doctor/doctor-settings.tsx';
import { HostChecks } from './doctor/host-checks.tsx';

/**
 * The Kernel's app half (§2.3): the settings every daemon has whatever plugins it runs — the configuration FILES (the
 * YAML a machine's settings live in, with an editor), the DOCTOR report (the same host checks `fy doctor` prints) and
 * the HOST CHECKS reachability tab. They read only the kernel's own routes (`GET /v1/config/status|file`,
 * `PUT /v1/config/file`, `POST /v1/config/confirm`, `GET /v1/doctor`, `GET /v1/health`) through the client the shell
 * builds per daemon.
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    settings: {
      files: () => createElement(ConfigFilesSurface, { client }),
      doctor: () => createElement(DoctorSettings, { client }),
      'host-checks': () => createElement(HostChecks, { client }),
    },
  }),
});
