import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const options = JSON.parse(process.env.CODEX_INSTALL_OPTIONS);
const { previewCodexConnectInstallation: preview, installCodexConnectInstallation: install } = await import(pathToFileURL(process.env.CODEX_INSTALL_MODULE));
const root = process.env.CODEX_INSTALL_PROJECT;
const before = preview(root, options);
const installed = install(root, {
  ...options,
  expectedPackageHash: before.packageHash,
  expectedInstalledHash: before.installedHash
});
if (process.env.CODEX_INSTALL_CALIBRATE === '1') {
  lstatSync(options.sourceRoots[0]);
}
process.send({
  kind: 'installation',
  state: installed.state,
  blockers: installed.blockers
});
