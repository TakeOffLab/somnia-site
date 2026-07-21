import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PUBLISH_TOKEN: "test-publish-token",
          LIVE_TTL_MS: "2000",
        },
      },
    }),
  ],
});
