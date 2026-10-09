import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api is proxied to the API; in compose, nginx does the same.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: process.env.API_URL ?? "http://localhost:3000", rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
