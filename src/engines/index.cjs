const { LimaEngine } = require("./lima.cjs");
const { SmolvmEngine } = require("./smolvm.cjs");

function createRegistry(options) {
  const engines = [new LimaEngine(options), new SmolvmEngine(options)];
  const registry = new Map(engines.map((engine) => [engine.id, engine]));
  return {
    get(id) {
      if (typeof id !== "string" || !registry.has(id))
        throw new Error("Ambiente sconosciuto.");
      return registry.get(id);
    },
    async list() {
      return Promise.all(
        engines.map(async (engine) => ({
          id: engine.id,
          engine: engine.kind,
          name: engine.name,
          capabilities: engine.capabilities,
          ...(await engine.inspect()),
        })),
      );
    },
  };
}
module.exports = { createRegistry };
