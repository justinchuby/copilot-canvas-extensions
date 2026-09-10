import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entries = await readdir(root, { withFileTypes: true });
const extensions = [];

for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "scripts") continue;
    const directory = join(root, entry.name);
    const files = await readdir(directory);
    if (!files.includes("extension.mjs")) continue;

    if (!files.includes("copilot-extension.json")) {
        throw new Error(`${entry.name}: missing copilot-extension.json`);
    }
    const manifest = JSON.parse(await readFile(join(directory, "copilot-extension.json"), "utf8"));
    if (manifest.name !== entry.name || manifest.version !== 1) {
        throw new Error(`${entry.name}: manifest must contain matching name and version 1`);
    }

    const check = spawnSync(process.execPath, ["--check", join(directory, "extension.mjs")], {
        encoding: "utf8",
    });
    if (check.status !== 0) {
        throw new Error(`${entry.name}: syntax check failed\n${check.stderr}`);
    }
    extensions.push(entry.name);
}

if (!extensions.length) throw new Error("No extensions found.");
process.stdout.write(`Validated ${extensions.length} extension(s): ${extensions.join(", ")}\n`);
