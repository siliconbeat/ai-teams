import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = process.env.AI_TEAMS_SERVER_PORT || "3789";
const serverTarget = process.env.AI_TEAMS_SERVER_HTTP_URL || `http://localhost:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/ws": { target: serverTarget, ws: true },
    },
  },
});
