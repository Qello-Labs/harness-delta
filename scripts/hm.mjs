#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export async function launch(argv, root = new URL('../', import.meta.url), nodeVersion = process.versions.node) {
  const fail = (error, message, code) => {
    process.stderr.write(JSON.stringify({ error, message }) + '\n');
    return code;
  };
  if (![24, 26].includes(Number(nodeVersion.split('.')[0]))) {
    return fail('unsupported_node', 'Select Node.js 24 or 26, verify node --version, then run npm ci and npm run build in the checkout. Use the same Node version to run npm start -- <arguments>.', 2);
  }
  const entry = new URL('dist/cli.js', root);
  if (!existsSync(entry)) {
    return fail('build_required', 'From the checkout with Node.js 24 or 26 selected, run npm ci and npm run build, then npm start -- <arguments>.', 3);
  }
  const require = createRequire(new URL('package.json', root));
  try { require.resolve('better-sqlite3'); require.resolve('commander'); }
  catch { return fail('dependencies_required', 'Run npm ci with Node.js 24 or 26 in the checkout, then npm run build and retry.', 4); }
  try {
    const Database = require('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
  } catch {
    return fail('native_dependency', 'Select Node.js 24 or 26 and verify node --version, then run npm ci in the checkout with that selected runtime. Run npm run build and retry using the same Node runtime.', 4);
  }
  const { main } = await import(entry.href);
  return main(argv);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await launch(process.argv.slice(2));
}
