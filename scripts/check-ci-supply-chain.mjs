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
const release = fs.readFileSync(path.join(workflowsDir, "release.yml"), "utf8");
const auxiliaryRelease = fs.readFileSync(
  path.join(workflowsDir, "release-auxiliary.yml"),
  "utf8",
);
const instagramBridge = fs.readFileSync(
  path.join(root, "k8s", "base", "instagram-synapse-bridge.yaml"),
  "utf8",
);
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

if (!release.includes("image_promotions: ${{ needs.release.outputs.release_images }}")) {
  throw new Error("Production manifest promotion must consume the exact release image output");
}
if (!release.includes("source_path: k8s\n")) {
  throw new Error("Manifest artifact source must contain the prod overlay and its relative base");
}
const releaseImagesBlock = release.match(/\n\s{6}images: \|\n([\s\S]*?)\n\s{4}secrets:/)?.[1];
const releaseTargetsBlock = release.match(/\n\s{6}image_targets: \|\n([\s\S]*?)\n\s{4}secrets:/)?.[1];
if (!releaseImagesBlock || !releaseTargetsBlock) {
  throw new Error("Production release must declare images and exact manifest targets");
}
const imageNames = [...releaseImagesBlock.matchAll(/"name":"([^"]+)"/g)].map((match) => match[1]).sort();
const targetNames = [...releaseTargetsBlock.matchAll(/"name":"([^"]+)"/g)].map((match) => match[1]).sort();
if (imageNames.length === 0 || JSON.stringify(imageNames) !== JSON.stringify(targetNames)) {
  throw new Error("Every released production image must have exactly one manifest target");
}
for (const auxiliaryName of [
  "whatsappmcp-whatsapp-cloud-connector",
  "whatsappmcp-whatsapp-open-worker",
]) {
  if (release.includes(`"name":"${auxiliaryName}"`) ||
      !auxiliaryRelease.includes(`"name":"${auxiliaryName}"`)) {
    throw new Error(`Auxiliary signed release image is missing: ${auxiliaryName}`);
  }
}
for (const name of targetNames) {
  const repository = `harbor.e-dani.com/homelab/${name}`;
  if (!releaseTargetsBlock.includes(`"matchName":"${repository}"`) ||
      !releaseTargetsBlock.includes(`"deployRepository":"${repository}"`)) {
    throw new Error(`Manifest target is not exact for ${name}`);
  }
}
if (instagramBridge.includes("envFrom:") ||
    !instagramBridge.includes("key: INSTAGRAM_WEBHOOK_SECRET")) {
  throw new Error("Instagram bridge must project only its webhook HMAC secret");
}

console.log("CI supply-chain contract passed");
