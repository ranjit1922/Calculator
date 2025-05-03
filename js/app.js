// Constants for PWA configuration
const CONFIG = {
    SW_PATH: '/Calculator/js/sw.js',
    SW_SCOPE: 'https://ranjit1922.github.io/Calculator/',
    UPDATE_CHECK_INTERVAL: 60 * 60 * 1000, // 1 hour
    PERIODIC_SYNC_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
    VAPID_PUBLIC_KEY: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
};

// Custom error classes
class ServiceWorkerError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ServiceWorkerError';
    }
}

class PWAError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PWAError';
    }
}

// Main PWA initialization
export async function initializePWA() {
    if (!('serviceWorker' in navigator)) {
        throw new PWAError('Service Worker is not supported in this browser');
    }

    try {
        const registration = await registerServiceWorker();
        await Promise.all([
            setupServiceWorkerUpdates(registration),
            setupBackgroundSync(registration),
            setupPushNotifications(registration),
            setupNetworkHandlers(),
            setupMessageHandlers(registration)
        ]);

        return registration;
    } catch (error) {
        handlePWAError(error);
        throw error; // Re-throw for upstream handling
    }
}

// Service Worker Registration
async function registerServiceWorker() {
    try {
        const registration = await navigator.serviceWorker.register(CONFIG.SW_PATH, {
            scope: CONFIG.SW_SCOPE
        });
        
        console.log('Service Worker registered successfully', {
            scope: registration.scope,
            active: !!registration.active,
            installing: !!registration.installing,
            waiting: !!registration.waiting
        });
        
        return registration;
    } catch (error) {
        throw new ServiceWorkerError(`Service Worker registration failed: ${error.message}`);
    }
}

// Service Worker Updates Management
async function setupServiceWorkerUpdates(registration) {
    // Initial check for updates
    await checkForUpdates(registration);

    // Setup periodic update checks
    setInterval(() => checkForUpdates(registration), CONFIG.UPDATE_CHECK_INTERVAL);

    // Handle update found
    registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        
        newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                notifyUserAboutUpdate(registration);
            }
        });
    });
}

// Check for Service Worker updates
async function checkForUpdates(registration) {
    try {
        await registration.update();
        if (registration.waiting) {
            notifyUserAboutUpdate(registration);
        }
    } catch (error) {
        console.warn('Update check failed:', error);
        // Don't throw - this is a background operation
    }
}

// Update notification UI
function notifyUserAboutUpdate(registration) {
    // Remove existing notification if present
    const existingNotification = document.querySelector('.update-notification');
    if (existingNotification) {
        existingNotification.remove();
    }

    // Create new notification
    const notification = createUpdateNotification();
    
    // Add event listener for update
    notification.querySelector('button').addEventListener('click', () => {
        applyUpdate(registration);
    });

    document.body.appendChild(notification);
}

// Create update notification element
function createUpdateNotification() {
    const container = document.createElement('div');
    container.className = 'update-notification';
    
    const button = document.createElement('button');
    button.className = 'update-button';
    button.textContent = 'Update Available! Click to reload';
    
    container.appendChild(button);
    return container;
}

// Apply Service Worker update
function applyUpdate(registration) {
    if (registration.waiting) {
        // Send skip waiting message
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });

        // Reload once the new Service Worker takes over
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            window.location.reload();
        });
    }
}

// Background Sync Setup
async function setupBackgroundSync(registration) {
    if (!('sync' in registration)) {
        console.log('Background Sync not supported');
        return;
    }

    try {
        // Register for background sync
        await registration.sync.register('site-background-sync');

        // Setup periodic sync if available
        if ('periodicSync' in registration) {
            const status = await navigator.permissions.query({
                name: 'periodic-background-sync'
            });

            if (status.state === 'granted') {
                await registration.periodicSync.register('site-periodic-sync', {
                    minInterval: CONFIG.PERIODIC_SYNC_INTERVAL
                });
            }
        }
    } catch (error) {
        console.warn('Background sync setup failed:', error);
        // Don't throw - this is an enhancement
    }
}

// Push Notifications Setup
async function setupPushNotifications(registration) {
    if (!('Notification' in window)) {
        console.log('Push notifications not supported');
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        
        if (permission === 'granted') {
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY)
            });

            // Here you would typically send the subscription to your server
            console.log('Push notification subscription:', subscription);
        }
    } catch (error) {
        console.warn('Push notification setup failed:', error);
        // Don't throw - this is an enhancement
    }
}

// Network Status Handlers
function setupNetworkHandlers() {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
}

function handleOnline() {
    console.log('App is online');
    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: 'PROCESS_SYNC_QUEUE'
        });
    }
}

function handleOffline() {
    console.log('App is offline');
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Offline Mode', {
            body: 'The app is now running in offline mode'
        });
    }
}

// Service Worker Message Handlers
function setupMessageHandlers(registration) {
    navigator.serviceWorker.addEventListener('message', event => {
        const { type, data } = event.data;
        
        const handlers = {
            'CACHE_UPDATED': () => console.log('Cache updated:', data.url),
            'RESOURCE_CACHED': () => console.log('New resource cached:', data.url),
            'SYNC_COMPLETE': () => console.log('Background sync completed:', data.results),
            'ERROR': () => console.error('Service Worker error:', data.error)
        };

        if (handlers[type]) {
            handlers[type]();
        }
    });
}

// Utility Functions
function urlBase64ToUint8Array(base64String) {
    try {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/\-/g, '+')
            .replace(/_/g, '/');

        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);

        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        
        return outputArray;
    } catch (error) {
        throw new Error(`Failed to convert base64 string: ${error.message}`);
    }
}

// Error Handling
function handlePWAError(error) {
    console.error('PWA Error:', error);

    // Different handling based on error type
    if (error instanceof ServiceWorkerError) {
        showNotification('Service Worker Error', error.message);
    } else if (error instanceof PWAError) {
        showNotification('PWA Error', error.message);
    } else {
        showNotification('Error', 'An unexpected error occurred');
    }
}

// Show notification to user
function showNotification(title, message) {
    const notification = document.createElement('div');
    notification.className = 'error-notification';
    notification.innerHTML = `
        <h3>${title}</h3>
        <p>${message}</p>
    `;
    
    document.body.appendChild(notification);
    
    // Remove after 5 seconds
    setTimeout(() => notification.remove(), 5000);
}

// Public API
export {
    checkForUpdates,
    handleOnline,
    handleOffline
};
