#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const required = ['--harness-delta', '--root', '--input'];
const args = process.argv.slice(2);
const options = new Map();
let invalid = args.length !== 6;
for (let i = 0; i < args.length; i += 2) {
  if (!required.includes(args[i]) || options.has(args[i]) || !args[i + 1]) invalid = true;
  options.set(args[i], args[i + 1]);
}
const fail = code => { process.stderr.write(code + '\n'); process.exit(1); };
if (invalid || required.some(key => !options.has(key))) fail('invalid_harness_skill_input');
if (![24, 26].includes(Number(process.versions.node.split('.')[0]))) fail('unsupported_node');
const cli = join(resolve(options.get('--harness-delta')), 'dist', 'harness-config-main.js');
if (!existsSync(cli)) fail('harness_delta_build_required');
const result = spawnSync(process.execPath, [cli, 'compare', '--root', options.get('--root'), '--input', options.get('--input')], { stdio: 'inherit' });
if (result.error || result.signal) fail('harness_config_command_failed');
process.exitCode = result.status ?? 1;
