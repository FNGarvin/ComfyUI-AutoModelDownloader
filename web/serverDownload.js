import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ComfyUI.AutoModelDownloader Extension
// Version: 3.2.0 — Targets the actual missing-models dialog DOM
//
// The missing-models dialog is a PrimeVue p-dialog that appears when
// loading a workflow with models not on disk. Each model row has:
//   <button title="https://huggingface.co/..." aria-label="Download">
//     <i class="icon-[lucide--download]">
//   </button>
// The URL is in the button's title attr. The filename is in a sibling
// span[title]. The badge (LORA, DIFFUSION, etc.) indicates the category.
//
// We inject a "⬇ Server" button next to each download button, and a
// "⬇ All to Server" button next to the existing "Download all".
console.log('[AutoModelDownloader] v3.2.0');

// ── Download state tracking ──
const downloadStates = new Map();
const downloadStartTimes = new Map();
let serverDownloadAllActive = false;
let serverDownloadAllCompleted = 0;
let serverDownloadAllTotal = 0;

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function calculateSpeed(downloadId, downloaded) {
    const startTime = downloadStartTimes.get(downloadId);
    if (!startTime) return '0 MB/s';
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed < 1) return 'Calculating...';
    return formatBytes(downloaded / elapsed) + '/s';
}

// ── Server event listeners ──
api.addEventListener("server_download_progress", ({ detail }) => {
    const { download_id, progress, downloaded, total } = detail;
    if (!downloadStartTimes.has(download_id)) downloadStartTimes.set(download_id, Date.now());
    const speed = calculateSpeed(download_id, downloaded);
    downloadStates.set(download_id, { status: 'downloading', progress, downloaded, total, speed });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
});

api.addEventListener("server_download_complete", ({ detail }) => {
    const { download_id, path, size } = detail;
    if (serverDownloadAllActive) {
        serverDownloadAllCompleted++;
        console.log(`[AutoModelDownloader] Progress: ${serverDownloadAllCompleted}/${serverDownloadAllTotal}`);
    }
    downloadStates.set(download_id, { status: 'completed', progress: 100, path, size });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
    if (serverDownloadAllActive && serverDownloadAllCompleted >= serverDownloadAllTotal) {
        console.log('[AutoModelDownloader] All server downloads completed!');
        serverDownloadAllActive = false;
    }
});

api.addEventListener("server_download_error", ({ detail }) => {
    const { download_id, error } = detail;
    if (serverDownloadAllActive) serverDownloadAllCompleted++;
    downloadStates.set(download_id, { status: 'error', error });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
    if (serverDownloadAllActive && serverDownloadAllCompleted >= serverDownloadAllTotal) {
        serverDownloadAllActive = false;
    }
});

// ── API call ──
async function startServerDownload(url, savePath, filename) {
    try {
        const download_id = `${savePath}/${filename}`;
        downloadStates.set(download_id, { status: 'queued', progress: 0 });
        window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
            detail: { download_id, ...downloadStates.get(download_id) }
        }));

        const response = await api.fetchApi("/server_download/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, save_path: savePath, filename })
        });
        const result = await response.json();
        if (response.ok) return { success: true, download_id };
        return { success: false, error: result.error };
    } catch (error) {
        console.error("[AutoModelDownloader] Failed to start download:", error);
        return { success: false, error: error.message };
    }
}

window.serverDownload = {
    start: startServerDownload,
    getStatus: (id) => downloadStates.get(id) || null,
    states: downloadStates
};

// ── Category badge → model directory mapping ──
// The dialog shows badges like "LORA", "DIFFUSION", "VAE", "CLIP", etc.
// Map these to the ComfyUI models/ subdirectory names.
const BADGE_TO_DIRECTORY = {
    'lora': 'loras',
    'loras': 'loras',
    'checkpoint': 'checkpoints',
    'checkpoints': 'checkpoints',
    'diffusion': 'diffusion_models',
    'diffusion_models': 'diffusion_models',
    'vae': 'vae',
    'clip': 'clip',
    'controlnet': 'controlnet',
    'embedding': 'embeddings',
    'embeddings': 'embeddings',
    'upscale': 'upscale_models',
    'upscale_models': 'upscale_models',
    'unet': 'unet',
    'text_encoders': 'text_encoders',
    'text_encoder': 'text_encoders',
};

function badgeToDirectory(badgeText) {
    if (!badgeText) return 'checkpoints'; // fallback
    const key = badgeText.trim().toLowerCase();
    return BADGE_TO_DIRECTORY[key] || key;
}

// ── Model discovery from the actual dialog DOM ──
// The dialog structure (from the real DOM):
//   <div class="p-dialog ...">
//     <div class="p-dialog-content">
//       <div class="flex ... rounded-lg bg-secondary-background">  ← model list
//         <div class="flex items-center justify-between px-3 py-2">  ← model row
//           <div>
//             <span title="filename.safetensors">...</span>
//             <span class="...uppercase">LORA</span>  ← badge
//           </div>
//           <div>
//             <span>810.25 MB</span>
//             <button title="https://huggingface.co/..." aria-label="Download">
//               <i class="icon-[lucide--download]">
//             </button>
//           </div>
//         </div>
//       </div>
//     </div>
//     <div class="p-dialog-footer">
//       <button>Download all</button>
//     </div>
//   </div>

function discoverModels() {
    const models = [];
    const seen = new Set();

    // Find all download buttons by aria-label="Download" with a URL in title
    const downloadButtons = document.querySelectorAll(
        'button[aria-label="Download"][title*="://"]'
    );

    for (const btn of downloadButtons) {
        // Skip our own injected buttons
        if (btn.hasAttribute('data-automodel-server')) continue;

        const url = btn.getAttribute('title');
        if (!url) continue;

        // Walk up to the row container (flex items-center justify-between px-3 py-2)
        const row = btn.closest('.flex.items-center.justify-between');
        if (!row) continue;

        // Extract filename from span[title] in the row
        const nameSpan = row.querySelector('span[title]');
        if (!nameSpan) continue;
        const filename = nameSpan.getAttribute('title');
        if (!filename || !filename.includes('.')) continue;

        // Extract badge text (LORA, DIFFUSION, etc.) from uppercase span
        const badgeSpan = row.querySelector('span[class*="uppercase"]');
        const badge = badgeSpan ? badgeSpan.textContent.trim() : '';
        const directory = badgeToDirectory(badge);

        const key = `${directory}/${filename}`;
        if (seen.has(key)) continue;
        seen.add(key);

        models.push({ url, directory, filename, downloadButton: btn, row });
    }

    // Fallback: also try finding download icons without aria-label
    if (models.length === 0) {
        const icons = document.querySelectorAll('i[class*="lucide--download"]');
        for (const icon of icons) {
            const btn = icon.closest('button');
            if (!btn || btn.hasAttribute('data-automodel-server')) continue;

            const url = btn.getAttribute('title');
            if (!url || !url.includes('://')) continue;

            const row = btn.closest('[class*="justify-between"]');
            if (!row) continue;

            const nameSpan = row.querySelector('span[title]');
            if (!nameSpan) continue;
            const filename = nameSpan.getAttribute('title');
            if (!filename || !filename.includes('.')) continue;

            const badgeSpan = row.querySelector('span[class*="uppercase"]');
            const badge = badgeSpan ? badgeSpan.textContent.trim() : '';
            const directory = badgeToDirectory(badge);

            const key = `${directory}/${filename}`;
            if (seen.has(key)) continue;
            seen.add(key);

            models.push({ url, directory, filename, downloadButton: btn, row });
        }
    }

    console.log(`[AutoModelDownloader] Discovered ${models.length} models`);
    if (models.length > 0) {
        models.forEach(m => console.log(`  → ${m.directory}/${m.filename} (${m.url.substring(0, 60)}...)`));
    }
    return models;
}

// ── Button creation and injection ──
const BUTTON_MARKER = 'data-automodel-server';

function createServerButton(label, onClick, size = 'sm') {
    const btn = document.createElement('button');
    btn.setAttribute(BUTTON_MARKER, 'true');
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(btn);
    });

    const baseStyle = `
        display: inline-flex; align-items: center; justify-content: center;
        gap: 4px; border-radius: 6px; background: #1a6b3c; color: #e0e0e0;
        border: 1px solid #2a8a4e; cursor: pointer; white-space: nowrap;
        transition: background 0.15s; font-family: inherit;
    `;
    if (size === 'sm') {
        btn.style.cssText = baseStyle + 'padding: 4px 8px; font-size: 12px; height: 32px;';
    } else {
        btn.style.cssText = baseStyle + 'padding: 6px 14px; font-size: 12px; height: 32px; font-weight: 500;';
    }
    btn.addEventListener('mouseenter', () => { btn.style.background = '#228b47'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#1a6b3c'; });
    return btn;
}

function injectServerButtons() {
    // Clean up stale buttons
    document.querySelectorAll(`[${BUTTON_MARKER}]`).forEach(el => {
        if (!document.body.contains(el.parentElement)) el.remove();
    });

    const models = discoverModels();
    if (models.length === 0) return;

    let injectedCount = 0;

    for (const model of models) {
        if (!model.downloadButton) continue;

        // The download button sits inside a flex container with the size label.
        // We inject our button right after the original download button.
        const parent = model.downloadButton.parentElement;
        if (!parent) continue;
        if (parent.querySelector(`[${BUTTON_MARKER}]`)) continue;

        const btn = createServerButton('⬇ Server', async (btnEl) => {
            btnEl.disabled = true;
            btnEl.textContent = '⏳';
            btnEl.style.opacity = '0.7';

            const result = await startServerDownload(model.url, model.directory, model.filename);
            if (result.success) {
                btnEl.textContent = '✓';
                btnEl.style.background = '#1565c0';
                showDownloadToast(model.filename, 'queued');
            } else {
                btnEl.textContent = '✗';
                btnEl.style.background = '#c62828';
                showDownloadToast(model.filename, 'error', result.error);
                setTimeout(() => {
                    btnEl.textContent = '⬇ Server';
                    btnEl.style.background = '#1a6b3c';
                    btnEl.style.opacity = '1';
                    btnEl.disabled = false;
                }, 3000);
            }
        }, 'sm');

        model.downloadButton.insertAdjacentElement('afterend', btn);
        injectedCount++;
    }

    // Inject "⬇ All to Server" next to "Download all"
    injectDownloadAllServerButton(models);

    if (injectedCount > 0) {
        console.log(`[AutoModelDownloader] Injected ${injectedCount} server download buttons`);
    }
}

function injectDownloadAllServerButton(models) {
    // The "Download all" button is in the p-dialog-footer
    let downloadAllBtn = null;
    const footers = document.querySelectorAll('.p-dialog-footer');
    for (const footer of footers) {
        const buttons = footer.querySelectorAll('button');
        for (const btn of buttons) {
            if (btn.textContent.trim().toLowerCase().includes('download all') &&
                !btn.hasAttribute(BUTTON_MARKER)) {
                downloadAllBtn = btn;
                break;
            }
        }
        if (downloadAllBtn) break;
    }

    // Fallback: search all buttons
    if (!downloadAllBtn) {
        for (const btn of document.querySelectorAll('button')) {
            if (btn.textContent.trim().toLowerCase() === 'download all' &&
                !btn.hasAttribute(BUTTON_MARKER)) {
                downloadAllBtn = btn;
                break;
            }
        }
    }

    if (!downloadAllBtn) return;

    const parent = downloadAllBtn.parentElement;
    if (!parent || parent.querySelector(`[${BUTTON_MARKER}="download-all"]`)) return;

    const downloadableModels = models.filter(m => m.url);

    const btn = createServerButton(
        `⬇ All to Server (${downloadableModels.length})`,
        async (btnEl) => {
            if (downloadableModels.length === 0) {
                showDownloadToast('No models', 'error', 'No downloadable URLs found');
                return;
            }
            btnEl.disabled = true;
            serverDownloadAllActive = true;
            serverDownloadAllCompleted = 0;
            serverDownloadAllTotal = downloadableModels.length;
            btnEl.textContent = `⏳ 0/${downloadableModels.length}`;
            btnEl.style.background = '#1565c0';

            for (const model of downloadableModels) {
                const result = await startServerDownload(model.url, model.directory, model.filename);
                if (!result.success) {
                    console.error(`[AutoModelDownloader] Failed: ${model.filename}: ${result.error}`);
                }
            }

            const checkInterval = setInterval(() => {
                btnEl.textContent = `⏳ ${serverDownloadAllCompleted}/${serverDownloadAllTotal}`;
                if (!serverDownloadAllActive) {
                    clearInterval(checkInterval);
                    btnEl.textContent = `✓ Done (${serverDownloadAllTotal})`;
                    btnEl.style.background = '#2e7d32';
                    setTimeout(() => {
                        btnEl.textContent = `⬇ All to Server (${downloadableModels.length})`;
                        btnEl.style.background = '#1a6b3c';
                        btnEl.disabled = false;
                    }, 5000);
                }
            }, 500);
        },
        'lg'
    );
    btn.setAttribute(BUTTON_MARKER, 'download-all');
    downloadAllBtn.insertAdjacentElement('afterend', btn);
}

// ── Toast notifications ──
function showDownloadToast(filename, status, error) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; z-index: 99999;
        padding: 12px 20px; border-radius: 8px; font-size: 13px;
        color: white; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        transition: opacity 0.3s; max-width: 400px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    `;
    if (status === 'queued') {
        toast.style.background = '#2196F3';
        toast.textContent = `⬇️ Server download queued: ${filename}`;
    } else if (status === 'error') {
        toast.style.background = '#ef4444';
        toast.textContent = `❌ Download failed: ${filename} — ${error}`;
    }
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ── Progress overlay ──
let progressOverlay = null;

function ensureProgressOverlay() {
    if (progressOverlay && document.body.contains(progressOverlay)) return progressOverlay;
    progressOverlay = document.createElement('div');
    progressOverlay.id = 'automodel-progress-overlay';
    progressOverlay.style.cssText = `
        position: fixed; bottom: 20px; left: 20px; z-index: 99998;
        background: rgba(30, 30, 30, 0.95); border: 1px solid #333;
        border-radius: 12px; padding: 16px; min-width: 300px; max-width: 420px;
        color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        max-height: 400px; overflow-y: auto; display: none;
    `;
    progressOverlay.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 8px; display: flex; justify-content: space-between;">
            <span>Server Downloads</span>
            <span id="automodel-overall" style="color: #888;"></span>
        </div>
        <div id="automodel-items"></div>
    `;
    document.body.appendChild(progressOverlay);
    return progressOverlay;
}

window.addEventListener('serverDownloadUpdate', (event) => {
    const { download_id, status, progress, downloaded, total, speed } = event.detail;
    const overlay = ensureProgressOverlay();
    overlay.style.display = 'block';

    const container = document.getElementById('automodel-items');
    if (!container) return;

    const itemId = `automodel-item-${download_id.replace(/[^a-zA-Z0-9]/g, '-')}`;
    let item = document.getElementById(itemId);

    if (status === 'completed' || status === 'error') {
        if (item) setTimeout(() => item?.remove(), 3000);
        setTimeout(() => {
            if (container.children.length === 0) overlay.style.display = 'none';
        }, 3500);
        return;
    }

    if (!item) {
        item = document.createElement('div');
        item.id = itemId;
        item.style.cssText = 'margin-bottom: 10px; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 6px;';
        container.appendChild(item);
    }

    const pct = (progress || 0).toFixed(1);
    const dl = downloaded ? formatBytes(downloaded) : '--';
    const tot = total ? formatBytes(total) : '--';
    const spd = speed || '--';

    item.innerHTML = `
        <div style="margin-bottom: 4px; font-size: 12px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${download_id}</div>
        <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.3); border-radius: 3px; overflow: hidden; margin-bottom: 4px;">
            <div style="height: 100%; background: #2196F3; width: ${pct}%; transition: width 0.3s;"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 11px; color: #888;">
            <span>${pct}% — ${spd}</span><span>${dl} / ${tot}</span>
        </div>
    `;

    const overall = document.getElementById('automodel-overall');
    if (overall && serverDownloadAllActive) {
        overall.textContent = `${serverDownloadAllCompleted}/${serverDownloadAllTotal}`;
    }
});

// ── MutationObserver: watch for the p-dialog to appear ──
function setupDialogObserver() {
    console.log('[AutoModelDownloader] Setting up dialog observer');

    let injectTimeout = null;
    function scheduleInject() {
        if (injectTimeout) clearTimeout(injectTimeout);
        injectTimeout = setTimeout(() => injectServerButtons(), 200);
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length === 0) continue;
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                // Detect the missing-models dialog appearing:
                // - A p-dialog with "missing models" in its text
                // - Or any element containing download buttons with HF/Civitai URLs
                // - Or aria-label="Download" buttons
                const isDialog = node.classList?.contains('p-dialog') ||
                    node.querySelector?.('.p-dialog');
                const hasDownloadBtns = node.querySelector?.(
                    'button[aria-label="Download"], i[class*="lucide--download"]'
                );
                if (isDialog || hasDownloadBtns) {
                    scheduleInject();
                    break;
                }
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Also try on initial load in case dialog is already open
    setTimeout(scheduleInject, 2000);
    setTimeout(scheduleInject, 5000);
}

// ── Extension registration ──
app.registerExtension({
    name: "ComfyUI.AutoModelDownloader",
    async setup() {
        console.log("[AutoModelDownloader] Extension setup — v3.2.0 dialog-aware buttons");
        setupDialogObserver();
        console.log("[AutoModelDownloader] Ready. Server download buttons will appear in the missing models dialog.");
    }
});
