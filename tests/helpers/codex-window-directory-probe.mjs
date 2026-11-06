import { opendirSync } from 'node:fs';

const directory = opendirSync(process.argv[2]);
try {
  let entry = directory.readSync();
  while (entry !== null) entry = directory.readSync();
} finally {
  directory.closeSync();
}
