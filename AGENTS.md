# Project Evolution & Context

## Rescue Points (Puntos de Rescate)

- **2026-05-06 22:36 (Initial Rescue Point):** 
  - Full-stack layout (Express proxy + React frontend).
  - Offline mode implemented: Episodes, audio, images, and descriptions are cached in IndexedDB.
  - Google Drive proxy handles virus scan warnings and large files.
  - UI is polished with glassmorphism, responsive drawer, and metadata synchronization.
  - Error handling for downloads and missing assets is robust.

- **2026-05-07 09:05 (RESCATE2):**
  - Robust audio loading: Stops and alerts user after 2 consecutive failed attempts.
  - Playback safety: Play button disabled until metadata (duration) is fully loaded.
  - State reset: Previous progress and duration are cleared instantly when changing episodes to avoid "ghost" metadata.
  - Sidebar and header navigation links restored for library/catalog exploration.
