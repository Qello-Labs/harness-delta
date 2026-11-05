/** Fixed observations from bounded, transient Codex stderr. No raw output,
 * arbitrary values, paths, URLs or error messages leave this classifier. Signals
 * are evidence of reported errors, never proof of authentication or root cause.
 */
export type CodexFailureCategory = 'auth_missing' | 'auth_failed' | 'model_access' | 'network' | 'provider' | 'invalid_config' | 'unknown';
export interface CodexFailureSignal {
  category: CodexFailureCategory;
  code: string;
}
export interface CodexFailureSummary {
  channel: 'stderr';
  signals: CodexFailureSignal[];
  unknownErrorObserved: boolean;
  truncated: boolean;
}
const MAX_BYTES = 131_072;
const MAX_LINE_BYTES = 8_192;
const MAX_SIGNALS = 16;
const codes: Readonly<Record<string, CodexFailureCategory>> = {
  missing_authentication: 'auth_missing',
  invalid_api_key: 'auth_failed',
  model_not_found: 'model_access',
  model_access_denied: 'model_access',
  rate_limit_exceeded: 'provider',
  insufficient_quota: 'provider',
  server_overloaded: 'provider'
};
export class CodexFailureClassifier {
  private pending = Buffer.alloc(0);
  private bytes = 0;
  private droppingLine = false;
  private truncated = false;
  private unknownErrorObserved = false;
  private readonly signals = new Map<string, CodexFailureSignal>();
  push(chunk: Buffer): void {
    const remaining = Math.max(0, MAX_BYTES - this.bytes);
    const accepted = chunk.subarray(0, remaining);
    this.bytes += accepted.length;
    if (accepted.length !== chunk.length) this.truncated = true;
    if (accepted.length === 0) return;
    let start = 0;
    for (let offset = 0; offset <= accepted.length; offset++) {
      if (offset !== accepted.length && accepted[offset] !== 10) continue;
      const fragment = accepted.subarray(start, offset);
      if (!this.droppingLine) {
        if (this.pending.length + fragment.length > MAX_LINE_BYTES) {
          this.pending = Buffer.alloc(0);
          this.droppingLine = true;
          this.truncated = true;
        } else this.pending = Buffer.concat([this.pending, fragment]);
      }
      if (offset < accepted.length) {
        if (!this.droppingLine) this.classify(this.pending.toString('utf8'));
        this.pending = Buffer.alloc(0);
        this.droppingLine = false;
      }
      start = offset + 1;
    }
  }
  finish(): CodexFailureSummary {
    // Never classify a prefix cut by the total byte limit.
    if (!this.truncated && !this.droppingLine && this.pending.length) this.classify(this.pending.toString('utf8'));
    this.pending = Buffer.alloc(0);
    return {
      channel: 'stderr',
      signals: [...this.signals.values()].map(value => ({ ...value })),
      unknownErrorObserved: this.unknownErrorObserved,
      truncated: this.truncated
    };
  }
  private add(category: CodexFailureCategory, code: string): void {
    if (this.signals.has(code)) return;
    if (this.signals.size === MAX_SIGNALS) {
      this.truncated = true;
      return;
    }
    this.signals.set(code, { category, code });
  }
  private classify(raw: string): void {
    const line = raw
      .split(String.fromCharCode(27))
      .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/u, '')))
      .join('')
      .trim();
    let text: string;
    let explicitCode: string | null = null;
    if (line.startsWith('{')) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const data = value as Record<string, unknown>;
      if (data.type !== 'error' && data.type !== 'turn.failed') return;
      const error = data.error !== null && typeof data.error === 'object' ? (data.error as Record<string, unknown>) : data;
      text = typeof error.message === 'string' ? error.message : '';
      explicitCode = typeof error.code === 'string' && Object.hasOwn(codes, error.code) ? error.code : null;
    } else {
      if (!/^(?:ERROR|Error):/u.test(line) && !/^Error (?:parsing -c overrides|loading config\.toml|loading rules|finding codex home):/u.test(line)) return;
      text = line;
    }
    if (explicitCode !== null) {
      this.add(codes[explicitCode]!, explicitCode);
      return;
    }
    if (/^Error (?:parsing -c overrides|loading config\.toml|loading rules|finding codex home):/u.test(text)) {
      this.add('invalid_config', 'configuration_load_failed');
      return;
    }
    if (/missing bearer or basic authentication in header|\bmissing (?:API key|authentication credentials)\b/i.test(text)) {
      this.add('auth_missing', 'missing_authentication');
      return;
    }
    if (/\bmodel\b.{0,80}\b(?:does not exist|not found|not supported|not available|do not have access|not have access|not authorized)\b/i.test(text)) {
      this.add('model_access', 'model_access_denied');
      return;
    }
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
      if (new RegExp(`\\b${code}\\b`, 'u').test(text)) {
        this.add('network', code.toLowerCase());
        return;
      }
    }
    if (/error sending request for url|websocket connection failed/i.test(text)) {
      this.add('network', 'request_transport_failed');
      return;
    }
    const status = /\b(?:HTTP(?: status)?|status(?: code)?)[: ]+(401|403|429|500|502|503|504)\b/i.exec(text)?.[1];
    if (status) {
      this.add(status === '401' ? 'auth_failed' : status === '403' ? 'unknown' : 'provider', `http_${status}`);
      return;
    }
    this.unknownErrorObserved = true;
  }
}
