const { registerHooks } = require("node:module");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "openai" || specifier.startsWith("openai/")) {
      const err = new Error(`blocked resolve: ${specifier}`);
      err.code = "ERR_MODULE_NOT_FOUND";
      throw err;
    }

    return nextResolve(specifier, context);
  },
});
