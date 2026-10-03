import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    if (["node_modules", ".next", ".git", "test-results", "playwright-report"].includes(entry.name)) return [];
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return findTests(path);
    return /\.test\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  }));
  return files.flat().sort();
}

const tests = await findTests(root);
if (!tests.length) {
  console.error("No unit tests found (*.test.ts, *.test.tsx, *.test.js, *.test.mjs).");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
