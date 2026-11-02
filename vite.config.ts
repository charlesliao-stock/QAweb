import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  base: mode === "production" ? "/QAweb/" : "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
}));
