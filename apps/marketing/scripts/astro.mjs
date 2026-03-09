import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const astroPackageJsonPath = require.resolve("astro/package.json");
const astroBin = path.join(path.dirname(astroPackageJsonPath), "astro.js");
const args = process.argv.slice(2);

const child = spawn(process.execPath, [astroBin, ...args], {
  stdio: "inherit",
  env: {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: "1",
  },
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
