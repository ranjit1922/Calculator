// Import UI and PWA setup
import { setupUI } from "./ui.js";
import { initializePWA } from "./app.js";

// Initialize app when DOM is ready
document.addEventListener("DOMContentLoaded", async () => {
    try {
        // Setup UI components
        await setupUI();
        
        // Initialize PWA features
        await initializePWA();
    } catch (error) {
        console.error('Application initialization failed:', error);
        // Show user-friendly error message
        showErrorMessage('Failed to initialize the application. Please refresh the page.');
    }
});

// Simple error message display
function showErrorMessage(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    
    // Auto-remove after 5 seconds
    setTimeout(() => errorDiv.remove(), 5000);
}
