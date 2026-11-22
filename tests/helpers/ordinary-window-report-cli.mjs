import { z } from 'zod';
import { main } from '../../dist/cli.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const args = z.array(z.string()).parse(JSON.parse(Buffer.concat(chunks).toString()));
process.emit('harness-delta:control-io-start');
try {
  process.exitCode = await main(args);
} finally {
  process.emit('harness-delta:control-io-stop');
}
