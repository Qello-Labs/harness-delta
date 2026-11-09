import { parseArgs } from 'node:util';

const product = 'codex';
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
class ConnectError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export function run(operation, options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(key => !['origin', 'project', 'task', 'receipt', 'product'].includes(key)) ||
    !['inspect', 'connect'].includes(operation) ||
    !id(options.project) ||
    !id(options.task) ||
    (options.product !== undefined && options.product !== product) ||
    (options.receipt !== undefined && !uuid(options.receipt)) ||
    (operation === 'connect' && !uuid(options.receipt))
  ) {
    throw new ConnectError('invalid_input');
  }
  let origin;
  try {
    origin = new URL(options.origin);
  } catch {
    throw new ConnectError('invalid_origin');
  }
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port ||
    origin.username ||
    origin.password ||
    origin.origin !== options.origin
  ) {
    throw new ConnectError('invalid_origin');
  }
  return {
    status: 'blocked',
    reason_code: 'promoted_provider_unavailable',
    producer_contract: 'promoted-payload-v1',
    product,
    verified: false,
    collection_active: false
  };
}
function main() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        origin: { type: 'string' },
        project: { type: 'string' },
        task: { type: 'string' },
        receipt: { type: 'string' },
        product: { type: 'string' }
      },
      strict: true,
      allowPositionals: false
    });
    process.stdout.write(JSON.stringify(run(process.argv[2], values)) + '\n');
    process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        status: 'blocked',
        reason_code: error instanceof ConnectError ? error.code : 'invalid_input',
        verified: false,
        collection_active: false
      }) + '\n'
    );
    process.exitCode = 1;
  }
}
if (import.meta.main) main();
