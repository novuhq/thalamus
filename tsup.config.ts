import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "anthropic/index": "src/anthropic/index.ts",
    "openai/index": "src/openai/index.ts",
    "vault/index": "src/vault/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
});
