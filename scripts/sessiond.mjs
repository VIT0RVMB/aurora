// Builds aurora-sessiond and places it where Tauri's `externalBin` expects it:
// crates/app/binaries/aurora-sessiond-<target-triple>[.exe].
// Usage: node scripts/sessiond.mjs [--debug]
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const debug = process.argv.includes("--debug");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] }).toString();

const triple = /host: (\S+)/.exec(run("rustc", ["-vV"]))[1];
const exe = process.platform === "win32" ? ".exe" : "";
execFileSync("cargo", ["build", "-p", "aurora-sessiond", ...(debug ? [] : ["--release"])], { cwd: root, stdio: "inherit" });

const from = join(root, "target", debug ? "debug" : "release", `aurora-sessiond${exe}`);
const to = join(root, "crates", "app", "binaries", `aurora-sessiond-${triple}${exe}`);
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`sessiond -> ${to}`);
