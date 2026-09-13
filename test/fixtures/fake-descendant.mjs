/**
 * Descendant fixture for lifecycle tests. Writes its pid, optionally ignores
 * SIGTERM, and stays alive so cleanup must force-terminate the group.
 *
 * Usage: node fake-descendant.mjs <pidFile> <trap 0|1> <lifetimeMs>
 */

import fs from "node:fs";

const [pidFile, trap, lifetime] = process.argv.slice(2);
fs.writeFileSync(pidFile, String(process.pid));

if (trap === "1") {
 process.on("SIGTERM", () => {
  /* ignore */
 });
}

setTimeout(() => process.exit(0), Number(lifetime) || 60000);
