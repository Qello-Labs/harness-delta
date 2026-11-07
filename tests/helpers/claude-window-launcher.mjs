import 'node:crypto';
import 'node:util';
import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { beginSourceLoad, finishSourceLoad, install } from './claude-window-tripwire.mjs';

const target = pathToFileURL(realpathSync(process.argv[1])).href;
const configuration = JSON.parse(process.env.CLAUDE_WINDOW_FIXTURE);
const sources = new Set([target, ...(configuration.codeFiles ?? []).map(path => pathToFileURL(realpathSync(path)).href)]);
void Response;
void Request;
void Headers;
void fetch;
if (configuration.scenario) await import('./claude-window-connect-transport.mjs');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL || !specifier.startsWith('.') || !sources.has(new URL(specifier, context.parentURL).href)) {
      return nextResolve(specifier, context);
    }
    beginSourceLoad();
    try {
      return nextResolve(specifier, context);
    } finally {
      finishSourceLoad();
    }
  },
  load(url, context, nextLoad) {
    if (!sources.has(url)) return nextLoad(url, context);
    if (url === target) install();
    beginSourceLoad();
    try {
      return nextLoad(url, context);
    } finally {
      finishSourceLoad();
    }
  }
});
