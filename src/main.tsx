import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { isDemoMode } from "./lib/demoMode";
import { loadDemoStore } from "./lib/demoLoader";
import "./styles.css";

async function start(): Promise<void> {
  // 重新整理時仍在展示模式：先載入展示資料層，再 render（db.ts 取用是同步的）
  if (isDemoMode()) await loadDemoStore();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
