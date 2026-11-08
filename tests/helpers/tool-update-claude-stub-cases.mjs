import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { startStub } from '../../scripts/tool-update/claude-stub.mjs';
import { projectTranscript, reconcileOracle } from '../../scripts/tool-update/claude-oracle.mjs';
import { projectSyntheticReplay } from '../../scripts/tool-update/difference-fixtures.mjs';
import { judgeDifferences } from '../../scripts/tool-update/difference-judgment.mjs';
import { digest } from '../../scripts/tool-update/manifest.mjs';
import { claudeJob } from './tool-update-claude-evidence-fixture.js';
import { currentIdentities } from './tool-update-difference-fixture.js';

async function syntheticClient(endpoint, marker, partial) {
  const response = await fetch(`${endpoint}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      stream: true,
      messages: [{ role: 'user', content: marker }]
    }),
    signal: AbortSignal.timeout(5000)
  });
  const requestId = response.headers.get('request-id');
  const reader = response.body.getReader();
  let text = '',
    start = null,
    usage = null,
    terminal = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      const blocks = text.split('\n\n');
      text = blocks.pop();
      for (const block of blocks) {
        const data = block.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (event.type === 'message_start') start = event.message;
        if (event.type === 'message_delta') usage = event.usage;
        if (event.type === 'message_stop') terminal = true;
      }
      if (partial && usage?.output_tokens === 16) break;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return { requestId, start, usage, terminal };
}
test.each(['normal', 'sigint'])('the existing stub with a synthetic client binds %s arithmetic without a vendor process', async scenario => {
  const interrupted = scenario === 'sigint';
  const stub = await startStub('synthetic-never-executed', interrupted);
  const transcripts = [[], [], []];
  const plan = [
    [0, ''],
    [0, ''],
    [1, 'CONFORMANCE_CHILD_A'],
    [0, ''],
    [2, 'CONFORMANCE_CHILD_B'],
    [0, '']
  ];
  try {
    for (const [index, marker] of plan) {
      const partial = interrupted && transcripts[0].length === 3 && index === 0;
      const wire = await syntheticClient(stub.endpoint, marker, partial);
      const row = {
        type: 'assistant',
        sessionId: 'synthetic-session',
        version: '2.1.306',
        requestId: wire.requestId,
        ...(index === 0 ? {} : { agentId: `child-${index}`, isSidechain: true }),
        message: {
          id: wire.start.id,
          model: wire.start.model,
          stop_reason: wire.terminal ? 'end_turn' : null,
          usage: wire.usage
        }
      };
      transcripts[index].push(row);
    }
    stub.assertHealthy();
    const sources = transcripts.map((rows, index) =>
      projectTranscript(
        rows
          .flatMap(row => [
            row,
            row,
            {
              ...row,
              message: { ...row.message, stop_reason: null }
            }
          ])
          .map(row => JSON.stringify(row) + '\n')
          .join(''),
        'synthetic-session',
        index === 0 ? null : `child-${index}`,
        index === 0 ? ['req_conformance_1'] : []
      )
    );
    const oracle = reconcileOracle(scenario, stub.ledger, sources);
    expect({
      input: oracle.input,
      output: oracle.output,
      retained: oracle.retained,
      missing: oracle.interrupted_usage
    }).toEqual(
      interrupted
        ? {
            input: 540,
            output: 444,
            retained: [2, 1, 1],
            missing: { status: 'missing', value: null }
          }
        : {
            input: 675,
            output: 555,
            retained: [3, 1, 1],
            missing: null
          }
    );
    const expected = [1, 2, 3, 4, 5, 6].map(request => ({
      request,
      message: request,
      owner: request === 3 ? 'child_1' : request === 5 ? 'child_2' : 'root',
      terminal: !(interrupted && request === 6),
      excluded: request === 1,
      counters: {
        input: 135,
        output: interrupted && request === 6 ? 16 : 111,
        cached: 23,
        cache_write: 11,
        reasoning: null
      }
    }));
    const actual = sources.flatMap((source, index) =>
      [...source.entries()].map(([id, row]) => ({
        request: Number(id.split('_').at(-1)),
        message: Number(row.message.split('_').at(-1)),
        owner: index === 0 ? 'root' : `child_${index}`,
        terminal: row.terminal,
        excluded: row.excluded,
        counters: {
          input: row.counters.input_tokens + row.counters.cache_read_input_tokens + row.counters.cache_creation_input_tokens,
          output: row.counters.output_tokens,
          cached: row.counters.cache_read_input_tokens,
          cache_write: row.counters.cache_creation_input_tokens,
          reasoning: null
        }
      }))
    );
    const job = claudeJob();
    const result = projectSyntheticReplay(job, {
      fixture_id: 'counter_ledger_v1',
      scenario_id: interrupted ? 'interrupted' : 'unchanged',
      test_hash: digest(await readFile(new URL(import.meta.url))),
      harness_hash: digest({
        stub: digest(await readFile(new URL('../../scripts/tool-update/claude-stub.mjs', import.meta.url))),
        oracle: digest(await readFile(new URL('../../scripts/tool-update/claude-oracle.mjs', import.meta.url)))
      }),
      input_hash: digest(expected),
      expected,
      actual
    });
    expect(result.matched).toBe(true);
    expect(result.actual.totals.input).toBe(interrupted ? 540 : 675);
    expect(result.actual.missing).toBe(interrupted ? 1 : 0);
    expect(judgeDifferences(job, result.evidence, currentIdentities).groups.every(group => group.result === 'unknown')).toBe(true);
  } finally {
    await stub.close();
  }
});
