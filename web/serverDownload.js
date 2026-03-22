import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ComfyUI.AutoModelDownloader Extension
// Version: 1.0.6
console.log('[AutoModelDownloader] v1.0.6');

// Track download states
const downloadStates = new Map();
let downloadQueue = [];
let isDownloadingAll = false;
let completedDownloads = 0;
let totalDownloads = 0;
let downloadStartTimes = new Map();

// Format bytes to human readable
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Calculate download speed
function calculateSpeed(downloadId, downloaded) {
    const startTime = downloadStartTimes.get(downloadId);
    if (!startTime) return '0 MB/s';

    const elapsedSeconds = (Date.now() - startTime) / 1000;
    if (elapsedSeconds < 1) return 'Calculating...';

    const bytesPerSecond = downloaded / elapsedSeconds;
    return formatBytes(bytesPerSecond) + '/s';
}

// Listen for server download events
api.addEventListener("server_download_progress", ({ detail }) => {
    const { download_id, progress, downloaded, total } = detail;

    if (!downloadStartTimes.has(download_id)) {
        downloadStartTimes.set(download_id, Date.now());
    }

    const speed = calculateSpeed(download_id, downloaded);

    downloadStates.set(download_id, {
        status: 'downloading',
        progress,
        downloaded,
        total,
        speed
    });

    // Trigger update event for UI components
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
});

api.addEventListener("server_download_complete", ({ detail }) => {
    const { download_id, path, size } = detail;

    // Increment counter BEFORE updating UI
    if (isDownloadingAll) {
        completedDownloads++;
        console.log(`[AutoModelDownloader] Progress: ${completedDownloads}/${totalDownloads} completed`);
    }

    downloadStates.set(download_id, {
        status: 'completed',
        progress: 100,
        path,
        size
    });

    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));

    console.log(`Download completed: ${download_id} -> ${path}`);

    // Check if all downloads are done
    if (isDownloadingAll && completedDownloads >= totalDownloads) {
        console.log('[AutoModelDownloader] All downloads completed!');
        isDownloadingAll = false;
        showRefreshPrompt();
    }
});

api.addEventListener("server_download_error", ({ detail }) => {
    const { download_id, error } = detail;

    // Increment counter BEFORE updating UI
    if (isDownloadingAll) {
        completedDownloads++;
        console.log(`[AutoModelDownloader] Progress: ${completedDownloads}/${totalDownloads} completed (1 error)`);
    }

    downloadStates.set(download_id, {
        status: 'error',
        error
    });

    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));

    console.error(`Download error: ${download_id} - ${error}`);

    // Check if all downloads are done (including failed ones)
    if (isDownloadingAll && completedDownloads >= totalDownloads) {
        console.log('[AutoModelDownloader] All downloads completed!');
        isDownloadingAll = false;
        showRefreshPrompt();
    }
});

// Function to start a server download
async function startServerDownload(url, savePath, filename, markAsQueued = false) {
    try {
        const download_id = `${savePath}/${filename}`;

        // Mark as queued immediately if requested (for Download All)
        if (markAsQueued) {
            downloadStates.set(download_id, {
                status: 'queued',
                progress: 0
            });

            window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
                detail: { download_id, ...downloadStates.get(download_id) }
            }));
        }

        const response = await api.fetchApi("/server_download/start", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                url,
                save_path: savePath,
                filename
            })
        });

        const result = await response.json();

        if (response.ok) {
            // If not already marked as queued, set as queued now
            if (!markAsQueued) {
                downloadStates.set(download_id, {
                    status: 'queued',
                    progress: 0
                });

                window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
                    detail: { download_id, ...downloadStates.get(download_id) }
                }));
            }

            return { success: true, download_id };
        } else {
            return { success: false, error: result.error };
        }
    } catch (error) {
        console.error("Failed to start download:", error);
        return { success: false, error: error.message };
    }
}

// Get download status
function getDownloadStatus(downloadId) {
    return downloadStates.get(downloadId) || null;
}

// Pause download
async function pauseDownload(downloadId) {
    try {
        const response = await api.fetchApi("/server_download/pause", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ download_id: downloadId })
        });

        const result = await response.json();
        return { success: response.ok, ...result };
    } catch (error) {
        console.error("Failed to pause download:", error);
        return { success: false, error: error.message };
    }
}

// Resume download
async function resumeDownload(downloadId) {
    try {
        const response = await api.fetchApi("/server_download/resume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ download_id: downloadId })
        });

        const result = await response.json();
        return { success: response.ok, ...result };
    } catch (error) {
        console.error("Failed to resume download:", error);
        return { success: false, error: error.message };
    }
}

// Cancel download
async function cancelDownload(downloadId) {
    try {
        const response = await api.fetchApi("/server_download/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ download_id: downloadId })
        });

        const result = await response.json();
        return { success: response.ok, ...result };
    } catch (error) {
        console.error("Failed to cancel download:", error);
        return { success: false, error: error.message };
    }
}

// Process download queue - Sends all downloads to backend which handles queue management
async function processDownloadQueue() {
    if (downloadQueue.length === 0) {
        console.log('[AutoModelDownloader] No downloads in queue');
        return;
    }

    // Send all downloads to the backend (backend handles queue and priorities)
    console.log(`[AutoModelDownloader] Starting ${downloadQueue.length} downloads (backend will queue and prioritize)`);

    const downloadsToStart = [...downloadQueue];
    downloadQueue = []; // Clear queue as we're sending all to backend

    // Start all downloads - backend will queue and manage priorities
    // Pass markAsQueued=true so buttons show "Queued" status immediately
    for (const download of downloadsToStart) {
        console.log(`[AutoModelDownloader] Queuing download ${download.filename}`);
        await startServerDownload(download.url, download.directory, download.filename, true);
    }

    console.log(`[AutoModelDownloader] All ${downloadsToStart.length} downloads queued on backend`);
}

// Show refresh prompt
function showRefreshPrompt() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return;

    // Find the dialog content area
    const dialogContent = dialog.querySelector('.p-dialog-content');
    if (!dialogContent) return;

    // Check if prompt already exists
    if (document.querySelector('.server-download-refresh-prompt')) {
        console.log('[AutoModelDownloader] Refresh prompt already shown');
        return;
    }

    // Create refresh prompt
    const refreshPrompt = document.createElement('div');
    refreshPrompt.className = 'server-download-refresh-prompt';
    refreshPrompt.style.cssText = `
        margin-top: 20px;
        padding: 16px;
        background: #4caf50;
        color: white;
        border-radius: 8px;
        text-align: center;
        font-weight: 500;
    `;

    refreshPrompt.innerHTML = `
        <div style="margin-bottom: 12px;">
            ✅ All models downloaded successfully!
        </div>
        <button class="p-button p-component p-button-sm"
                style="background: white; color: #4caf50; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: 600;"
                onclick="location.reload()">
            Refresh Page
        </button>
    `;

    dialogContent.appendChild(refreshPrompt);
}

// Create global progress area with individual progress bars for each download
function createProgressArea(listbox) {
    // Remove existing progress area if any
    const existing = document.querySelector('.server-download-progress-area');
    if (existing) existing.remove();

    const progressArea = document.createElement('div');
    progressArea.className = 'server-download-progress-area';
    progressArea.style.cssText = `
        margin-top: 20px;
        padding: 16px;
        background: var(--p-content-background, #1e1e1e);
        border: 1px solid var(--p-content-border-color, #333);
        border-radius: 8px;
    `;

    progressArea.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div style="font-weight: 600; color: var(--p-text-color);">
                Download Progress
            </div>
        </div>
        <div id="server-download-overall-progress" style="margin-bottom: 12px; font-size: 13px; color: var(--p-text-muted-color);">
            Overall: 0/${totalDownloads} models completed
        </div>
        <div id="server-download-items-container" style="display: flex; flex-direction: column; gap: 12px;">
            <!-- Individual download progress items will be added here -->
        </div>
    `;

    listbox.parentElement.appendChild(progressArea);

    // Listen for updates
    const updateHandler = (event) => {
        const { download_id, status, progress, downloaded, total, speed } = event.detail;

        if (!isDownloadingAll) {
            return;
        }

        // Update overall progress
        const overallProgress = document.getElementById('server-download-overall-progress');
        if (overallProgress) {
            overallProgress.textContent = `Overall: ${completedDownloads}/${totalDownloads} models completed`;
        }

        // Update or create individual progress item
        updateDownloadProgressItem(download_id, status, progress, downloaded, total, speed);
    };

    window.addEventListener('serverDownloadUpdate', updateHandler);
}

// Update or create a progress item for a specific download
function updateDownloadProgressItem(download_id, status, progress, downloaded, total, speed) {
    // Declare variables at function scope so they're accessible across try blocks
    let item = null;
    let container = null;
    const itemId = `download-item-${download_id.replace(/\//g, '-')}`;

    try {
        container = document.getElementById('server-download-items-container');
        if (!container) return;

        item = document.getElementById(itemId);

        // Don't show queued items
        if (status === 'queued') {
            if (item) item.remove();
            return;
        }

        // Remove completed/error items after a delay
        if (status === 'completed' || status === 'error') {
            if (item && !item.dataset.removing) {
                item.dataset.removing = 'true';
                setTimeout(() => {
                    try {
                        if (item && item.parentNode) item.remove();
                    } catch (e) {
                        console.error('[AutoModelDownloader] Error removing progress item:', e);
                    }
                }, 2000);
            }
        }

        // Create new item if it doesn't exist
        if (!item) {
            item = document.createElement('div');
            item.id = itemId;
            item.style.cssText = `
                padding: 12px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 6px;
                border: 1px solid rgba(255, 255, 255, 0.1);
            `;
            container.appendChild(item);
        }
    } catch (e) {
        console.error('[AutoModelDownloader] Error in updateDownloadProgressItem:', e);
        return;
    }

    try {
        // Status icon and color (no priority badge needed - downloading one at a time)
        let statusIcon = '';
        let statusColor = '#2196F3';
        if (status === 'downloading') {
            statusIcon = '<i class="pi pi-spin pi-spinner" style="margin-right: 6px;"></i>';
            statusColor = '#2196F3';
        } else if (status === 'completed') {
            statusIcon = '<i class="pi pi-check-circle" style="margin-right: 6px;"></i>';
            statusColor = '#4CAF50';
        } else if (status === 'error') {
            statusIcon = '<i class="pi pi-times-circle" style="margin-right: 6px;"></i>';
            statusColor = '#ef4444';
        } else if (status === 'paused') {
            statusIcon = '<i class="pi pi-pause" style="margin-right: 6px;"></i>';
            statusColor = '#FF9800';
        }

        const progressPercent = progress || 0;
        const speedText = speed || '--';
        const sizeText = downloaded && total ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : '--';

        if (item) {
            item.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <div style="font-size: 13px; color: ${statusColor}; font-weight: 500; display: flex; align-items: center;">
                        ${statusIcon}${download_id}
                    </div>
                    <div style="font-size: 12px; color: var(--p-text-muted-color);">
                        ${progressPercent.toFixed(1)}%
                    </div>
                </div>
                <div style="width: 100%; height: 8px; background: rgba(0,0,0,0.3); border-radius: 4px; overflow: hidden; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.1);">
                    <div style="height: 100%; background: linear-gradient(90deg, ${statusColor}, ${statusColor}aa); width: ${progressPercent}%; transition: width 0.3s;"></div>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--p-text-muted-color);">
                    <span>Speed: ${speedText}</span>
                    <span>${sizeText}</span>
                </div>
            `;
        }
    } catch (e) {
        console.error('[AutoModelDownloader] Error updating progress item HTML:', e);
    }
}

// Export functions for use in other modules
window.serverDownload = {
    start: startServerDownload,
    getStatus: getDownloadStatus,
    states: downloadStates
};

// Helper to inject buttons using MutationObserver
function setupDialogObserver() {
    console.log('[AutoModelDownloader] Setting up dialog observer');

    // Watch for the missing models dialog to appear
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Check for both old (.comfy-missing-models) and new (#global-missing-models-warning) dialog
                        const hasDialog = node.querySelector && (
                            node.querySelector('.comfy-missing-models') ||
                            node.classList?.contains('comfy-missing-models') ||
                            node.querySelector('#global-missing-models-warning') ||
                            node.id === 'global-missing-models-warning'
                        );

                        if (hasDialog) {
                            console.log('[AutoModelDownloader] Detected missing models dialog, injecting buttons...');
                            setTimeout(() => {
                                injectServerDownloadButtons();
                            }, 500);
                        }
                    }
                });
            }
        }
    });

    // Start observing the document body for dialog additions
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    console.log('[AutoModelDownloader] Observer active');
}

function findModelListContainer() {
    // Try new dialog structure first (ComfyUI v1.x with PrimeVue dialogs)
    const newDialog = document.querySelector('#global-missing-models-warning');
    if (newDialog) {
        // The model list is the scrollable div inside the dialog content
        const dialog = newDialog.closest('.p-dialog');
        if (dialog) {
            const modelList = dialog.querySelector('.bg-secondary-background');
            if (modelList) return { container: modelList, type: 'new' };
        }
    }
    // Fall back to legacy dialog structure
    const legacy = document.querySelector('.comfy-missing-models');
    if (legacy) return { container: legacy, type: 'legacy' };
    return null;
}

function parseModelItems(container, type) {
    const models = [];
    if (type === 'new') {
        // New structure: div rows with button[title="https://..."] for the download URL
        const rows = container.querySelectorAll(':scope > .flex.items-center.justify-between');
        rows.forEach(row => {
            const nameEl = row.querySelector('span.text-foreground[title]');
            const downloadBtn = row.querySelector('button[title^="http"]');
            if (!nameEl || !downloadBtn) return;

            const filename = nameEl.getAttribute('title');
            const url = downloadBtn.getAttribute('title');

            // Extract model type from badge text
            const badge = row.querySelector('span.uppercase');
            const modelType = badge ? badge.textContent.trim().toLowerCase().replace(' ', '_') : '';

            // Map model type to directory name
            const typeToDir = {
                'diffusion': 'diffusion_models',
                'checkpoint': 'checkpoints',
                'lora': 'loras',
                'vae': 'vae',
                'text_encoder': 'text_encoders',
                'clip': 'clip',
                'clip_vision': 'clip_vision',
                'controlnet': 'controlnet',
                'upscale_models': 'upscale_models',
                'latent_upscale_models': 'latent_upscale_models',
                'unet': 'unet',
                'embeddings': 'embeddings',
            };
            const directory = typeToDir[modelType] || modelType || 'checkpoints';

            models.push({ url, directory, filename, row });
        });
    } else {
        // Legacy structure: li.p-listbox-option with title elements
        const items = container.querySelectorAll('.p-listbox-option');
        items.forEach(item => {
            const labelElement = item.querySelector('[title]');
            if (!labelElement) return;
            const label = labelElement.textContent.trim();
            const url = labelElement.getAttribute('title');
            const parts = label.split('/').map(p => p.trim());
            if (parts.length !== 2) return;
            models.push({ url, directory: parts[0], filename: parts[1], row: item });
        });
    }
    return models;
}

function injectServerDownloadButtons() {
    console.log('[AutoModelDownloader] injectServerDownloadButtons called');

    const result = findModelListContainer();
    if (!result) {
        console.log('[AutoModelDownloader] Missing models listbox not found');
        return;
    }

    const { container: listbox, type: dialogType } = result;
    console.log(`[AutoModelDownloader] Found model list (${dialogType} dialog)`);

    // Check if we already added our UI
    if (document.querySelector('.server-download-all-btn')) {
        console.log('[AutoModelDownloader] Buttons already injected');
        return;
    }

    const models = parseModelItems(listbox, dialogType);
    console.log(`[AutoModelDownloader] Found ${models.length} models`);

    if (models.length === 0) {
        console.log('[AutoModelDownloader] No models found');
        return;
    }

    // Add "Download All to Server" button before the listbox
    const downloadAllContainer = document.createElement('div');
    downloadAllContainer.style.cssText = 'margin-bottom: 8px; display: flex; justify-content: center;';

    const downloadAllBtn = document.createElement('button');
    downloadAllBtn.className = 'server-download-all-btn';
    downloadAllBtn.type = 'button';
    downloadAllBtn.style.cssText = 'background: #2196F3; color: white; border: none; padding: 8px 16px; font-weight: 600; border-radius: 6px; cursor: pointer; font-size: 13px;';

    const downloadAllLabel = document.createElement('span');
    downloadAllLabel.textContent = `Download All to Server (${models.length})`;
    downloadAllBtn.appendChild(downloadAllLabel);

    downloadAllBtn.onclick = async (e) => {
        e.stopPropagation();
        downloadAllBtn.disabled = true;
        downloadAllBtn.style.opacity = '0.6';
        downloadAllLabel.textContent = 'Starting downloads...';

        downloadQueue = [...models];
        totalDownloads = models.length;
        completedDownloads = 0;
        isDownloadingAll = true;

        createProgressArea(listbox);

        if (downloadQueue.length > 0) {
            processDownloadQueue();
        }
    };

    downloadAllContainer.appendChild(downloadAllBtn);
    listbox.parentElement.insertBefore(downloadAllContainer, listbox);

    models.forEach((model, index) => {
        const item = model.row;
        console.log(`[AutoModelDownloader] Processing item ${index + 1}: ${model.filename}`);

        if (item.querySelector('.server-download-btn')) {
            return;
        }

        // Find the container for the download button (works for both dialog types)
        const mainContainer = dialogType === 'new'
            ? item.querySelector('.flex.shrink-0.items-center') || item
            : item.querySelector('.flex.flex-row.items-center.gap-2') || item;

        const buttonWrapper = document.createElement('div');

        const { url, directory, filename } = model;
        const download_id = `${directory}/${filename}`;
        console.log(`[AutoModelDownloader] Creating button for ${download_id}`);

        // Create server download button
        const serverDownloadBtn = document.createElement('button');
        serverDownloadBtn.className = 'server-download-btn p-button p-component p-button-outlined p-button-sm';
        serverDownloadBtn.type = 'button';

        // Create button content
        const btnLabel = document.createElement('span');
        btnLabel.className = 'p-button-label';
        btnLabel.textContent = 'Download to Comfy';
        serverDownloadBtn.appendChild(btnLabel);

        // Status indicator (icon)
        const statusIcon = document.createElement('i');
        statusIcon.style.cssText = 'margin-left: 6px; font-size: 14px; display: none;';
        serverDownloadBtn.appendChild(statusIcon);

        // Button click handler
        serverDownloadBtn.onclick = async (e) => {
            e.stopPropagation();
            serverDownloadBtn.disabled = true;
            btnLabel.textContent = 'Starting...';

            const result = await startServerDownload(url, directory, filename);

            if (result.success) {
                btnLabel.textContent = 'Queued';
                statusIcon.className = 'pi pi-clock';
                statusIcon.style.display = 'inline';
                statusIcon.style.color = '#FF9800';
            } else {
                btnLabel.textContent = 'Error';
                statusIcon.className = 'pi pi-times-circle';
                statusIcon.style.display = 'inline';
                statusIcon.style.color = '#ef4444';
                console.error('Download start failed:', result.error);
            }
        };

        // Listen for download updates
        const updateHandler = (event) => {
            if (event.detail.download_id === download_id) {
                const { status, error } = event.detail;

                if (status === 'queued') {
                    serverDownloadBtn.disabled = true;
                    btnLabel.textContent = 'Queued';
                    statusIcon.className = 'pi pi-clock';
                    statusIcon.style.display = 'inline';
                    statusIcon.style.color = '#FF9800';
                } else if (status === 'downloading') {
                    serverDownloadBtn.disabled = true;
                    btnLabel.textContent = 'Downloading';
                    statusIcon.className = 'pi pi-spin pi-spinner';
                    statusIcon.style.display = 'inline';
                    statusIcon.style.color = '#2196F3';
                } else if (status === 'completed') {
                    btnLabel.textContent = 'Completed';
                    statusIcon.className = 'pi pi-check-circle';
                    statusIcon.style.display = 'inline';
                    statusIcon.style.color = '#4caf50';
                    serverDownloadBtn.style.borderColor = '#4caf50';
                } else if (status === 'error') {
                    btnLabel.textContent = 'Failed';
                    statusIcon.className = 'pi pi-times-circle';
                    statusIcon.style.display = 'inline';
                    statusIcon.style.color = '#ef4444';
                    serverDownloadBtn.title = error;
                }
            }
        };

        window.addEventListener('serverDownloadUpdate', updateHandler);

        // Add button to wrapper div
        buttonWrapper.appendChild(serverDownloadBtn);

        // Add wrapper to main container (alongside Download and Copy URL)
        mainContainer.appendChild(buttonWrapper);
        console.log(`[AutoModelDownloader] Button added to main container for ${download_id}`);
    });

    console.log('[AutoModelDownloader] Button injection complete');
}

// Register the extension
app.registerExtension({
    name: "ComfyUI.AutoModelDownloader",

    async setup() {
        console.log("[AutoModelDownloader] Extension setup starting");

        // Set up observer to watch for missing models dialog
        setupDialogObserver();

        // Also try to inject immediately if dialog already exists
        setTimeout(() => {
            console.log('[AutoModelDownloader] Checking for existing dialog...');
            injectServerDownloadButtons();
        }, 1000);

        // Try again after a longer delay
        setTimeout(() => {
            console.log('[AutoModelDownloader] Second check for dialog...');
            injectServerDownloadButtons();
        }, 3000);

        console.log("[AutoModelDownloader] Extension setup complete");
    }
});
