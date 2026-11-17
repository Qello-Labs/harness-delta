import { differenceJob } from './tool-update-difference-fixture.js';
import { sourceFixture, syntheticSchema } from './tool-update-source-fixture.js';

export function sourceBudgetJob(refCount: number) {
  const base = differenceJob();
  const versions = ['0.163.0', '0.164.0', '0.165.0', '0.166.0', '0.167.0', '0.167.1', '0.167.2', '0.168.0', '0.169.0'];
  const releases = Array.from({ length: refCount }, (_, index) => ({
    version: versions[index] ?? `0.169.${index - 8}`,
    commit: (index + 1).toString(16).padStart(40, '0')
  }));
  const first = releases[0];
  const target = releases.at(-1);
  if (!first || !target) throw new Error('synthetic_refs_required');
  return {
    ...base,
    baseline_row: base.baseline_row && { ...base.baseline_row, ref: first },
    parser_base: base.parser_base && { ...base.parser_base, ...first },
    comparison: base.comparison && { ...base.comparison, from: first, to: target },
    target,
    inventory: { ...base.inventory, releases }
  };
}

export function sourceBudgetFixture(refCount: number, shared = false) {
  return sourceFixture({
    job: sourceBudgetJob(refCount),
    annotated: true,
    change: (version, files) => {
      if (shared) return;
      for (const [path, file] of files) {
        if (file.type === 'tree') files.set(path, { ...file, value: version });
        if (path.endsWith('config.schema.json')) {
          files.set(path, {
            ...file,
            value: JSON.stringify({ ...syntheticSchema(), title: version })
          });
        }
      }
    }
  });
}
