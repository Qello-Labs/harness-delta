import { z } from 'zod';
import { main } from '../../dist/cli.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const args = z.array(z.string()).parse(JSON.parse(Buffer.concat(chunks).toString()));
process.exitCode = await main(args);
