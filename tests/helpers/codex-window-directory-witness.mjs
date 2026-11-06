import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const original = fs.opendirSync;
fs.opendirSync = function (...args) {
  const directory = Reflect.apply(original, fs, args);
  const read = directory.readSync.bind(directory);
  directory.readSync = function (...values) {
    const entry = read(...values);
    if (entry?.name === 'codex-window-native-entry') process.stderr.write('CODEX_WINDOW_NATIVE_ENUMERATION\n');
    return entry;
  };
  return directory;
};
syncBuiltinESMExports();
await import('../../scripts/session-binding-codex-window-hook.mjs');
