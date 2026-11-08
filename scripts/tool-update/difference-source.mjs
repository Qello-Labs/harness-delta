import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical, compareVersions, digest, fail, ToolUpdateError, versionSchema } from './manifest.mjs';
import {
  claudeDocumentationPaths,
  claudeDocumentationRules,
  claudeDocumentedContradictions,
  codexContractDescriptors,
  codexSchemaFields,
  codexSourcePaths,
  consumedContracts,
  mapRevision,
  methods,
  requiredFacets
} from './difference-contracts.mjs';
import { differenceJobId, parseDifferenceEvidence, parseDifferenceJob, requiredDifferenceCoverage } from './difference-records.mjs';

export const codexSourceLimits = Object.freeze({
  documentBytes: 4 * 1024 * 1024,
  jobBytes: 16 * 1024 * 1024,
  responses: 128,
  redirects: 5,
  deadlineMs: 120000
});
const origin = 'https://api.github.com';
const repositoryPath = '/repos/openai/codex';
const repositoryNumber = 965415649;
const claudeRepository = Object.freeze({
  path: '/repos/anthropics/claude-code',
  number: 937253475
});
const claudeRepositorySchema = z.object({
  id: z.literal(claudeRepository.number),
  name: z.literal('claude-code'),
  full_name: z.literal('anthropics/claude-code'),
  owner: z.object({
    login: z.literal('anthropics'),
    id: z.literal(76263028)
  }),
  fork: z.literal(false)
});
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const objectSchema = z.object({ sha: oid, type: z.enum(['commit', 'tag']) });
const repositorySchema = z.object({
  id: z.literal(repositoryNumber),
  name: z.literal('codex'),
  full_name: z.literal('openai/codex'),
  owner: z.object({ login: z.literal('openai'), id: z.literal(14957082) }),
  fork: z.literal(false)
});
const treeSchema = z.object({
  sha: oid,
  truncated: z.literal(false),
  tree: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(256)
          .refine(path => !path.includes('/') && path !== '.' && path !== '..'),
        mode: z.enum(['040000', '100644', '100755', '120000', '160000']),
        type: z.enum(['tree', 'blob', 'commit']),
        sha: oid
      })
    )
    .min(1)
    .max(20000)
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const redirects = new Set([301, 302, 303, 307, 308]);
const failureCodes = new Set([
  'source_document_invalid',
  'source_identity_invalid',
  'source_redirect_invalid',
  'source_document_limit',
  'source_job_limit',
  'source_response_limit',
  'source_rate_limited',
  'source_material_absent',
  'source_http_error',
  'source_identity_drift',
  'source_commit_mismatch',
  'source_deadline',
  'source_fetch_failed'
]);
const schemaLeaf = z
  .strictObject({
    type: z.enum(['string', 'integer', 'number', 'boolean']),
    enum: z
      .array(z.string())
      .min(1)
      .max(256)
      .refine(values => new Set(values).size === values.length)
      .optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    pattern: z.string().optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional()
  })
  .refine(value => value.enum === undefined || value.type === 'string')
  .refine(value => value.type === 'string' || [value.minLength, value.maxLength, value.pattern].every(item => item === undefined))
  .refine(value => ['integer', 'number'].includes(value.type) || [value.minimum, value.maximum].every(item => item === undefined));
const cancel = body => {
  void body?.cancel().catch(() => {});
};

function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('source_document_invalid');
  }
}
function parseMetadata(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail('source_identity_invalid');
  return parsed.data;
}
async function bounded(promise, signal) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
function sameResource(destination, original, repository) {
  const suffix = original.pathname.slice(repository.path.length);
  const query = url => canonical([...url.searchParams.entries()].sort());
  return (
    destination.origin === origin &&
    !destination.username &&
    !destination.password &&
    !destination.hash &&
    (destination.pathname === original.pathname || destination.pathname === `/repositories/${repository.number}${suffix}`) &&
    query(destination) === query(original)
  );
}
async function readBytes(response, signal, ledger) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > codexSourceLimits.documentBytes)) {
    cancel(response.body);
    fail('source_document_limit');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('source_document_invalid');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await bounded(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      ledger.decodedBytes += value.byteLength;
      if (size > codexSourceLimits.documentBytes) {
        fail('source_document_limit');
      }
      if (ledger.decodedBytes > codexSourceLimits.jobBytes) {
        fail('source_job_limit');
      }
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size === 0) fail('source_document_invalid');
  return Buffer.concat(chunks);
}
function sourceTransport(fetchImpl, signal, ledger, repository = { path: repositoryPath, number: repositoryNumber }) {
  const snapshots = new Map();
  async function request(path, validator = null) {
    const original = new URL(`${origin}${repository.path}${path}`);
    let current = original;
    const visited = new Set();
    for (let hop = 0; hop <= codexSourceLimits.redirects; hop++) {
      if (visited.has(current.href)) fail('source_redirect_invalid');
      visited.add(current.href);
      if (ledger.responses >= codexSourceLimits.responses) {
        fail('source_response_limit');
      }
      signal.throwIfAborted();
      const headers = {
        accept: path.startsWith('/git/blobs/') || path.startsWith('/contents/') ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'user-agent': 'harness-delta-tool-update'
      };
      if (validator !== null) headers['if-none-match'] = validator;
      ledger.responses++;
      const response = await bounded(
        fetchImpl(current.href, {
          redirect: 'manual',
          signal,
          headers
        }),
        signal
      );
      if (response.redirected || (response.url && response.url !== current.href)) {
        cancel(response.body);
        fail('source_redirect_invalid');
      }
      if (redirects.has(response.status)) {
        cancel(response.body);
        let destination;
        try {
          destination = new URL(response.headers.get('location') ?? '', current);
        } catch {
          fail('source_redirect_invalid');
        }
        if (!sameResource(destination, original, repository)) {
          fail('source_redirect_invalid');
        }
        current = destination;
        continue;
      }
      if (response.status === 304 && validator !== null) {
        cancel(response.body);
        return null;
      }
      if (response.status !== 200) {
        cancel(response.body);
        if ([403, 429].includes(response.status)) {
          fail('source_rate_limited');
        }
        if (response.status === 404) fail('source_material_absent');
        fail('source_http_error');
      }
      const etag = response.headers.get('etag');
      if (etag !== null && (etag.length > 1024 || /[\r\n]/.test(etag))) {
        cancel(response.body);
        fail('source_identity_invalid');
      }
      return { bytes: await readBytes(response, signal, ledger), etag };
    }
    return fail('source_redirect_invalid');
  }
  return {
    async get(path) {
      const response = await request(path);
      const previous = snapshots.get(path);
      if (previous && previous.digest !== hash(response.bytes)) {
        fail('source_identity_drift');
      }
      snapshots.set(path, {
        digest: hash(response.bytes),
        etag: response.etag
      });
      return response.bytes;
    },
    async revalidate() {
      for (const [path, snapshot] of snapshots) {
        const response = await request(path, snapshot.etag);
        if (response !== null && hash(response.bytes) !== snapshot.digest) fail('source_identity_drift');
      }
    }
  };
}
async function resolveRef(transport, ref, prefix = 'rust-v') {
  const tag = `${prefix}${ref.version}`;
  const pointer = parseMetadata(z.object({ ref: z.literal(`refs/tags/${tag}`), object: objectSchema }), parseJson(await transport.get(`/git/ref/tags/${tag}`)));
  let object = pointer.object;
  const visited = new Set();
  while (object.type === 'tag') {
    if (visited.has(object.sha) || visited.size >= 5) {
      fail('source_identity_invalid');
    }
    visited.add(object.sha);
    const annotated = parseMetadata(
      z.object({
        sha: z.literal(object.sha),
        tag: z.string(),
        object: objectSchema
      }),
      parseJson(await transport.get(`/git/tags/${object.sha}`))
    );
    if (visited.size === 1 && annotated.tag !== tag) {
      fail('source_identity_invalid');
    }
    object = annotated.object;
  }
  if (object.sha !== ref.commit) fail('source_commit_mismatch');
}
function treeReader(transport) {
  const trees = new Map();
  return async sha => {
    if (!trees.has(sha)) {
      const tree = parseMetadata(treeSchema, parseJson(await transport.get(`/git/trees/${sha}`)));
      if (tree.sha !== sha || new Set(tree.tree.map(entry => entry.path)).size !== tree.tree.length) fail('source_identity_invalid');
      trees.set(sha, new Map(tree.tree.map(entry => [entry.path, entry])));
    }
    return trees.get(sha);
  };
}
async function sourceSnapshot(transport, readTree, schemas, commit) {
  const identities = [];
  let issue = null;
  let schemaSha = null;
  for (const [pathId, descriptor] of Object.entries(codexSourcePaths)) {
    let sha = commit;
    let entry;
    const parts = descriptor.path.split('/');
    for (const [index, part] of parts.entries()) {
      entry = (await readTree(sha)).get(part);
      if (!entry || (index < parts.length - 1 && (entry.type !== 'tree' || entry.mode !== '040000'))) {
        entry = undefined;
        break;
      }
      sha = entry.sha;
    }
    const valid = entry?.type === descriptor.type && (descriptor.type === 'tree' ? entry.mode === '040000' : ['100644', '100755'].includes(entry.mode));
    if (!valid) {
      issue = ['workspace_manifest', 'dependency_lock', 'cargo_configuration', 'local_patches', 'vendored_inputs'].includes(pathId)
        ? 'unresolved_dependency'
        : (issue ?? 'unsupported_extractor');
    }
    identities.push({ path_id: pathId, sha: valid ? entry.sha : null });
    if (pathId === 'configuration_schema' && valid) schemaSha = entry.sha;
  }
  let schema = null;
  if (schemaSha !== null) {
    if (!schemas.has(schemaSha)) {
      const bytes = await transport.get(`/git/blobs/${schemaSha}`);
      const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (actual !== schemaSha) fail('source_identity_invalid');
      schemas.set(schemaSha, parseJson(bytes));
    }
    schema = schemas.get(schemaSha);
  }
  return {
    identities,
    contentHash: digest(identities),
    issue,
    schema,
    schemaHash: schemaSha === null ? null : digest(schema)
  };
}

function schemaShape(input, definitions, visited = new Set(), depth = 0) {
  if (depth >= 32) fail('source_schema_unsupported');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('source_schema_unsupported');
  }
  const annotations = ['description', 'title', 'default', 'examples'];
  const keys = Object.keys(input).filter(key => !annotations.includes(key));
  if ('$ref' in input || 'allOf' in input) {
    if (keys.length !== 1) fail('source_schema_unsupported');
    if ('allOf' in input) {
      if (!Array.isArray(input.allOf) || input.allOf.length !== 1) {
        fail('source_schema_unsupported');
      }
      return schemaShape(input.allOf[0], definitions, visited, depth + 1);
    }
    const name = typeof input.$ref === 'string' && /^#\/definitions\/([A-Za-z0-9_]+)$/.exec(input.$ref)?.[1];
    if (!name || !Object.hasOwn(definitions, name) || visited.has(name)) {
      fail('source_schema_dependency');
    }
    return schemaShape(definitions[name], definitions, new Set([...visited, name]), depth + 1);
  }
  const parsed = schemaLeaf.safeParse(Object.fromEntries(keys.map(key => [key, input[key]])));
  if (!parsed.success) fail('source_schema_unsupported');
  return {
    ...parsed.data,
    ...(parsed.data.enum ? { enum: [...parsed.data.enum].sort() } : {})
  };
}
function schemaProjection(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) fail('source_schema_unsupported');
  const allowed = ['$schema', 'type', 'properties', 'definitions', 'required', 'additionalProperties', 'title', 'description'];
  if (
    Object.keys(schema).some(key => !allowed.includes(key)) ||
    schema.$schema !== 'http://json-schema.org/draft-07/schema#' ||
    schema.type !== 'object' ||
    schema.additionalProperties !== false ||
    !schema.properties ||
    typeof schema.properties !== 'object' ||
    Array.isArray(schema.properties)
  ) {
    fail('source_schema_unsupported');
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(value => typeof value !== 'string') || new Set(required).size !== required.length) {
    fail('source_schema_unsupported');
  }
  const definitions = schema.definitions ?? {};
  if (definitions === null || typeof definitions !== 'object' || Array.isArray(definitions)) fail('source_schema_unsupported');
  if (!codexSchemaFields.some(({ property }) => Object.hasOwn(schema.properties, property))) fail('source_schema_unsupported');
  return codexSchemaFields.map(({ property, fieldId }) => {
    const field = { fieldId, required: required.includes(property) };
    try {
      return {
        ...field,
        shape: Object.hasOwn(schema.properties, property) ? schemaShape(schema.properties[property], definitions) : null,
        reason: null
      };
    } catch (error) {
      if (!(error instanceof ToolUpdateError)) throw error;
      return {
        ...field,
        shape: null,
        reason: error.code === 'source_schema_dependency' ? 'unresolved_dependency' : 'unsupported_extractor'
      };
    }
  });
}
const finding = (contractId, facet, result, reason) => ({
  contract_id: contractId,
  facet,
  result,
  reason,
  impact: result === 'unaffected' ? 'none_established' : 'undetermined',
  field_id: null,
  expected: null,
  actual: null
});
function sourceFindings(job, from, to) {
  const reason = from.issue ?? to.issue ?? (from.contentHash === to.contentHash ? 'established_unchanged' : 'source_changed_impact_unknown');
  return Object.entries(codexContractDescriptors).flatMap(([contractId, descriptor]) =>
    descriptor.facets
      .filter(facet => requiredFacets(contractId, job.lane).includes(facet))
      .map(facet => finding(contractId, facet, reason === 'established_unchanged' ? 'unaffected' : 'unknown', reason))
  );
}
function schemaFindings(from, to) {
  const contractId = 'invocation_permissions_config_model_effort';
  try {
    const before = schemaProjection(from.schema);
    const after = schemaProjection(to.schema);
    const fact = field => ({
      kind: 'field_shape',
      value: field.shape === null ? 'absent' : field.shape.enum ? 'string_enum' : field.shape.type
    });
    const findings = before.flatMap((field, index) => {
      const actual = after[index];
      const reason = field.reason ?? actual.reason;
      if (reason) {
        return [finding(contractId, 'serialized_shape', 'unknown', reason)];
      }
      if (canonical(field) === canonical(actual)) return [];
      if ([field.shape, actual.shape].some(shape => shape !== null && Object.keys(shape).some(key => !['type', 'enum'].includes(key)))) {
        return [finding(contractId, 'serialized_shape', 'unknown', 'source_changed_impact_unknown')];
      }
      return [
        {
          ...finding(contractId, 'serialized_shape', 'affected', 'confirmed_contract_change'),
          impact: 'shape_changed',
          field_id: field.fieldId,
          expected: fact(field),
          actual: fact(actual)
        }
      ];
    });
    const strongest = findings.find(row => row.result === 'affected') ?? findings.find(row => row.result === 'unknown');
    return strongest ? [strongest] : [];
  } catch (error) {
    if (!(error instanceof ToolUpdateError)) throw error;
    const reason = error.code === 'source_schema_dependency' ? 'unresolved_dependency' : 'unsupported_extractor';
    return [finding(contractId, 'serialized_shape', 'unknown', reason)];
  }
}
function evidenceRecord(job, comparison, method, from, to, failure) {
  const source = method === 'codex_source_identity';
  const issue = !failure && source ? (from.issue ?? to.issue) : null;
  return parseDifferenceEvidence({
    schema_version: 1,
    kind: 'difference_evidence',
    job_id: differenceJobId(job),
    source_digest: job.source_digest,
    engine_digest: job.engine_digest,
    map_revision: job.map_revision,
    engine_revision: job.engine_revision,
    contract_revision: job.contract_revision,
    policy_revision: job.evidence_snapshot.policy_revision,
    capability_revision: 'difference-capability-v1',
    method,
    comparison,
    material: {
      kind: 'official',
      repository_id: job.repository_id,
      path_id: source ? 'source_closure' : 'serialized_schema',
      from_commit: comparison.from.commit,
      to_commit: comparison.to.commit
    },
    from_content_hash: failure ? null : source ? from.contentHash : from.schemaHash,
    to_content_hash: failure ? null : source ? to.contentHash : to.schemaHash,
    availability: failure ? 'failed' : !source && (from.schemaHash === null || to.schemaHash === null) ? 'absent' : 'available',
    extraction_completeness: failure || issue === 'unresolved_dependency' ? 'incomplete' : issue ? 'unsupported' : 'complete',
    findings: failure ? [] : source ? sourceFindings(job, from, to) : schemaFindings(from, to),
    reasons: failure || (!source && (from.schemaHash === null || to.schemaHash === null)) ? ['pinned_material_absent'] : []
  });
}

export async function collectCodexSourceEvidence(jobInput, options) {
  const job = parseDifferenceJob(jobInput);
  if (job.repository_id !== 'openai_codex' || job.lane.product !== 'codex') {
    fail('source_job_inapplicable');
  }
  if (job.map_revision !== mapRevision) fail('source_map_stale');
  if (
    !options ||
    Object.keys(options).some(key => !['fetch', 'signal'].includes(key)) ||
    typeof options.fetch !== 'function' ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  ) {
    fail('source_options_invalid');
  }
  const comparisons = requiredDifferenceCoverage(job).comparisons;
  const refs = [...new Map([...comparisons.flatMap(row => [row.from, row.to]), job.target].map(ref => [`${ref.version}:${ref.commit}`, ref])).values()];
  const ledger = { responses: 0, decodedBytes: 0 };
  if (refs.length > codexSourceLimits.responses) {
    return {
      evidence: [],
      failure: 'source_response_limit',
      usage: ledger
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ToolUpdateError('source_deadline')), codexSourceLimits.deadlineMs);
  timer.unref();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const transport = sourceTransport(options.fetch, signal, ledger);
  const snapshots = new Map();
  let failure = null;
  try {
    parseMetadata(repositorySchema, parseJson(await transport.get('')));
    for (const ref of refs) await resolveRef(transport, ref);
    const readTree = treeReader(transport);
    const schemas = new Map();
    for (const ref of refs) {
      snapshots.set(ref.commit, await sourceSnapshot(transport, readTree, schemas, ref.commit));
    }
    await transport.revalidate();
  } catch (error) {
    failure = signal.aborted ? 'source_deadline' : error instanceof ToolUpdateError && failureCodes.has(error.code) ? error.code : 'source_fetch_failed';
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return {
    evidence: comparisons.flatMap(comparison =>
      ['codex_source_identity', 'serialized_schema'].map(method =>
        evidenceRecord(job, comparison, method, snapshots.get(comparison.from.commit), snapshots.get(comparison.to.commit), failure)
      )
    ),
    failure,
    usage: { ...ledger }
  };
}

function documentationSections(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('source_document_invalid');
  }
  const sections = new Map();
  let current = null;
  let fence = null;
  let html = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && /^[ \t]*$/.test(marker[2])) fence = null;
      continue;
    }
    if (html !== null) {
      if (html.test(line)) html = null;
      else if (line.includes('<')) return null;
      continue;
    }
    if (marker) {
      if (marker[1][0] === '`' && marker[2].includes('`')) return null;
      fence = marker[1];
      continue;
    }
    const htmlStart = /^ {0,3}<(pre|code)>[ \t]*$/i.exec(line);
    if (htmlStart) {
      html = new RegExp(`^ {0,3}</${htmlStart[1]}>[ \\t]*$`, 'i');
      continue;
    }
    // Unclassified markup can change whether later lines are examples.
    if (line.includes('<') || line.includes('-->')) return null;
    if (/^(?:`{3,}|~{3,})/.test(line.trimStart())) return null;
    if (/^ {0,3}#{3,6}(?:[ \t]|$)/.test(line) || /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) return null;
    if (line.startsWith('## ')) {
      const version = line.slice(3);
      if (!versionSchema.safeParse(version).success || sections.has(version)) return null;
      current = [];
      sections.set(version, current);
    } else if (current) {
      if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return null;
      current.push(line);
    }
  }
  return sections.size && fence === null && html === null ? sections : null;
}
async function claudeDocumentationSnapshot(transport, readTree, blobs, ref) {
  const entry = (await readTree(ref.commit)).get(claudeDocumentationPaths.changelog.path);
  if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('source_material_absent');
  if (!blobs.has(entry.sha)) {
    const bytes = await transport.get(`/git/blobs/${entry.sha}`);
    if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) fail('source_identity_invalid');
    blobs.set(entry.sha, {
      contentHash: hash(bytes),
      sections: documentationSections(bytes)
    });
  }
  return blobs.get(entry.sha);
}
function documentationFindings(job, comparison, from, to) {
  const versions = job.inventory.releases
    .filter(ref => compareVersions(ref.version, comparison.from.version) > 0 && compareVersions(ref.version, comparison.to.version) <= 0)
    .map(ref => ref.version);
  const complete =
    from.sections?.has(comparison.from.version) && to.sections?.has(comparison.to.version) && versions.every(version => to.sections.has(version));
  const lines = complete ? versions.flatMap(version => to.sections.get(version)) : [];
  const disclosures = claudeDocumentationRules.filter(rule => lines.some(line => rule.keyword.test(line)));
  const contradictions = claudeDocumentedContradictions.filter(rule => lines.some(line => rule.statement.test(line)));
  const findings = consumedContracts.flatMap(contractId =>
    requiredFacets(contractId, job.lane)
      .filter(facet => methods.claude_pinned_documentation.facets.includes(facet))
      .map(facet => {
        const contradiction = contradictions.find(rule => rule.contractId === contractId && rule.facet === facet);
        if (contradiction) {
          return {
            ...finding(contractId, facet, 'affected', 'confirmed_contract_change'),
            impact: contradiction.impact,
            field_id: contradiction.fieldId,
            expected: {
              kind: 'field_shape',
              value: contradiction.expected
            },
            actual: {
              kind: 'field_shape',
              value: contradiction.actual
            }
          };
        }
        const disclosed = disclosures.some(rule => rule.contractId === contractId && rule.facet === facet);
        return finding(
          contractId,
          facet,
          'unknown',
          !complete ? 'unsupported_extractor' : disclosed ? 'documentation_check_required' : 'undocumented_contract'
        );
      })
  );
  return { findings, complete: Boolean(complete) };
}
function claudeDocumentationEvidence(job, comparison, snapshots, failure, unversioned) {
  const from = snapshots.get(comparison.from.commit);
  const to = snapshots.get(comparison.to.commit);
  const projection = !failure && !unversioned ? documentationFindings(job, comparison, from, to) : null;
  return parseDifferenceEvidence({
    schema_version: 1,
    kind: 'difference_evidence',
    job_id: differenceJobId(job),
    source_digest: job.source_digest,
    engine_digest: job.engine_digest,
    map_revision: job.map_revision,
    engine_revision: job.engine_revision,
    contract_revision: job.contract_revision,
    policy_revision: job.evidence_snapshot.policy_revision,
    capability_revision: 'difference-capability-v1',
    method: 'claude_pinned_documentation',
    comparison,
    material: {
      kind: 'official',
      repository_id: job.repository_id,
      path_id: 'release_documentation',
      from_commit: comparison.from.commit,
      to_commit: comparison.to.commit
    },
    from_content_hash: projection ? from.contentHash : null,
    to_content_hash: projection ? to.contentHash : null,
    availability: failure ? 'failed' : unversioned ? 'absent' : 'available',
    extraction_completeness: projection?.complete ? 'complete' : 'incomplete',
    findings: projection?.findings ?? [],
    reasons: failure ? ['pinned_material_absent'] : unversioned ? ['pinned_material_absent', 'unversioned_doc'] : []
  });
}
export async function collectClaudeDocumentationEvidence(jobInput, options) {
  const job = parseDifferenceJob(jobInput);
  if (job.repository_id !== 'anthropics_claude_code' || job.lane.product !== 'claude_code') fail('source_job_inapplicable');
  if (job.map_revision !== mapRevision) fail('source_map_stale');
  if (
    !options ||
    Object.keys(options).some(key => !['fetch', 'signal', 'documentation'].includes(key)) ||
    typeof options.fetch !== 'function' ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
    (options.documentation !== undefined && !['pinned', 'unversioned_doc'].includes(options.documentation))
  ) {
    fail('source_options_invalid');
  }
  const unversioned = options.documentation === 'unversioned_doc';
  const comparisons = requiredDifferenceCoverage(job).comparisons;
  const refs = [...new Map([...comparisons.flatMap(row => [row.from, row.to]), job.target].map(ref => [`${ref.version}:${ref.commit}`, ref])).values()];
  const ledger = { responses: 0, decodedBytes: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ToolUpdateError('source_deadline')), codexSourceLimits.deadlineMs);
  timer.unref();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const transport = sourceTransport(options.fetch, signal, ledger, claudeRepository);
  const snapshots = new Map();
  const documents = [];
  let failure = null;
  try {
    parseMetadata(claudeRepositorySchema, parseJson(await transport.get('')));
    if (unversioned) {
      // Moving documentation is context only: no release endpoint or content hash is assigned to its evidence.
      const bytes = await transport.get(`/contents/${claudeDocumentationPaths.changelog.path}`);
      documents.push({
        path_id: 'release_documentation',
        content_hash: hash(bytes),
        fetched_at: new Date().toISOString(),
        release: null,
        limitation: 'unversioned_doc'
      });
    } else {
      for (const ref of refs) await resolveRef(transport, ref, 'v');
      const readTree = treeReader(transport);
      const blobs = new Map();
      for (const ref of refs) {
        snapshots.set(ref.commit, await claudeDocumentationSnapshot(transport, readTree, blobs, ref));
      }
    }
    await transport.revalidate();
  } catch (error) {
    failure = signal.aborted ? 'source_deadline' : error instanceof ToolUpdateError && failureCodes.has(error.code) ? error.code : 'source_fetch_failed';
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return {
    evidence: comparisons.map(comparison => claudeDocumentationEvidence(job, comparison, snapshots, failure, unversioned)),
    documents: failure ? [] : documents,
    failure,
    usage: { ...ledger }
  };
}
