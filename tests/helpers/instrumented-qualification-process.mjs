import { spawn } from 'node:child_process';

if (process.argv[2] === 'descendant') {
  process.stdout.write(`${JSON.stringify({ parent: process.ppid, descendant: process.pid })}\n`);
  process.stdin.resume();
} else {
  spawn(process.execPath, [import.meta.filename, 'descendant'], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}
