import { setupUI } from "./ui.js";
import { db } from './db.js';
import { compressData, decompressData, encryptData, decryptData } from './compress.js';


document.addEventListener("DOMContentLoaded", () => { setupUI(); });

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/js/sw.js');
      console.log('Service Worker registered.', reg);

      if ('sync' in reg) {
        window.addEventListener('online', async () => {
          try {
            await reg.sync.register('sync-cache');
            console.log('Background sync registered.');
          } catch (err) {
            console.error('Sync registration failed', err);
          }
        });
      }
    } catch (error) {
      console.error('Service Worker registration failed:', error);
    }
  }
}

async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission !== 'granted') {
    try {
      await Notification.requestPermission();
      if (Notification.permission === 'granted') {
        new Notification('Notifications enabled for Smart Calculator!');
      }
    } catch (err) {
      console.error('Notification permission failed:', err);
    }
  }
}

async function checkCacheHealth() {
  const cacheTimestamp = await db.get('metadata', 'cacheTimestamp');
  const now = Date.now();

  if (!cacheTimestamp) return;

  const diffDays = (now - cacheTimestamp) / (1000 * 60 * 60 * 24);

  if (diffDays > 20 && navigator.onLine) {
    new Notification('Please refresh calculator to update latest features!');
  } else if (diffDays > 10 && navigator.onLine) {
    navigator.serviceWorker.ready.then(async reg => {
      await reg.sync.register('sync-cache');
    });
  }
}

async function saveUserAnalytics() {
  const data = {
    lastOpen: Date.now(),
    onlineStatus: navigator.onLine,
    userAgent: navigator.userAgent
  };
  const compressed = compressData(data);
  const encrypted = await encryptData(compressed);
  await db.set('metadata', 'analytics', encrypted);
}

async function loadUserAnalytics() {
  const encrypted = await db.get('metadata', 'analytics');
  if (!encrypted) return;
  const decompressed = await decryptData(encrypted);
  console.log('User Analytics:', decompressData(decompressed));
}

(async function init() {
  await registerServiceWorker();
  await requestNotificationPermission();
  await checkCacheHealth();
  await saveUserAnalytics();
  await loadUserAnalytics();
})();
