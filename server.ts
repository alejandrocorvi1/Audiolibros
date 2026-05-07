import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream"; // Importación directa para evitar problemas de empaquetado

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  // Railway asigna automáticamente un puerto, usamos process.env.PORT
  const PORT = process.env.PORT || 3000;

  // --- RUTAS DE API (Se mantienen igual) ---

  app.get("/api/episodes", async (req, res) => {
    try {
      let pgmUrl = process.env.VITE_PGM_URL || "https://drive.google.com/uc?export=download&id=1Q_IoP1G8zGxh1dLuzxpZK2tyAz66GTrL";
      
      if (!pgmUrl.startsWith("http") && /^[a-zA-Z0-9_-]+$/.test(pgmUrl)) {
        pgmUrl = `https://drive.google.com/uc?export=download&id=${pgmUrl}`;
      }

      let { response, needsRedirect, confirmToken, htmlBody } = await fetchWithDriveBypass(pgmUrl, {});
      
      if (needsRedirect && confirmToken) {
        ({ response, htmlBody } = await fetchWithDriveBypass(pgmUrl, {}, confirmToken));
      }
      
      if (htmlBody || !response.ok) {
        return res.status(response.status).send(htmlBody || "Error loading episode list");
      }
      
      const text = await response.text();
      res.header("Content-Type", "text/plain");
      res.send(text);
    } catch (error: any) {
      console.error("Episodes Proxy error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  const fetchWithDriveBypass = async (targetUrl: string, initialHeaders: Record<string, string>, confirmToken?: string) => {
    const urlObj = new URL(targetUrl);
    if (confirmToken) {
      urlObj.searchParams.set('confirm', confirmToken);
    } else if (urlObj.hostname.includes('drive.google.com') && !urlObj.searchParams.has('confirm')) {
      urlObj.searchParams.set('confirm', 't');
    }

    let response = await fetch(urlObj.toString(), { headers: initialHeaders, redirect: 'follow' });
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    
    if (contentType.includes('text/html')) {
      const text = await response.text();
      const foundToken = text.match(/confirm=([a-zA-Z0-9_]+)/i)?.[1] || 
                         text.match(/name="confirm" value="([a-zA-Z0-9_]+)"/i)?.[1];
      
      if (foundToken) {
        return { response, wasBypassed: false, needsRedirect: true, confirmToken: foundToken };
      }
      return { response, wasBypassed: false, htmlBody: text };
    }
    return { response, wasBypassed: false };
  };

  app.get("/api/proxy", async (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    const targetUrl = req.query.url as string;
    const typeHint = req.query.type as string;
    const queryConfirm = req.query.confirm as string;

    if (!targetUrl) return res.status(400).send("No URL provided");
    
    try {
      const initialHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };
      if (req.headers.range) {
        initialHeaders['Range'] = req.headers.range as string;
      }

      const { response, needsRedirect, confirmToken, htmlBody } = await fetchWithDriveBypass(targetUrl, initialHeaders, queryConfirm);

      if (needsRedirect && confirmToken) {
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const redirUrl = new URL(req.originalUrl || req.url, `${proto}://${req.headers.host}`);
        redirUrl.searchParams.set('confirm', confirmToken);
        return res.redirect(redirUrl.toString());
      }

      if (htmlBody) {
        if (typeHint === 'audio' || typeHint === 'image') {
          return res.status(403).send("El archivo no pudo ser cargado.");
        }
        res.header('Content-Type', 'text/plain; charset=utf-8');
        return res.status(response.status).send(htmlBody);
      }

      if (!response.ok && response.status !== 206) {
        const errText = await response.text().catch(() => "Unknown error");
        return res.status(response.status).send(errText);
      }

      const headersToForward = ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control', 'content-disposition', 'last-modified', 'etag'];
      headersToForward.forEach(h => {
        const val = response.headers.get(h);
        if (val) res.header(h, val);
      });

      let finalCT = (res.getHeader('content-type') as string || '').toLowerCase();
      if (!finalCT || finalCT.includes('octet-stream')) {
        if (typeHint === 'audio') finalCT = 'audio/mpeg';
        else if (typeHint === 'image') finalCT = 'image/jpeg';
        res.header('Content-Type', finalCT);
      }

      res.status(response.status === 206 ? 206 : response.status);

      if (!response.body) return res.status(404).send("No content body");

      const stream = Readable.fromWeb(response.body as any);
      stream.on('error', () => res.end());
      stream.pipe(res);
      
    } catch (error: any) {
      if (!res.headersSent) res.status(500).send(`Error: ${error.message}`);
    }
  });

  // --- MANEJO DE VITE Y ESTÁTICOS (Cambio clave aquí) ---

  if (process.env.NODE_ENV !== "production") {
    // Importación dinámica para que no rompa el build de producción
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // En producción (Railway), servimos la carpeta dist
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    
    // Cualquier ruta que no sea de API, devuelve el index.html
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();