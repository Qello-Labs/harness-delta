process.stdin.setRawMode(true);
process.stdin.resume();
let input = '';
let submitted = false;
let secondSubmitted = false;
let interrupts = 0;
process.on('SIGINT', () => {
  interrupts++;
  if (interrupts !== 1) process.exit(4);
  process.stdout.write('INTERRUPTED_OK\n');
});
process.stdin.on('data', bytes => {
  input += bytes.toString('utf8');
  if (Buffer.byteLength(input) > 8192) process.exit(2);
  if (!submitted && input === 'synthetic-window-input\n') {
    submitted = true;
    input = '';
    process.stdout.write('INPUT_OK\n');
  } else if (submitted && !secondSubmitted && input === 'synthetic-window-input-2\n') {
    secondSubmitted = true;
    input = '';
    process.stdout.write('INPUT_2_OK\n');
  } else if (submitted && input === 'QUIT\n') {
    process.exit(0);
  }
});
process.stdout.write('READY\n');
