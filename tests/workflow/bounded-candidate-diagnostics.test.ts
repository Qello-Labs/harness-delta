import { expect, test } from 'vitest';
import { CodexFailureClassifier } from '../../src/workflow/bounded-candidate-diagnostics.js';
function classify(...chunks: string[]) {
  const parser = new CodexFailureClassifier();
  for (const chunk of chunks) parser.push(Buffer.from(chunk));
  return parser.finish();
}

test.each([
  ['ERROR: Missing bearer or basic authentication in header PRIVATE_SECRET\n', 'auth_missing', 'missing_authentication'],
  ['Error: missing API key PRIVATE_SECRET\n', 'auth_missing', 'missing_authentication'],
  ['ERROR: unexpected status 401 Unauthorized PRIVATE_SECRET\n', 'auth_failed', 'http_401'],
  ['ERROR: unexpected status 403 Forbidden PRIVATE_SECRET\n', 'unknown', 'http_403'],
  ['ERROR: Model PRIVATE_MODEL does not exist or you do not have access to it\n', 'model_access', 'model_access_denied'],
  ['ERROR: ECONNREFUSED at PRIVATE_URL\n', 'network', 'econnrefused'],
  ['ERROR: ENOTFOUND PRIVATE_URL\n', 'network', 'enotfound'],
  ['ERROR: ETIMEDOUT PRIVATE_URL\n', 'network', 'etimedout'],
  ['ERROR: error sending request for url PRIVATE_URL\n', 'network', 'request_transport_failed'],
  ['ERROR: unexpected status 503 PRIVATE_BODY\n', 'provider', 'http_503'],
  ['ERROR: unexpected status 429 PRIVATE_BODY\n', 'provider', 'http_429'],
  ['Error parsing -c overrides: PRIVATE_CONFIG\n', 'invalid_config', 'configuration_load_failed'],
  ['Error loading config.toml:\nPRIVATE_CONFIG\n', 'invalid_config', 'configuration_load_failed'],
  ['{"type":"error","code":"invalid_api_key","message":"PRIVATE_SECRET"}\n', 'auth_failed', 'invalid_api_key'],
  ['{"type":"turn.failed","error":{"code":"model_not_found","message":"PRIVATE_SECRET"}}\n', 'model_access', 'model_not_found'],
  ['{"type":"error","code":"insufficient_quota","message":"PRIVATE_SECRET"}\n', 'provider', 'insufficient_quota']
] as const)('classifies only fixed observations: case %s', (line, category, code) => {
  const result = classify(line);
  expect(result).toEqual({ channel: 'stderr', signals: [{ category, code }], unknownErrorObserved: false, truncated: false });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

test('ignores non-error text/JSON; unknown codes and malformed JSON never escape', () => {
  const result = classify(
    'PRIVATE_SECRET\nHTTP status 401\n{"type":"item.completed","item":{"type":"agent_message","text":"ERROR: missing API key PRIVATE_SECRET"}}\n{"type":"error","code":"PRIVATE_CODE","message":"PRIVATE_SECRET"}\nERROR: PRIVATE_UNKNOWN\n{"type":"error",PRIVATE_MALFORMED\n'
  );
  expect(result).toEqual({ channel: 'stderr', signals: [], unknownErrorObserved: true, truncated: false });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

test('split chunks, ANSI errors and final line classify without raw values; repeated signals deduplicate', () => {
  const result = classify(
    '\u001b[31mERROR:\u001b[0m unex',
    'pected status 401 Unauthorized\nERROR: unexpected status 401 Unauthorized\nERROR: ENOT',
    'FOUND PRIVATE_URL'
  );
  expect(result.signals).toEqual([
    { category: 'auth_failed', code: 'http_401' },
    { category: 'network', code: 'enotfound' }
  ]);
  expect(result.truncated).toBe(false);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

test('overlong line is dropped through newline while later complete known error remains classifiable', () => {
  const result = classify('ERROR: ' + 'PRIVATE'.repeat(2000), ' status 401\nERROR: ENOTFOUND PRIVATE_URL\n');
  expect(result.signals).toEqual([{ category: 'network', code: 'enotfound' }]);
  expect(result.truncated).toBe(true);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

test('total byte bound drops excess rather than trusting a cut or later error', () => {
  const result = classify('x'.repeat(131_065), 'ERROR: unexpected status 401 Unauthorized PRIVATE_SECRET\n');
  expect(result.signals).toEqual([]);
  expect(result.truncated).toBe(true);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

test('conflicting observations remain separate and cannot select one claimed root cause', () => {
  expect(classify('ERROR: missing API key\nERROR: unexpected status 503\nERROR: PRIVATE_UNKNOWN\n')).toEqual({
    channel: 'stderr',
    signals: [
      { category: 'auth_missing', code: 'missing_authentication' },
      { category: 'provider', code: 'http_503' }
    ],
    unknownErrorObserved: true,
    truncated: false
  });
});

test('bounded number of distinct signals marks additional known errors as truncated', () => {
  const errors = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].map(
    code => `ERROR: ${code}\n`
  );
  errors.push(...[401, 403, 429, 500, 502, 503, 504].map(code => `ERROR: unexpected status ${String(code)}\n`));
  errors.push(
    ...['invalid_api_key', 'model_not_found', 'rate_limit_exceeded'].map(code => JSON.stringify({ type: 'error', code, message: 'PRIVATE_SECRET' }) + '\n')
  );
  const result = classify(...errors);
  expect(result.signals).toHaveLength(16);
  expect(result.truncated).toBe(true);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
