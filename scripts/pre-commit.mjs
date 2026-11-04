import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function gitPaths(args) {
  return execFileSync("git", args, { encoding: "utf8" }).split("\0").filter(Boolean);
}

const staged = gitPaths(["diff", "--cached", "--name-only", "--no-renames", "-z", "--"]);
const implementation = staged.filter(path =>
  !(path.endsWith(".md") && (!path.includes("/") || path.startsWith("docs/"))),
);

run("npm", ["run", "check:privacy"]);
run("npm", ["run", "lint"]);
run("npm", ["run", "typecheck"]);

if (implementation.length > 0) {
  const deleted = gitPaths(["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=D", "-z", "--"]);
  // Deleted imports and non-imported build/configuration inputs escape related analysis.
  const fullSuite = implementation.some(path => deleted.includes(path) || !(
    (path.startsWith("src/") && path.endsWith(".ts"))
    || (path.startsWith("tests/") && path.endsWith(".test.ts"))
  ));
  const related = new Set(implementation);
  if (!fullSuite && implementation.some(path => path.startsWith("src/"))) {
    // Filesystem reads and subprocess entry paths are not edges in Vitest's import graph.
    for (const path of gitPaths(["ls-files", "--cached", "-z", "--", "tests", "ui/src"])) {
      if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) continue;
      const source = readFileSync(path, "utf8");
      if (/\b(?:child_process|dist)\b|["'](?:node:)?fs(?:\/promises)?["']/.test(source)) {
        related.add(path);
      }
    }
  }

  // Rebuild even for test-only changes: focused tests can spawn dist or freeze the UI.
  run("npm", ["run", "build"]);
  // Absolute paths cannot become options; Vitest related ignores paths after "--".
  run(process.execPath, [
    "node_modules/vitest/vitest.mjs",
    ...(fullSuite ? ["run"] : ["related", "--run"]),
    "--passWithNoTests",
    ...(fullSuite ? [] : Array.from(related, path => resolve(path))),
  ]);
}
