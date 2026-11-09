import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { promotedInputs, snapshotPromotionPins } from '../scripts/tool-update/fixtures.mjs';
import type { PromotionPinSelection } from '../scripts/tool-update/fixtures.mjs';
import { validatePromotionExecutionPins } from '../scripts/tool-update/promotion-execution-pins.mjs';

const roots: string[] = [];
it.each(['scripts/session-binding-codex-promoted-hook.template.mjs', 'skills/harness-connect-promoted-codex/scripts/connect.mjs'])(
  'pins the Claude shared generator input at %s',
  path => {
    const { root, options, packet } = fixture('claude_code');
    put(root, path, 'changed shared generator input\n');
    expect(() => validatePromotionExecutionPins(packet, options)).toThrow('pin_drift');
  }
);
it.each([
  'scripts/session-binding-codex-hook.mjs',
  'skills/harness-connect/SKILL.md',
  'skills/harness-connect/scripts/connect.mjs',
  'skills/harness-connect/scripts/claude-session-hook.mjs'
])('rejects consumed historical installer input drift at %s', path => {
  const { root, options, packet } = fixture('codex');
  put(root, path, 'changed consumed installer input\n');
  expect(() => validatePromotionExecutionPins(packet, options)).toThrow('pin_drift');
});
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function put(root: string, path: string, bytes = 'synthetic\n') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

function fixture(product: 'codex' | 'claude_code', executionMode: 'source' | 'built' = 'source') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'promotion-pins-')));
  roots.push(root);
  const inputs = promotedInputs[product];
  const selection: PromotionPinSelection = {
    product,
    executionMode,
    pinSchemeRevision: 'promotion-execution-v1',
    bundleRevision: inputs.bundleRevision
  };
  for (const path of inputs.consumedInputs) put(root, path);
  for (const member of inputs.historicalSkill.members) {
    put(root, `${inputs.historicalSkill.skill}/${member}`);
    put(root, `${inputs.historicalSkill.builtSkill}/${member}`);
  }
  if (inputs.historicalProducer !== null) {
    for (const path of inputs.historicalProducer) put(root, path);
  }
  for (const member of inputs.members) put(root, `${inputs.skill}/${member}`);
  if (inputs.template !== null) put(root, inputs.template);
  put(root, inputs.producer);
  mkdirSync(dirname(join(root, inputs.builtSkill)), { recursive: true });
  cpSync(join(root, inputs.skill), join(root, inputs.builtSkill), {
    recursive: true
  });
  put(root, inputs.builtProducer);
  put(root, 'src/synthetic.ts');
  put(root, 'dist/synthetic.js');
  put(root, 'scripts/tool-update/synthetic.mjs');
  put(root, 'scripts/generated/synthetic.mjs');
  put(root, 'package.json', '{"type":"module"}');
  put(root, 'package-lock.json', '{"lockfileVersion":3}');
  const options = { repositoryRoot: root };
  const pins = snapshotPromotionPins(selection, options);
  const packet = {
    kind: 'promotion_execution_pins',
    schema_version: 1,
    pin_scheme_revision: selection.pinSchemeRevision,
    product,
    bundle_revision: selection.bundleRevision,
    execution_mode: executionMode,
    pins
  };
  return { root, selection, options, packet, inputs };
}

it.each([
  ['codex', 'source'],
  ['codex', 'built'],
  ['claude_code', 'source'],
  ['claude_code', 'built']
] as const)('validates the complete synthetic %s %s bundle without the other product', (product, mode) => {
  const { packet, options } = fixture(product, mode);
  expect(validatePromotionExecutionPins(packet, options)).toEqual(packet);
});

it.each(['codex', 'claude_code'] as const)('separates source and built %s execution domains', product => {
  const { selection, options, packet } = fixture(product);
  const built = snapshotPromotionPins(
    {
      ...selection,
      executionMode: 'built'
    },
    options
  );
  expect(built.runtime).not.toBe(packet.pins.runtime);
  expect(built.instrument).not.toBe(packet.pins.instrument);
});

it.each([
  ['codex', 'scripts/session-binding-codex-promoted-hook.template.mjs'],
  ['codex', 'scripts/session-binding-codex-promoted-hook.mjs'],
  ['codex', 'skills/harness-connect-promoted-codex/scripts/connect.mjs'],
  ['claude_code', 'skills/harness-connect-promoted-claude/scripts/claude-session-hook.mjs'],
  ['claude_code', 'skills/harness-connect-promoted-claude/scripts/connect.mjs']
] as const)('rejects raw-only %s drift at %s with dist fixed', (product, path) => {
  const { root, selection, options, packet, inputs } = fixture(product);
  put(root, path, 'changed\n');
  if (path === inputs.template) {
    expect(snapshotPromotionPins(selection, options).producer).not.toBe(packet.pins.producer);
  } else {
    expect(() => snapshotPromotionPins(selection, options)).toThrow('pin_drift');
  }
  expect(() => validatePromotionExecutionPins(packet, options)).toThrow('pin_drift');
});

it.each([
  ['codex', 'dist/assets/session-binding-codex-promoted-hook.mjs'],
  ['codex', 'dist/skills/harness-connect-promoted-codex/SKILL.md'],
  ['claude_code', 'dist/skills/harness-connect-promoted-claude/scripts/claude-session-hook.mjs']
] as const)('rejects built-only %s drift at %s with raw fixed', (product, path) => {
  const { root, selection, options, packet } = fixture(product);
  put(root, path, 'changed\n');
  expect(() => snapshotPromotionPins(selection, options)).toThrow('pin_drift');
  expect(() => validatePromotionExecutionPins(packet, options)).toThrow('pin_drift');
});

it.each(
  (['codex', 'claude_code'] as const).flatMap(product =>
    (['raw', 'built'] as const).flatMap(copy =>
      (['missing', 'extra'] as const).map(action => ({
        product,
        copy,
        action
      }))
    )
  )
)('rejects $action $copy $product bundle members even when copies agree', ({ product, copy, action }) => {
  const { root, selection, options, packet, inputs } = fixture(product);
  const paths = copy === 'raw' ? [inputs.skill, inputs.builtSkill] : [inputs.builtSkill];
  for (const path of paths) {
    if (action === 'missing') {
      rmSync(join(root, path, 'scripts/connect.mjs'));
    } else put(root, `${path}/scripts/unreviewed.mjs`);
  }
  expect(() => snapshotPromotionPins(selection, options)).toThrow('pin_drift');
  expect(() => validatePromotionExecutionPins(packet, options)).toThrow('pin_drift');
});

it.each(['codex', 'claude_code'] as const)('pins each consumed %s generator and installer module', product => {
  const { root, options, packet, inputs } = fixture(product);
  for (const path of inputs.consumedInputs) {
    put(root, path, 'changed\n');
    expect(() => validatePromotionExecutionPins(packet, options), path).toThrow('pin_drift');
    put(root, path);
  }
});

it.each(['src/synthetic.ts', 'dist/synthetic.js', 'scripts/tool-update/synthetic.mjs', 'scripts/generated/synthetic.mjs', 'package.json', 'package-lock.json'])(
  'pins full runnable and package inputs at %s',
  path => {
    const { root, options, packet } = fixture('codex');
    put(root, path, 'changed\n');
    expect(() => validatePromotionExecutionPins(packet, options)).toThrow('pin_drift');
  }
);

it.each(['codex', 'claude_code'] as const)('rejects a missing required raw %s producer before capture', product => {
  const { root, selection, options, packet, inputs } = fixture(product);
  rmSync(join(root, inputs.producer));
  expect(() => snapshotPromotionPins(selection, options)).toThrow('pin_drift');
  expect(() => validatePromotionExecutionPins(packet, options)).toThrow('pin_drift');
});

it('rejects symlinked bundle members without following them', () => {
  const { root, selection, options, packet, inputs } = fixture('codex');
  const member = join(root, inputs.skill, 'scripts/connect.mjs');
  rmSync(member);
  symlinkSync(join(root, 'package.json'), member);
  expect(() => snapshotPromotionPins(selection, options)).toThrow('pin_drift');
  expect(() => validatePromotionExecutionPins(packet, options)).toThrow('pin_drift');
});

it.each(['pinSchemeRevision', 'bundleRevision'] as const)('rejects unknown %s before capture or validation', field => {
  const { selection, options, packet } = fixture('codex');
  expect(() => snapshotPromotionPins({ ...selection, [field]: 'unknown' }, options)).toThrow('approval_invalid');
  const key = field === 'pinSchemeRevision' ? 'pin_scheme_revision' : 'bundle_revision';
  expect(() => validatePromotionExecutionPins({ ...packet, [key]: 'unknown' }, options)).toThrow('approval_invalid');
});

it('rejects cross-product bundle revisions', () => {
  const { selection, options, packet } = fixture('codex');
  const bundleRevision = promotedInputs.claude_code.bundleRevision;
  expect(() => snapshotPromotionPins({ ...selection, bundleRevision }, options)).toThrow('approval_invalid');
  expect(() =>
    validatePromotionExecutionPins(
      {
        ...packet,
        bundle_revision: bundleRevision
      },
      options
    )
  ).toThrow('approval_invalid');
});

it.each([
  { kind: 'ordinary_window_execution_pins' },
  { schema_version: 2 },
  { product: 'other' },
  { execution_mode: 'native' },
  { approved: true },
  { input_paths: ['/untrusted'] }
])('rejects unknown packet authority %#', change => {
  const { packet, options } = fixture('codex');
  expect(() => validatePromotionExecutionPins({ ...packet, ...change }, options)).toThrow('approval_invalid');
});

it('rejects malformed and additional pins', () => {
  const { packet, options } = fixture('codex');
  expect(() =>
    validatePromotionExecutionPins(
      {
        ...packet,
        pins: { ...packet.pins, runtime: 'invalid' }
      },
      options
    )
  ).toThrow('approval_invalid');
  expect(() =>
    validatePromotionExecutionPins(
      {
        ...packet,
        pins: { ...packet.pins, binary: 'a'.repeat(64) }
      },
      options
    )
  ).toThrow('approval_invalid');
});
