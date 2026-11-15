import { importSnapshot } from './data.mjs';

self.onmessage = async ({ data: files }) => {
  let lastPhase;
  let lastUpdate = 0;
  try {
    const snapshot = await importSnapshot(files, progress => {
      const now = Date.now();
      if (progress.phase !== lastPhase || now - lastUpdate >= 150 || progress.loaded === progress.total) {
        self.postMessage({ type: 'progress', ...progress });
        lastPhase = progress.phase;
        lastUpdate = now;
      }
    });
    self.postMessage({ type: 'ready', snapshot });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
