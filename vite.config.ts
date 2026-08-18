import { defineConfig } from "vite";

export default defineConfig({
  // The desktop worktree may reuse a linked pnpm dependency tree. Resolve the
  // viewer and harness through the worktree's React instance so hooks never
  // cross two React runtimes.
  resolve: {
    dedupe: ["react", "react-dom"],
  },
});
