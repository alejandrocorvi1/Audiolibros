// Importamos el archivo que esbuild genera en el build
const app = require('../dist/server.cjs');

module.exports = (req, res) => {
  // Manejamos la petición con nuestra app de Express
  return app(req, res);
};