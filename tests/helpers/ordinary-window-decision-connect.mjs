import { z } from 'zod';
import { Store } from '../../dist/store.js';
import { connectOrdinaryCodexWindow } from '../../dist/ordinary-session-binding.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = z
  .strictObject({
    database: z.string(),
    taskId: z.string(),
    receiptDirectory: z.string(),
    sourceRoot: z.string(),
    receipt: z.string()
  })
  .parse(JSON.parse(Buffer.concat(chunks).toString()));
const store = new Store(input.database);
try {
  let outcome;
  try {
    await connectOrdinaryCodexWindow(
      {
        store,
        taskId: input.taskId,
        receiptDirectory: input.receiptDirectory,
        sourceRoots: [input.sourceRoot]
      },
      { receipt: input.receipt }
    );
    outcome = 'connected';
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    outcome = error.message;
  }
  process.stdout.write(JSON.stringify({ outcome }));
} finally {
  store.close();
}
