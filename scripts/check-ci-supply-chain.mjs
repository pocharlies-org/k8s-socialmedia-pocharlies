import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = path.join(root, ".github", "workflows");
const workflowFiles = fs.readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();
const mutable = [];
for (const name of workflowFiles) {
  const source = fs.readFileSync(path.join(workflowsDir, name), "utf8");
  for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gmu)) {
    const target = match[1];
    if (!target.startsWith("./") && !/^[^@\s]+@[0-9a-f]{40}$/.test(target)) {
      mutable.push(`${name}: ${target}`);
    }
  }
}
if (mutable.length) {
  throw new Error(`Mutable workflow dependencies:\n${mutable.join("\n")}`);
}

const ci = fs.readFileSync(path.join(workflowsDir, "ci.yml"), "utf8");
const minioVersion = "RELEASE.2025-09-07T16-13-09Z";
const minioSha256 = "7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f";
if (
  !ci.includes(
    `https://github.com/minio/minio/releases/download/${minioVersion}/minio.linux-amd64.${minioVersion}`,
  ) ||
  !ci.includes(minioSha256) ||
  !ci.includes("sha256sum --check --strict")
) {
  throw new Error("MinIO CI binary must be versioned and checksum verified");
}

console.log("CI supply-chain contract passed");
