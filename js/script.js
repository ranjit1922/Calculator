import { setupUI } from "./ui.js";

document.addEventListener("DOMContentLoaded", () => { setupUI(); });

// Service Worker Registration
// Add this to your script.js file

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(registration => {
          console.log('ServiceWorker registration successful with scope:', registration.scope);
          
          // Check for updates on page load
          registration.update();
          
          // Setup update detection
          setInterval(() => {
            registration.update();
          }, 60 * 60 * 1000); // Check for updates every hour
          
          // Handle new service worker installation
          if (registration.waiting) {
            notifyUserOfUpdate(registration);
          }
          
          // Detect new service worker waiting
          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                notifyUserOfUpdate(registration);
              }
            });
          });
        })
        .catch(error => {
          console.error('ServiceWorker registration failed:', error);
        });
    });
    
    // Detect controller change (new service worker took over)
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  } else {
    console.log('Service workers are not supported');
  }
}

// Notify user about available update
function notifyUserOfUpdate(registration) {
  // You can implement a UI notification here
  console.log('New version available! Ready to update.');
  
  // Example: You might want to show a notification or button to the user
  // This is where you could show a "refresh to update" button
  
  // For testing, we'll add a simple alert - replace with your own UI
  if (confirm('New version available! Would you like to update?')) {
    if (registration.waiting) {
      // Send message to SW to skip waiting and activate new SW
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  }
}

// Call the registration function
registerServiceWorker();
