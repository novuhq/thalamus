import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "anthropic/index": "src/anthropic/index.ts",
    "anthropic/parser": "src/anthropic/parser.ts",
    "openai/index": "src/openai/index.ts",
    "openai/parser": "src/openai/parser.ts",
    "vault/index": "src/vault/index.ts",
    "durable/index": "src/durable/index.ts",
    "webhook/index": "src/webhook/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
});
