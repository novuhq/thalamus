import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const hook = path.join(root, "__tests__/build/block-openai.cjs");
const cjsEntry = path.join(root, "dist/index.cjs");
const esmEntry = path.join(root, "dist/index.js");

function run(label, args) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    cwd: root,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`${label} failed (status ${result.status})`);
  }
  process.stdout.write(output);
}

function assertSend(kind) {
  return `
    const message = err && err.message ? err.message : "";
    if (!err || err.name !== "ThalamusError" || err.isRetryable !== false || !message.includes("openai >= 6.45.0")) {
      console.error(${JSON.stringify(kind)} + " bad error", err);
      process.exit(1);
    }
    console.log(${JSON.stringify(kind)} + " ok " + message);
  `;
}

const cjsProgram = `
const pkg = require(${JSON.stringify(cjsEntry)});
if (typeof pkg.thalamus.anthropic !== "function") throw new Error("anthropic missing");
if (typeof pkg.thalamus.openai !== "function") throw new Error("openai factory missing");
const provider = pkg.thalamus.openai({ apiKey: "sk-test" });
if (typeof provider.send !== "function") throw new Error("send missing");
provider.send({ messages: [{ role: "user", content: "hi" }] }).then(
  () => {
    console.error("cjs send resolved");
    process.exit(1);
  },
  (err) => { ${assertSend("cjs")} },
);
`;

const esmProgram = `
const pkg = await import(${JSON.stringify(esmEntry)});
if (typeof pkg.thalamus.anthropic !== "function") throw new Error("anthropic missing");
if (typeof pkg.thalamus.openai !== "function") throw new Error("openai factory missing");
const provider = pkg.thalamus.openai({ apiKey: "sk-test" });
if (typeof provider.send !== "function") throw new Error("send missing");
try {
  await provider.send({ messages: [{ role: "user", content: "hi" }] });
  console.error("esm send resolved");
  process.exit(1);
} catch (err) {
  ${assertSend("esm")}
}
`;

run("cjs", ["-r", hook, "-e", cjsProgram]);
run("esm", ["-r", hook, "--input-type=module", "-e", esmProgram]);
