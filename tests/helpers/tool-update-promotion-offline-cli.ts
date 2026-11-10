import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditedCli, projectRoot } from './tool-update-difference-cli-fixture.js';
import { Store } from '../../src/store.js';

export function populateOfflineStore(root: string) {
  const store = new Store(join(root, 'synthetic.db'), () => '2026-11-09T12:00:00.000Z');
  try {
    store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['synthetic-project', '/synthetic/project']);
    store.execute('INSERT INTO tasks(id,project_id) VALUES (?,?)', ['synthetic-task', 'synthetic-project']);
  } finally {
    store.close();
  }
}

export async function mutationCli(
  root: string,
  args: readonly string[],
  access: 'database' | 'native' | 'private' | 'network' | 'callbackReadFile' | 'callbackReaddir' | 'callbackOpen'
) {
  const entry = pathToFileURL(join(projectRoot, 'scripts/tool-update.mjs')).href;
  const script = join(root, 'mutated-cli.mjs');
  const mutations = {
    database: "process.getBuiltinModule('node:sqlite');",
    native: "process.getBuiltinModule('node:child_process').spawnSync('synthetic-vendor-not-installed');",
    private: "process.getBuiltinModule('node:fs').readFileSync(process.env.HOME + '/synthetic.jsonl');",
    network: "await fetch('https://synthetic.invalid/');",
    callbackReadFile: `
const privatelyRead = await new Promise((resolve, reject) => {
  process.getBuiltinModule('node:fs').readFile(process.env.HOME + '/synthetic.jsonl', 'utf8',
    (error, text) => error ? reject(error) : resolve(text));
});
if (privatelyRead !== 'SYNTHETIC_PRIVATE') throw new Error('private_read_not_exercised');
`,
    callbackReaddir: `
const privateEntries = await new Promise((resolve, reject) => {
  process.getBuiltinModule('node:fs').readdir(process.env.HOME,
    (error, entries) => error ? reject(error) : resolve(entries));
});
if (!privateEntries.includes('synthetic.jsonl')) throw new Error('private_read_not_exercised');
`,
    callbackOpen: `
const fs = process.getBuiltinModule('node:fs');
const privatelyRead = await new Promise((resolve, reject) => {
  fs.open(process.env.HOME + '/synthetic.jsonl', 'r', (error, descriptor) => {
    if (error) return reject(error);
    fs.readFile(descriptor, 'utf8', (readError, text) => {
      fs.close(descriptor, closeError => readError || closeError ? reject(readError || closeError) : resolve(text));
    });
  });
});
if (privatelyRead !== 'SYNTHETIC_PRIVATE') throw new Error('private_read_not_exercised');
`
  } as const;
  if (access.startsWith('callback')) {
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home/synthetic.jsonl'), 'SYNTHETIC_PRIVATE');
  }
  await writeFile(
    script,
    `
import { registerHooks } from 'node:module';
const entry = ${JSON.stringify(entry)};
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url !== entry) return result;
  const source = String(result.source);
  const anchor = 'const sourceRoot = options.root ?? root;';
  if (!source.includes(anchor)) throw new Error('mutation_anchor_missing');
  return { ...result, source: source.replace(anchor, anchor + ${JSON.stringify(mutations[access])}) };
}});
const { runToolUpdate } = await import(entry);
const result = await runToolUpdate(process.argv.slice(2));
process.stdout.write(JSON.stringify(result.output) + '\\n');
process.exitCode = result.exitCode;
`
  );
  return auditedCli(root, script, args);
}
