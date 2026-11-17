const Module = require("node:module");
const { registerHooks } = Module;

const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "openai" || request.startsWith("openai/")) {
    const err = new Error(`blocked resolve: ${request}`);
    err.code = "MODULE_NOT_FOUND";
    throw err;
  }

  return orig.call(this, request, parent, isMain, options);
};

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
