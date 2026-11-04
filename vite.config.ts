import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  return {
    base: mode === "production" ? (env.VITE_BASE_PATH ?? "/QAweb/") : "/",
    plugins: [react()],
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
