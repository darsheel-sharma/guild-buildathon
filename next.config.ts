import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * PGlite ships a WASM build and loads its own assets at runtime. Bundling it
   * rewrites those paths and it fails with a URL/string mismatch, so it stays
   * external on the server. `pg` is native and never belongs in a bundle.
   */
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "pg"],

  /**
   * Pin the workspace root. Without it Turbopack walks up looking for a lockfile
   * and can land on the home directory when the project sits under it.
   */
  turbopack: { root: path.resolve(process.cwd()) },
};

export default nextConfig;
