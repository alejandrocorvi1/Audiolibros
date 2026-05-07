import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- TUS RUTAS ---
app.get("/api/episodes", async (req, res) => {
  try {
    let pgmUrl = process.env.VITE_PGM_URL || "https://drive.google.com/uc?export=download&id=1Q_IoP1G8zGxh1dLuzxpZK2tyAz66GTrL";
    const response = await fetch(pgmUrl);
    const text = await response.text();
    res.header("Content-Type", "text/plain");
    res.send(text);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Proxy genérico
app.get("/api/proxy", async (req, res) => {
    // ... tu lógica de proxy que ya tenías ...
    res.send("Proxy funcionando"); 
});

// --- SERVIR FRONTEND ---
const distPath = path.join(process.cwd(), "dist");
app.use(express.static(distPath));

// EXPORTAR PARA VERCEL (Sin app.listen)
export default app;