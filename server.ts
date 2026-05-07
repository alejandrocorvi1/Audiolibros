import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Basic proxy to bypass CORS for the episode list
  app.get("/api/episodes", async (req, res) => {
    try {
      let pgmUrl = process.env.VITE_PGM_URL || "https://drive.google.com/uc?export=download&id=1Q_IoP1G8zGxh1dLuzxpZK2tyAz66GTrL";
      
      if (!pgmUrl.startsWith("http") && /^[a-zA-Z0-9_-]+$/.test(pgmUrl)) {
        pgmUrl = `https://drive.google.com/uc?export=download&id=${pgmUrl}`;
      }

      let { response, needsRedirect, confirmToken, htmlBody } = await fetchWithDriveBypass(pgmUrl, {});
      
      // If needs redirect, handle it internally for the JSON/text fetch
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

  // Helper to fetch from Google Drive with bypass logic
  const fetchWithDriveBypass = async (targetUrl: string, initialHeaders: Record<string, string>, confirmToken?: string) => {
    const urlObj = new URL(targetUrl);
    if (confirmToken) {
      urlObj.searchParams.set('confirm', confirmToken);
    } else if (urlObj.hostname.includes('drive.google.com') && !urlObj.searchParams.has('confirm')) {
      // Add a default confirm=t for small/medium files, often skips the warning
      urlObj.searchParams.set('confirm', 't');
    }

    // Initial fetch
    let response = await fetch(urlObj.toString(), { headers: initialHeaders, redirect: 'follow' });
    
    // Google Drive virus scan bypass detection
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    
    // If it's HTML, it might be the Drive warning page
    if (contentType.includes('text/html')) {
      const text = await response.text();
      // Look for the "confirm=" token in links or hidden inputs
      const foundToken = text.match(/confirm=([a-zA-Z0-9_]+)/i)?.[1] || 
                         text.match(/name="confirm" value="([a-zA-Z0-9_]+)"/i)?.[1];
      
      if (foundToken) {
        return { response, wasBypassed: false, needsRedirect: true, confirmToken: foundToken };
      }
      // If it's HTML but not the warning, the body IS consumed here.
      return { response, wasBypassed: false, htmlBody: text };
    }
    // Not HTML, response body is UNTOUCHED.
    return { response, wasBypassed: false };
  };

  // Generic proxy for any content (text, audio, images)
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
        console.log(`Bypass token found: ${confirmToken}. Redirecting client for persistence.`);
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const redirUrl = new URL(req.originalUrl || req.url, `${proto}://${req.headers.host}`);
        redirUrl.searchParams.set('confirm', confirmToken);
        return res.redirect(redirUrl.toString());
      }

      // If we have htmlBody, it means the original body was consumed to check for bypass.
      if (htmlBody) {
        if (typeHint === 'audio' || typeHint === 'image') {
          console.error(`Proxy error: Received HTML instead of ${typeHint} for ${targetUrl}. Preview: ${htmlBody.substring(0, 200)}`);
          return res.status(403).send("El archivo no pudo ser cargado (posible límite de descarga o acceso privado).");
        }
        res.header('Content-Type', 'text/plain; charset=utf-8');
        return res.status(response.status).send(htmlBody);
      }

      if (!response.ok && response.status !== 206) {
        // Here response.body is untouched because it wasn't HTML
        const errText = await response.text().catch(() => "Unknown error");
        console.error(`Source error ${response.status}: ${targetUrl}. Body: ${errText.substring(0, 100)}`);
        return res.status(response.status).send(errText);
      }

      // Forward essential response headers
      const headersToForward = [
        'content-type',
        'content-length',
        'accept-ranges',
        'content-range',
        'cache-control',
        'content-disposition',
        'last-modified',
        'etag'
      ];

      headersToForward.forEach(h => {
        const val = response.headers.get(h);
        if (val) res.header(h, val);
      });

      // Refine MIME type detection ONLY if it's generic or missing
      let finalCT = (res.getHeader('content-type') as string || '').toLowerCase();
      if (!finalCT || finalCT.includes('octet-stream')) {
        if (typeHint === 'audio') finalCT = 'audio/mpeg';
        else if (typeHint === 'image') finalCT = 'image/jpeg';
        else if (typeHint === 'text') finalCT = 'text/plain; charset=utf-8';
        res.header('Content-Type', finalCT);
      }

      // Signal support for byte ranges if not already signaled
      if (!res.getHeader('accept-ranges') && typeHint === 'audio') {
        res.header('Accept-Ranges', 'bytes');
      }

      // Large files on Cloud Run/Proxy: 
      // Ensure we don't hold the whole response in memory if possible
      res.status(response.status === 206 ? 206 : response.status);

      if (!response.body) {
        return res.status(404).send("No content body received from source.");
      }

      const { Readable } = await import("stream");
      const stream = Readable.fromWeb(response.body as any);

      stream.on('error', (err) => {
        console.error('Proxy stream distribution error:', err);
        // If we already started sending bits, we can't change status, 
        // but we should close the connection so the browser knows it's cut.
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.end();
        }
      });

      // Use pipe but handle backpressure if possible
      stream.pipe(res);
      
    } catch (error: any) {
      console.error("Critical Proxy error:", error);
      if (!res.headersSent) {
        res.header("Access-Control-Allow-Origin", "*");
        res.status(500).send(`Error de red en el servidor: ${error.message}`);
      }
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
