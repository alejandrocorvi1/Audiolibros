/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Play, 
  Pause, 
  Menu, 
  X, 
  Download, 
  Trash2, 
  Info, 
  ChevronDown,
  ChevronRight,
  Music,
  Clock,
  ExternalLink
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { get, set, del, keys } from 'idb-keyval';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Configuration
const PGM_URL = "/api/episodes";
const PROXY_URL = "/api/proxy?url=";
const STORAGE_KEYS = {
  LAST_INDEX: 'letitbit_last_index',
  LAST_POS: 'letitbit_last_pos',
  DOWNLOADS: 'letitbit_downloads'
};

interface Episode {
  id: string;
  title: string;
  audioUrl: string;
  imageUrl: string;
  summaryUrl: string;
  isOffline?: boolean;
}

export default function App() {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryText, setSummaryText] = useState("");
  const [episodeImageUrl, setEpisodeImageUrl] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [errorHeader, setErrorHeader] = useState<string | null>(null);
  const [hasRestoredPos, setHasRestoredPos] = useState(false);
  const [loadAttempts, setLoadAttempts] = useState<Record<string, number>>({});

  const [isConfirmingClear, setIsConfirmingClear] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 1. Load Data
  useEffect(() => {
    async function init() {
      try {
        // Load downloaded episodes from IDB
        const storedKeys = await keys();
        const dIds = new Set(
          storedKeys
            .filter(k => typeof k === 'string' && k.startsWith('audio_'))
            .map(k => String(k).replace('audio_', ''))
        );
        console.log("Bibliotecas descargadas detectadas:", Array.from(dIds));
        setDownloadedIds(dIds);

        const response = await fetch(PGM_URL);
        const text = await response.text();
        const lines = text.split(/\r?\n/);
        
        const parsed: Episode[] = lines
          .filter(l => l.trim() && l.includes('|'))
          .map((line, idx) => {
            const [title, audioPath, imagePath, summaryPath] = line.split('|').map(s => s.trim());
            
            const formatUrl = (path: string) => {
              if (!path) return '';
              let url = path.trim();
              
              // Handle relative paths if they happen to be in the list
              if (url.startsWith('/')) {
                return url;
              }

              if (url.includes('drive.google.com')) {
                // Support multiple formats: /open?id=, /file/d/..., /uc?id=
                const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/) || 
                               url.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
                               url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
                if (idMatch) {
                  return `https://drive.google.com/uc?export=download&id=${idMatch[1]}`;
                }
              }
              
              if (url.startsWith('http')) return url;
              
              // Pure IDs (Drive)
              if (!url.includes('.') && !url.includes('/') && url.length >= 20) {
                return `https://drive.google.com/uc?export=download&id=${url}`;
              }
              return url;
            };

            return {
              id: `ep_${idx}`,
              title,
              audioUrl: formatUrl(audioPath),
              imageUrl: formatUrl(imagePath),
              summaryUrl: formatUrl(summaryPath)
            };
          });

        setEpisodes(parsed);
        
        // Restore last state
        const lastIdx = parseInt(localStorage.getItem(STORAGE_KEYS.LAST_INDEX) || '0');
        
        if (parsed.length > 0) {
          const safeIdx = (lastIdx >= 0 && lastIdx < parsed.length) ? lastIdx : 0;
          setCurrentIndex(safeIdx);
        }
      } catch (error) {
        console.error("Failed to load episodes:", error);
        setErrorHeader("Error al cargar la biblioteca");
      } finally {
        setIsLoading(false);
      }
    }
    init();
  }, []);

  // 2. Audio Logic
  useEffect(() => {
    if (currentIndex === -1 || episodes.length === 0) return;

    let active = true;
    const currentEp = episodes[currentIndex];
    setHasRestoredPos(false);
    setErrorHeader(null);
    setDuration(0);
    setProgress(0);
    
    async function loadAssets() {
      try {
        // 1. Audio Cache
        const cachedAudio = await get(`audio_${currentEp.id}`);
        if (!active) return;

        if (cachedAudio) {
          console.log(`Cargando versión offline de: ${currentEp.title}`);
        }
        
        // Cleanup old object URLs before creating new ones
        if (audioRef.current?.src.startsWith("blob:")) {
          URL.revokeObjectURL(audioRef.current.src);
        }
        if (episodeImageUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(episodeImageUrl);
        }

        const audioUrl = cachedAudio 
          ? URL.createObjectURL(cachedAudio) 
          : `${PROXY_URL}${encodeURIComponent(currentEp.audioUrl)}&type=audio`;
        
        if (audioRef.current) {
          audioRef.current.src = audioUrl;
          audioRef.current.load();
        }

        // 2. Image Cache
        const cachedImg = await get(`img_${currentEp.id}`);
        if (!active) return;

        let currentImgUrl: string | null = null;
        if (cachedImg) {
          currentImgUrl = URL.createObjectURL(cachedImg);
          setEpisodeImageUrl(currentImgUrl);
        } else {
          currentImgUrl = currentEp.imageUrl?.includes('drive.google.com') 
            ? `${PROXY_URL}${encodeURIComponent(currentEp.imageUrl)}&type=image` 
            : (currentEp.imageUrl || null);
          setEpisodeImageUrl(currentImgUrl);
        }

        // 3. Summary Cache / Logic
        setSummaryText("");
        fetchSummary(currentEp.id, currentEp.summaryUrl);

        // Update Media Session
        if ('mediaSession' in navigator && currentImgUrl) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: currentEp.title,
            artist: '',
            album: 'Audiolibros',
            artwork: [{ src: currentImgUrl, sizes: '512x512', type: 'image/jpeg' }]
          });
        }
      } catch (e) {
        if (!active) return;
        console.error("Load assets error:", e);
        setErrorHeader("Error al preparar los archivos");
      }
    }
    
    loadAssets();
    setIsPlaying(false);

    return () => {
      active = false;
    };
  }, [currentIndex, episodes]);

  // Handle Play/Pause
  const togglePlay = () => {
    if (!audioRef.current || !audioRef.current.src || audioRef.current.src === window.location.href) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(e => {
        // AbortError is common when source changes or load() is called before play() finishes
        if (e.name === 'AbortError') {
          console.log("Play request was interrupted (standard during source changes)");
          return;
        }
        console.error("Play failed:", e);
        setErrorHeader("El audio no se pudo reproducir");
      });
    }
    setIsPlaying(!isPlaying);
  };

  const handleLoadedMetadata = () => {
    if (!audioRef.current) return;
    setDuration(audioRef.current.duration);
    
    // Restore position if this is the first load of the initial episode
    if (!hasRestoredPos) {
      const lastIdx = parseInt(localStorage.getItem(STORAGE_KEYS.LAST_INDEX) || '0');
      if (currentIndex === lastIdx) {
        const lastPos = parseFloat(localStorage.getItem(STORAGE_KEYS.LAST_POS) || '0');
        if (lastPos < audioRef.current.duration) {
          audioRef.current.currentTime = lastPos;
        }
      }
      setHasRestoredPos(true);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setProgress(audioRef.current.currentTime);
    }
  };

  // Periodic Save (Every 5 seconds instead of 10 for better web UX)
  useEffect(() => {
    const timer = setInterval(() => {
      if (audioRef.current && !audioRef.current.paused) {
        localStorage.setItem(STORAGE_KEYS.LAST_POS, audioRef.current.currentTime.toString());
        localStorage.setItem(STORAGE_KEYS.LAST_INDEX, currentIndex.toString());
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [currentIndex]);

  const fetchSummary = async (epId: string, url: string) => {
    try {
      // Check Cache First
      const cachedTxt = await get(`txt_${epId}`);
      if (cachedTxt && typeof cachedTxt === 'string') {
        setSummaryText(cachedTxt);
        return;
      }

      if (!url) {
        setSummaryText("No hay enlace de descripción.");
        return;
      }
      
      setSummaryText("Cargando descripción...");
      // Always proxy Drive or cross-origin URLs
      const isDrive = url.includes('drive.google.com') || url.includes('docs.google.com');
      const proxyUrl = isDrive 
        ? `${PROXY_URL}${encodeURIComponent(url)}&type=text`
        : url;

      console.log(`Fetching summary from: ${proxyUrl}`);
      const response = await fetch(proxyUrl, {
        headers: {
          'Accept': 'text/plain, text/html, */*'
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 100)}`);
      }
      
      const text = await response.text();
      setSummaryText(text.trim() || "La descripción está vacía.");
    } catch (e) {
      console.error("Summary fetch error:", e);
      setSummaryText(`No se pudo cargar la sinopsis. ${e instanceof Error ? e.message : 'Error de conexión'}`);
    }
  };

  const downloadEpisode = async (ep: Episode) => {
    if (downloadedIds.has(ep.id)) return;
    
    setIsDownloading(true);
    setDownloadProgress(0);
    setErrorHeader(`Iniciando descarga: ${ep.title}...`);
    
    try {
      const fetchWithProxy = (url: string, type: 'audio' | 'image' | 'text') => fetch(`${PROXY_URL}${encodeURIComponent(url)}&type=${type}`);
      
      // Sequential download to avoid overloading proxy/memory
      console.log(`Iniciando descarga de ${ep.title}...`);
      
      setDownloadProgress(20);
      const audioRes = await fetchWithProxy(ep.audioUrl, 'audio');
      if (!audioRes.ok) {
        if (audioRes.status === 403) throw new Error("Acceso denegado (el archivo puede ser privado)");
        throw new Error(`Error del servidor (${audioRes.status}). El archivo puede ser demasiado grande para descargar directamente.`);
      }
      const audioBlob = await audioRes.blob();
      console.log(`Audio descargado (${(audioBlob.size / 1024 / 1024).toFixed(2)} MB)`);
      
      setDownloadProgress(60);
      const imgRes = await fetchWithProxy(ep.imageUrl, 'image');
      const imgBlob = imgRes.ok ? await imgRes.blob() : new Blob();
      
      setDownloadProgress(80);
      const txtRes = await fetchWithProxy(ep.summaryUrl, 'text');
      const txtText = txtRes.ok ? await txtRes.text() : "";

      setDownloadProgress(90);
      await set(`audio_${ep.id}`, audioBlob);
      await set(`img_${ep.id}`, imgBlob);
      await set(`txt_${ep.id}`, txtText);

      console.log(`Guardado en IndexedDB: audio_${ep.id}`);
      setDownloadedIds(prev => new Set([...prev, ep.id]));
      setErrorHeader("Descarga completada correctamente");
      setTimeout(() => setErrorHeader(null), 3000);
    } catch (e) {
      console.error("Download failed details:", e);
      let msg = "Fallo en descarga.";
      if (e instanceof Error) {
        if (e.message.includes("Failed to fetch")) msg = "Error de conexión (el servidor proxy no respondió).";
        else msg = `Error: ${e.message}`;
      }
      setErrorHeader(msg);
    } finally {
      setIsDownloading(false);
      setDownloadProgress(0);
    }
  };

  const clearDownloads = async () => {
    if (!isConfirmingClear) {
      setIsConfirmingClear(true);
      setTimeout(() => setIsConfirmingClear(false), 3000);
      return;
    }
    
    try {
      const allKeys = await keys();
      const appKeys = allKeys.filter(k => 
        String(k).startsWith('audio_') || 
        String(k).startsWith('img_') || 
        String(k).startsWith('txt_')
      );
      
      await Promise.all(appKeys.map(k => del(k)));
      setDownloadedIds(new Set());
      setIsConfirmingClear(false);
      setErrorHeader("Biblioteca vaciada correctamente");
      setTimeout(() => setErrorHeader(null), 3000);
    } catch (e) {
      console.error("Failed to clear downloads", e);
      setErrorHeader("Error al vaciar la biblioteca");
    }
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds)) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const currentEpisode = episodes[currentIndex];

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0F1115]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-xl text-slate-400 animate-pulse font-medium">Iniciando Audiolibros...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#0F1115] flex flex-col font-sans text-[#E5E7EB] overflow-hidden">
      <audio 
        ref={audioRef} 
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => setIsPlaying(false)}
        onCanPlay={() => {
          if (currentEpisode) {
            setLoadAttempts(prev => ({ ...prev, [currentEpisode.id]: 0 }));
          }
        }}
        onError={(e) => {
          const target = e.target as HTMLAudioElement;
          const error = target.error;
          const epId = currentEpisode?.id || 'unknown';
          
          console.error("Audio error details:", {
            code: error?.code,
            message: error?.message,
            src: target.src
          });

          // Increment attempts
          const currentAttempts = (loadAttempts[epId] || 0) + 1;
          setLoadAttempts(prev => ({ ...prev, [epId]: currentAttempts }));

          if (currentAttempts >= 2) {
            setIsPlaying(false);
            setErrorHeader("No se ha podido cargar el audio. El proceso se ha detenido.");
            return;
          }

          // Code 4 is MEDIA_ERR_SRC_NOT_SUPPORTED
          // Often caused by interrupted proxy streams for large files
          if (error?.code === 4 && target.src && !target.src.startsWith('blob:') && target.src !== window.location.href) {
            console.log(`Intento ${currentAttempts} de recuperar audio tras error 4. URL: ${target.src}`);
            setErrorHeader(`Reintentando carga... (${currentAttempts}/2)`);
            
            setTimeout(() => {
              if (!target.src || target.src === window.location.href) return;
              target.load();
              if (isPlaying) {
                target.play().catch(pErr => console.warn("Auto-play recovery failed:", pErr));
              }
            }, 3000);
            return;
          }

          // Avoid error UI for empty/base URL paths (transient states)
          if (target.src === window.location.href || target.src === "" || !target.src) return;

          setErrorHeader(`Error de audio (${error?.code || '?'}): ${error?.message || 'Fallo de red'}`);
        }}
        preload="metadata"
        className="hidden"
      />

      {/* Error Broadcast */}
      <AnimatePresence>
        {errorHeader && (
          <motion.div 
            initial={{ y: -50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -50, opacity: 0 }}
            className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] bg-red-500 text-white px-6 py-3 rounded-full shadow-2xl font-bold flex items-center gap-3"
          >
            <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
            {errorHeader}
            <button onClick={() => setErrorHeader(null)} className="ml-2 hover:bg-white/20 rounded-full p-1"><X className="w-4 h-4" /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation */}
      <nav className="h-16 flex items-center justify-between px-8 border-b border-glass bg-glass flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-accent rounded flex items-center justify-center">
            <Music className="w-5 h-5 text-black" />
          </div>
          <span className="font-bold text-xl tracking-tight uppercase">Audiolibros</span>
        </div>
        
        <div className="hidden md:flex items-center gap-8 text-sm font-medium">
          <span className="text-accent cursor-pointer">Biblioteca</span>
        </div>

        <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-2 hover:bg-white/5 rounded-lg transition-colors">
          <Menu className="w-6 h-6" />
        </button>
      </nav>

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar for Desktop / Mobile */}
        <AnimatePresence>
          {(isSidebarOpen || window.innerWidth >= 768) && (
            <motion.aside 
              initial={window.innerWidth < 768 ? { x: "-100%" } : { x: 0 }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              className={cn(
                "fixed md:relative inset-y-0 left-0 w-80 bg-[#0F1115] md:bg-transparent border-r border-glass z-50 flex flex-col",
                !isSidebarOpen && "hidden md:flex"
              )}
            >
              <div className="p-6 md:hidden flex justify-between items-center border-b border-glass">
                 <span className="font-bold uppercase tracking-widest text-xs text-gray-500">Menú</span>
                 <button onClick={() => setIsSidebarOpen(false)}><X className="w-5 h-5" /></button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                <h3 className="text-[10px] uppercase tracking-[0.2em] text-gray-500 font-black mb-4 px-2">Mis Descargas</h3>
                {downloadedIds.size === 0 ? (
                  <div className="p-6 bg-glass rounded-xl border border-glass text-center">
                    <p className="text-xs text-gray-500">No hay episodios descargados</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {episodes.filter(e => downloadedIds.has(e.id)).map((ep) => (
                      <div
                        key={ep.id}
                        onClick={() => {
                          const idx = episodes.findIndex(item => item.id === ep.id);
                          setCurrentIndex(idx);
                          setIsSidebarOpen(false);
                        }}
                        className={cn(
                          "w-full text-left p-3 rounded-lg flex items-center justify-between transition-all cursor-pointer group",
                          currentIndex === episodes.findIndex(item => item.id === ep.id) 
                            ? "bg-accent/10 border-l-4 border-accent" 
                            : "bg-glass border border-glass hover:bg-white/5"
                        )}
                      >
                        <div className="flex items-center gap-3 overflow-hidden">
                          <Music className={cn("w-4 h-4 flex-shrink-0", currentIndex === episodes.findIndex(item => item.id === ep.id) ? "text-accent" : "text-gray-500")} />
                          <span className="text-sm font-medium truncate">{ep.title}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-8 space-y-3">
                  <h3 className="text-[10px] uppercase tracking-[0.2em] text-gray-500 font-black mb-4 px-2">Acciones</h3>
                  
                  <div className="space-y-2">
                    <button 
                      disabled={isDownloading || (currentEpisode && downloadedIds.has(currentEpisode.id))}
                      onClick={() => currentEpisode && downloadEpisode(currentEpisode)}
                      className="w-full flex items-center gap-3 p-3 rounded-xl bg-accent text-black hover:bg-accent/90 transition-all disabled:bg-gray-800 disabled:text-gray-500 font-bold text-xs uppercase"
                    >
                      {isDownloading ? <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" /> : <Download className="w-4 h-4" />}
                      {isDownloading ? "Descargando..." : downloadedIds.has(currentEpisode?.id || '') ? "Disponible Offline" : "Descargar para Offline"}
                    </button>
                    
                    {isDownloading && (
                      <div className="px-2">
                        <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${downloadProgress}%` }}
                            className="h-full bg-accent"
                          />
                        </div>
                        <p className="text-[9px] text-gray-500 mt-1 text-center font-bold uppercase tracking-wider">No cierres la App</p>
                      </div>
                    )}
                  </div>

                  <button 
                    onClick={clearDownloads}
                    className={cn(
                      "w-full flex items-center gap-3 p-3 rounded-xl border transition-all font-bold text-xs uppercase",
                      isConfirmingClear 
                        ? "bg-red-500/20 border-red-500 text-red-500" 
                        : "border-glass text-gray-400 hover:text-red-400 hover:border-red-400/30"
                    )}
                  >
                    <Trash2 className="w-4 h-4" />
                    {isConfirmingClear ? "¿Estás seguro? (Click de nuevo)" : "Vaciar biblioteca"}
                  </button>


                </div>
              </div>

           <div className="p-6 border-t border-glass text-center">
  <p className="text-[10px] font-bold italic text-gray-600 tracking-widest">
    By Ale Corvi © 2026 
  </p>
</div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Content Area */}
        <main className="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar">
          <div className="max-w-5xl mx-auto flex flex-col gap-8">
            
            {/* Header / Selector */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
              <div className="flex gap-6 items-end">
                <div className="w-32 h-32 md:w-48 md:h-48 flex-shrink-0 shadow-2xl relative group">
                  <img 
                    src={episodeImageUrl || undefined} 
                    className="w-full h-full object-cover rounded-xl border border-glass" 
                    referrerPolicy="no-referrer"
                    crossOrigin="anonymous"
                    onLoad={() => console.log("Image loaded successfully:", currentEpisode?.title)}
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      console.error("Image load error for episode:", currentEpisode?.title, "URL:", target.src);
                      target.src = "https://images.unsplash.com/photo-1589903308914-1293a6329ed2?auto=format&fit=crop&q=80&w=400"; // Generic audio book cover
                    }}
                  />
                  <div className="absolute inset-0 bg-black/20 rounded-xl" />
                </div>
                <div className="flex flex-col justify-end pb-2">
                  <h1 className="text-2xl md:text-4xl font-bold mb-2">{currentEpisode?.title}</h1>
                  <p className="text-gray-400 mb-4">Audiolibros</p>
                  <div className="flex flex-wrap gap-2">
                    <span className="bg-glass border border-glass px-3 py-1 rounded-full text-[10px] uppercase tracking-widest text-gray-400">Audio Digital</span>
                    <span className="bg-glass border border-glass px-3 py-1 rounded-full text-[10px] uppercase tracking-widest text-gray-400">Sincronizado</span>
                  </div>
                </div>
              </div>

              <div className="w-full md:w-64">
                <label className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500 mb-2 block">Capítulos</label>
                <div className="relative">
                  <select 
                    value={currentIndex}
                    onChange={(e) => setCurrentIndex(parseInt(e.target.value))}
                    className="w-full bg-glass border border-glass rounded-lg p-3 pr-10 text-sm font-medium appearance-none cursor-pointer focus:outline-none focus:border-accent/50 transition-colors"
                  >
                    {episodes.map((ep, idx) => (
                      <option key={ep.id} value={idx} className="bg-[#1a1c22]">{ep.title}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                </div>
              </div>
            </div>

            {/* Description / Summary Box */}
            <div className="bg-glass rounded-2xl p-6 md:p-8 border border-glass flex flex-col max-h-[500px]">
              <div className="flex justify-between items-center mb-6 flex-shrink-0">
                <h3 className="text-xs uppercase tracking-[0.2em] text-gray-500 font-bold">Descripción / Sinopsis</h3>
                <div className="flex items-center gap-2 text-[10px] text-accent">
                  <span className="w-2 h-2 rounded-full bg-accent animate-pulse"></span>
                  SESIÓN ACTIVA
                </div>
              </div>
              <div className="overflow-y-auto pr-2 custom-scrollbar">
                <p className="text-gray-400 leading-relaxed text-sm md:text-base whitespace-pre-wrap">
                  {summaryText || "Cargando información del episodio..."}
                </p>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Modern Player Footer */}
      <footer className="h-28 bg-black/40 backdrop-blur-xl border-t border-glass px-6 md:px-12 flex flex-col justify-center gap-2 flex-shrink-0">
        {/* Progress Slider */}
        <div className="w-full group">
          <div className="relative h-1 bg-gray-800 rounded-full overflow-hidden">
            <div 
              className="absolute top-0 left-0 h-full bg-accent transition-all duration-300 accent-glow"
              style={{ width: `${(progress / (duration || 1)) * 100}%` }}
            />
            <input 
              type="range" 
              min="0" 
              max={duration || 0} 
              step="0.1"
              value={progress}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (audioRef.current) audioRef.current.currentTime = val;
                setProgress(val);
              }}
              className="absolute inset-0 w-full opacity-0 cursor-pointer z-10"
            />
          </div>
        </div>

        <div className="flex items-center justify-between">
          {/* Time & Info */}
          <div className="w-1/3 flex items-center gap-4">
            <span className="text-[10px] font-mono opacity-50 tabular-nums">{formatTime(progress)}</span>
            <div className="hidden md:flex gap-4 opacity-50">
              <Clock className="w-4 h-4" />
              <Info className="w-4 h-4 cursor-pointer hover:text-white transition-colors" onClick={() => setShowSummary(true)} />
            </div>
            <span className="text-[10px] font-mono opacity-50 tabular-nums">{duration ? formatTime(duration) : "--:--"}</span>
          </div>

          {/* Controls */}
          <div className="w-1/3 flex justify-center items-center gap-6 md:gap-10">
            <button className="text-gray-500 hover:text-white transition-colors">
              <ChevronDown className="w-6 h-6 rotate-90" />
            </button>
            
            <button 
              onClick={togglePlay}
              disabled={duration === 0}
              className="w-12 h-12 md:w-14 md:h-14 bg-white text-black rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-all shadow-xl disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
            >
              {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current translate-x-0.5" />}
            </button>

            <button className="text-gray-500 hover:text-white transition-colors">
              <ChevronDown className="w-6 h-6 -rotate-90" />
            </button>
          </div>

          {/* Extra / Volume */}
          <div className="w-1/3 flex justify-end items-center gap-4">
            <div className="hidden md:flex items-center gap-2 bg-glass px-3 py-1.5 rounded border border-glass text-[10px] font-mono">
              <span className="opacity-50 uppercase tracking-widest">Estado</span>
              <span className="text-accent">{isPlaying ? "Play" : "Stop"}</span>
            </div>
            <ExternalLink className="w-4 h-4 opacity-40 hover:opacity-100 transition-opacity cursor-pointer" />
          </div>
        </div>
      </footer>

      {/* Mobile Drawer (Summary) */}
      <AnimatePresence>
        {showSummary && (
          <div className="fixed inset-0 z-[100] flex items-end justify-center">
            <motion.div 
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               exit={{ opacity: 0 }}
               onClick={() => setShowSummary(false)}
               className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="relative w-full max-w-2xl bg-[#14161a] rounded-t-[2.5rem] p-8 border-t border-glass shadow-2xl flex flex-col max-h-[85vh]"
            >
              <div className="flex justify-center mb-6">
                <div className="w-12 h-1 bg-gray-700 rounded-full" />
              </div>
              <div className="flex justify-between items-start mb-8">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-accent block mb-2">Información Extendida</label>
                  <h3 className="text-2xl font-bold">{currentEpisode?.title}</h3>
                </div>
                <button onClick={() => setShowSummary(false)} className="p-2 bg-white/5 rounded-full"><X className="w-5 h-5" /></button>
              </div>
              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                <p className="text-gray-400 leading-relaxed text-base whitespace-pre-wrap">
                  {summaryText || "Cargando sinopsis..."}
                </p>
                <div className="h-10" />
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
      `}</style>
    </div>
  );
}
