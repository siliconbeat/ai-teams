const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const pkg = process.argv[2];
if (!pkg) {
  console.error("Usage: node scripts/build-bundle.js <server|agent>");
  process.exit(1);
}

const appDir = path.join(__dirname, "..", "apps", pkg);
const sharedDist = path.join(__dirname, "..", "packages", "shared", "dist");

if (!fs.existsSync(sharedDist)) {
  console.error("Error: @ai-teams/shared not built. Run `pnpm --filter @ai-teams/shared build` first.");
  process.exit(1);
}

const distDir = path.join(appDir, "dist");
const indexFile = path.join(distDir, "index.js");
if (fs.existsSync(indexFile)) {
  fs.rmSync(indexFile);
}

const external = pkg === "server"
  ? ["fastify", "@fastify/swagger", "@fastify/swagger-ui", "@fastify/websocket", "@fastify/static", "ws", "pg"]
  : ["ws"];

esbuild
  .build({
    entryPoints: [path.join(appDir, "src", "index.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outdir: path.join(appDir, "dist"),
    banner: { js: "#!/usr/bin/env node" },
    external,
    alias: {
      "@ai-teams/shared": sharedDist,
    },
    logLevel: "info",
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
