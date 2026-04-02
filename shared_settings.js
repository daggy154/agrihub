// shared-settings.js - Include this in all dashboard HTML files
const API_BASE = 'http://localhost:3000';
let globalSettings = {
    siteTitle: "AgriHub",
    contactEmail: "admin@agrihub.com",
    phone: "+254700000000",
    serviceFeePercent: 10,
    currency: "KSH",
    maintenanceMode: false
};

let settingsChangeListeners = [];

// Load settings from server
async function loadGlobalSettings() {
    try {
        const response = await fetch(`${API_BASE}/api/settings`);
        if (!response.ok) throw new Error('Failed to fetch settings');
        const settings = await response.json();
        
        // Update global settings
        Object.assign(globalSettings, settings);
        
        // Notify all listeners
        notifySettingsListeners();
        
        // Store in localStorage as cache
        localStorage.setItem('agrihub_global_settings', JSON.stringify(globalSettings));
        
        return globalSettings;
    } catch (error) {
        console.error('Error loading settings:', error);
        // Fallback to localStorage
        const cached = localStorage.getItem('agrihub_global_settings');
        if (cached) {
            Object.assign(globalSettings, JSON.parse(cached));
            notifySettingsListeners();
        }
        return globalSettings;
    }
}

// Get current settings
function getCurrentSettings() {
    return { ...globalSettings };
}

// Add listener for settings changes
function onSettingsChange(callback) {
    settingsChangeListeners.push(callback);
    // Immediately call with current settings
    callback(globalSettings);
}

// Notify all listeners of settings change
function notifySettingsListeners() {
    settingsChangeListeners.forEach(callback => {
        try {
            callback(globalSettings);
        } catch (e) {
            console.error('Error in settings listener:', e);
        }
    });
}

// Calculate final price with current service fee
function calculateFinalPrice(basePrice, quantity = 1) {
    const fee = globalSettings.serviceFeePercent || 10;
    const subtotal = basePrice * quantity;
    const serviceFee = subtotal * (fee / 100);
    return {
        subtotal: subtotal,
        serviceFee: serviceFee,
        total: subtotal + serviceFee,
        serviceFeePercent: fee
    };
}

// Format price with currency
function formatPrice(amount) {
    return `${globalSettings.currency} ${amount.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

// Update all price displays on the page
function updateAllPriceDisplays() {
    // Find all elements with data-price attribute and recalculate
    document.querySelectorAll('[data-price]').forEach(element => {
        const basePrice = parseFloat(element.getAttribute('data-price'));
        const quantity = parseInt(element.getAttribute('data-quantity') || '1');
        if (!isNaN(basePrice)) {
            const { total, serviceFeePercent } = calculateFinalPrice(basePrice, quantity);
            element.textContent = formatPrice(total);
            
            // Update service fee display if exists
            const feeElement = element.closest('.product-item')?.querySelector('.service-fee-display');
            if (feeElement) {
                feeElement.textContent = `${serviceFeePercent}%`;
            }
        }
    });
    
    // Update all elements with class 'service-fee-percent'
    document.querySelectorAll('.service-fee-percent').forEach(element => {
        element.textContent = globalSettings.serviceFeePercent;
    });
    
    // Update currency displays
    document.querySelectorAll('.currency-symbol').forEach(element => {
        element.textContent = globalSettings.currency;
    });
}

// Initialize WebSocket connection for real-time updates
function initSettingsWebSocket() {
    const socket = io(API_BASE);
    
    socket.on('settingsUpdated', (newSettings) => {
        console.log('Settings updated in real-time:', newSettings);
        
        // Update global settings
        Object.assign(globalSettings, newSettings);
        
        // Save to localStorage
        localStorage.setItem('agrihub_global_settings', JSON.stringify(globalSettings));
        
        // Notify all listeners
        notifySettingsListeners();
        
        // Update all price displays on the page
        updateAllPriceDisplays();
        
        // Show notification to user
        showSettingsUpdateNotification(newSettings);
    });
    
    return socket;
}

function showSettingsUpdateNotification(settings) {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = 'settings-update-notification';
    notification.innerHTML = `
        <div style="background: #2b7a3e; color: white; padding: 12px 20px; border-radius: 12px; margin-bottom: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
            <strong>⚙️ Platform Settings Updated</strong><br>
            <small>Service fee changed to ${settings.serviceFeePercent}% | Currency: ${settings.currency}</small>
        </div>
    `;
    notification.style.position = 'fixed';
    notification.style.bottom = '20px';
    notification.style.right = '20px';
    notification.style.zIndex = '10000';
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 5000);
}

// Auto-initialize when script loads
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', async () => {
        await loadGlobalSettings();
        
        // Add WebSocket if available
        if (typeof io !== 'undefined') {
            initSettingsWebSocket();
        }
        
        // Update all price displays initially
        updateAllPriceDisplays();
    });
}