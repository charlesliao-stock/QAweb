import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // v1.28 階段 6（A1）：第三方大依賴另拆 vendor chunk，首屏只留殼＋儀表板。
        // 注意：xlsx 不在這裡（階段 5 已改動態 import、自成 chunk），
        // manualChunks 回傳 undefined 即不干預、由 Vite 自行分 chunk。
        manualChunks(id) {
          if (
            id.includes("node_modules/firebase/") ||
            id.includes("node_modules/@firebase/")
          ) {
            return "firebase-vendor";
          }
          if (id.includes("node_modules/lucide-react/")) {
            return "lucide-vendor";
          }
          return undefined;
        },
      },
    },
  },
});
