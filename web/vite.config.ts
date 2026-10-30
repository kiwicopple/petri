import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../supabase/functions/_shared", import.meta.url)),
    },
  },
  server: { fs: { allow: [".."] } },
});
