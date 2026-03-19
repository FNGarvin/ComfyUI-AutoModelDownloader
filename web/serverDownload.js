import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ComfyUI.AutoModelDownloader Extension
// Version: 2.0.0 — Rewritten for new Vue-based ComfyUI frontend (v1.3+)
//
// The old frontend had a `.comfy-missing-models` dialog with `.p-listbox-option`
// items. The new frontend renders missing models in a right-side-panel Vue
// component tree:
//   TabErrors → MissingModelCard → MissingModelRow
//
// Each MissingModelRow has a "Download" button that calls downloadModel() which,
// in non-desktop (browser) mode, just creates an <a> tag click (browser download).
// We intercept those clicks and route them through our backend API instead.
//
// The "Download All" button lives in TabErrors.vue as a sibling of the group
// header for missing_model groups.
console.log('[AutoModelDownloader] v2.0.0');

// ── State ──
const downloadStates = new Map();
let isDownloadingAll = false;
let completedDownloads = 0;
let totalDownloads = 0;
const downloadStartTimes = new Map();

// ── Helpers ──
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
    if (isDownloadingAll) {
        completedDownloads++;
        console.log(`[AutoModelDownloader] Progress: ${completedDownloads}/${totalDownloads}`);
    }
    downloadStates.set(download_id, { status: 'completed', progress: 100, path, size });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
    if (isDownloadingAll && completedDownloads >= totalDownloads) {
        console.log('[AutoModelDownloader] All downloads completed!');
        isDownloadingAll = false;
    }
});

api.addEventListener("server_download_error", ({ detail }) => {
    const { download_id, error } = detail;
    if (isDownloadingAll) {
        completedDownloads++;
        console.log(`[AutoModelDownloader] Progress: ${completedDownloads}/${totalDownloads} (1 error)`);
    }
    downloadStates.set(download_id, { status: 'error', error });
    window.dispatchEvent(new CustomEvent('serverDownloadUpdate', {
        detail: { download_id, ...downloadStates.get(download_id) }
    }));
    if (isDownloadingAll && completedDownloads >= totalDownloads) {
        isDownloadingAll = false;
    }
});

// ── API calls ──
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
        if (response.ok) {
            return { success: true, download_id };
        }
        return { success: false, error: result.error };
    } catch (error) {
        console.error("[AutoModelDownloader] Failed to start download:", error);
        return { success: false, error: error.message };
    }
}

// ── Export for other modules ──
window.serverDownload = {
    start: startServerDownload,
    getStatus: (id) => downloadStates.get(id) || null,
    states: downloadStates
};

// ── DOM interception for the new Vue frontend ──
//
// Strategy: We use a MutationObserver to watch for download buttons rendered
// by the new MissingModelRow.vue and TabErrors.vue components. Instead of
// looking for a specific CSS class on a dialog, we look for:
//
// 1. Per-model "Download" buttons: These are <button> elements inside the
//    missing model rows that contain an icon-[lucide--download] icon and
//    a text span with "Download" (possibly with a size suffix).
//
// 2. "Download all" button: In the group header for missing models, a button
//    whose text starts with "Download all".
//
// When we find these buttons, we clone-replace them with our own versions
// that call the server download API instead of triggering browser downloads.
//
// We also intercept <a> tag clicks as a fallback — the frontend's
// downloadModel() creates a temporary <a> element and clicks it.

// Intercept <a> tag creation for model downloads
const DOWNLOAD_URL_PATTERNS = [
    'civitai.com',
    'huggingface.co',
];

const MODEL_EXTENSIONS = ['.safetensors', '.sft', '.ckpt', '.pth', '.pt'];

function isModelDownloadUrl(url) {
    if (!url) return false;
    const isFromKnownSource = DOWNLOAD_URL_PATTERNS.some(p => url.includes(p));
    const hasModelExtension = MODEL_EXTENSIONS.some(ext => url.toLowerCase().includes(ext));
    return isFromKnownSource || hasModelExtension;
}

// Parse a model URL to extract directory and filename.
// The frontend's downloadModel() is called with { name, url, directory }.
// We need to reconstruct directory + filename from the URL context.
// The MissingModelRow shows: category header (directory) → model name (filename).
function parseModelFromButton(button) {
    // Walk up to find the model row container and category header
    // MissingModelRow structure:
    //   <div class="flex w-full flex-col pb-3">  ← row root
    //     <div class="flex h-8 ...">  ← header with model name
    //       <i class="icon-[lucide--file-check]" />
    //       <div> <p title="modelname">modelname (N)</p> ... </div>
    //     </div>
    //     ...
    //     <div> <button> Download </button> </div>  ← our target
    //   </div>

    let rowRoot = button.closest('.pb-3');
    if (!rowRoot) rowRoot = button.parentElement?.parentElement?.parentElement;

    let filename = null;
    let directory = null;

    // Find model name from the row header
    if (rowRoot) {
        const nameEl = rowRoot.querySelector('[title]');
        if (nameEl) {
            // Text is like "model.safetensors (2)" — strip the count
            const raw = nameEl.getAttribute('title') || nameEl.textContent.trim();
            filename = raw.replace(/\s*\(\d+\)\s*$/, '').trim();
        }
    }

    // Find directory from the category header above this row
    // MissingModelCard structure:
    //   <div class="px-4 pb-2">
    //     <div class="flex w-full flex-col border-t ...">  ← category group
    //       <div class="flex h-8 ..."> <p>checkpoints (N)</p> </div>  ← category header
    //       <div class="flex flex-col gap-1 ...">  ← rows container
    //         <MissingModelRow />  ← our row
    //       </div>
    //     </div>
    //   </div>
    const categoryGroup = button.closest('.border-t, [class*="border-interface-stroke"]');
    if (categoryGroup) {
        const headerP = categoryGroup.querySelector(':scope > div > p');
        if (headerP) {
            const catText = headerP.textContent.trim();
            // Text is like "checkpoints (3)" — strip the count
            directory = catText.replace(/\s*\(\d+\)\s*$/, '').trim();
        }
    }

    // Fallback: try to find the URL from a nearby element or the button's data
    let url = null;
    if (rowRoot) {
        // The URL might be in a hidden element or we can try to find it from
        // the model name + known URL patterns. But the frontend doesn't expose
        // the URL in the DOM directly in the new version.
        // We'll need to query the ComfyUI API for missing models to get URLs.
    }

    return { filename, directory, url };
}

// Query the ComfyUI backend for the list of missing models with their URLs
let cachedMissingModels = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5000; // 5 seconds

async function getMissingModels() {
    const now = Date.now();
    if (cachedMissingModels && (now - cacheTimestamp) < CACHE_TTL) {
        return cachedMissingModels;
    }
    try {
        // The missing model store data is available via the frontend's internal
        // state. We can access it through the Vue app's reactive state.
        // However, a simpler approach: intercept at the <a> tag level.
        cachedMissingModels = null;
        return null;
    } catch (e) {
        return null;
    }
}

// ── Primary interception: Monkey-patch document.createElement ──
// The frontend's downloadModel() for non-desktop creates an <a> tag, sets
// href to the model URL, and clicks it. We intercept this by patching
// createElement to detect model download <a> tags.
const originalCreateElement = document.createElement.bind(document);
let interceptEnabled = true;

document.createElement = function(tagName, options) {
    const el = originalCreateElement(tagName, options);

    if (tagName.toLowerCase() === 'a' && interceptEnabled) {
        // Wrap the click method to intercept model downloads
        const originalClick = el.click.bind(el);
        let clickIntercepted = false;

        el.click = function() {
            if (clickIntercepted) return;

            const href = el.href || el.getAttribute('href') || '';
            const download = el.download || el.getAttribute('download') || '';

            if (href && isModelDownloadUrl(href) && download) {
                clickIntercepted = true;
                console.log(`[AutoModelDownloader] Intercepted browser download: ${download} from ${href}`);

                // Parse filename and directory from the download attribute
                // download attr is set to model.name (e.g. "model.safetensors")
                const filename = download;

                // We need the directory (save_path). The frontend calls
                // downloadModel({ name, url, directory }, paths) where directory
                // is the folder_paths key like "checkpoints", "loras", etc.
                // We can try to extract it from the DOM context or use a
                // heuristic based on the URL.
                //
                // Better approach: hook into the downloadModel function itself.
                // But since we can't easily patch Vue internals, we'll use the
                // DOM context from the most recently clicked button.
                const directory = lastClickedDirectory || guessDirectoryFromUrl(href, filename);

                if (directory) {
                    console.log(`[AutoModelDownloader] Server download: ${directory}/${filename}`);
                    startServerDownload(href, directory, filename).then(result => {
                        if (result.success) {
                            showDownloadToast(filename, 'queued');
                        } else {
                            console.error(`[AutoModelDownloader] Server download failed: ${result.error}`);
                            showDownloadToast(filename, 'error', result.error);
                            // Fall back to browser download
                            interceptEnabled = false;
                            originalClick();
                            interceptEnabled = true;
                        }
                    });
                } else {
                    console.warn('[AutoModelDownloader] Could not determine directory, falling back to browser');
                    originalClick();
                }
                return;
            }

            originalClick();
        };
    }

    return el;
};

// Track the directory from the most recently clicked download button
let lastClickedDirectory = null;

function guessDirectoryFromUrl(url, filename) {
    // Common model type patterns in URLs
    const urlLower = url.toLowerCase();
    if (urlLower.includes('/lora') || urlLower.includes('lora')) return 'loras';
    if (urlLower.includes('/checkpoint') || urlLower.includes('checkpoint')) return 'checkpoints';
    if (urlLower.includes('/vae') || urlLower.includes('vae')) return 'vae';
    if (urlLower.includes('/controlnet') || urlLower.includes('controlnet')) return 'controlnet';
    if (urlLower.includes('/embedding') || urlLower.includes('embedding')) return 'embeddings';
    if (urlLower.includes('/upscale') || urlLower.includes('upscale')) return 'upscale_models';
    if (urlLower.includes('/unet') || urlLower.includes('unet')) return 'unet';
    if (urlLower.includes('/clip') || urlLower.includes('clip')) return 'clip';
    // Default to checkpoints for .safetensors/.ckpt files
    if (filename && (filename.endsWith('.safetensors') || filename.endsWith('.ckpt'))) return 'checkpoints';
    return null;
}

// ── Secondary interception: Watch for download buttons in the DOM ──
// This catches the "Download" and "Download all" buttons and adds context
// tracking so we know which directory each download belongs to.

function setupButtonObserver() {
    console.log('[AutoModelDownloader] Setting up button observer for new frontend');

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length === 0) continue;
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                processNewNode(node);
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Also process existing content
    setTimeout(() => processNewNode(document.body), 2000);
    setTimeout(() => processNewNode(document.body), 5000);
}

function processNewNode(root) {
    if (!root || !root.querySelectorAll) return;

    // Find all buttons that look like download buttons
    const buttons = root.querySelectorAll('button');
    for (const btn of buttons) {
        if (btn.dataset.autoModelPatched) continue;

        const text = btn.textContent.trim().toLowerCase();
        const hasDownloadIcon = btn.querySelector('[class*="icon-"][class*="download"]');

        // Per-model "Download" button
        if ((text.startsWith('download') && !text.includes('all')) && hasDownloadIcon) {
            patchSingleDownloadButton(btn);
        }

        // "Download all" button in the group header
        if (text.startsWith('download all')) {
            patchDownloadAllButton(btn);
        }
    }
}

function findDirectoryForButton(btn) {
    // Walk up to find the category group and extract directory name
    // The structure is: category group div > rows container > row > ... > button
    let el = btn.parentElement;
    const maxDepth = 15;
    let depth = 0;

    while (el && depth < maxDepth) {
        // Look for the category header pattern: a <p> with text like "checkpoints (3)"
        // that's inside a flex container at the top of a border-t group
        const categoryP = el.querySelector(':scope > div > p.font-medium');
        if (categoryP) {
            const catText = categoryP.textContent.trim();
            const directory = catText.replace(/\s*\(\d+\)\s*$/, '').trim();
            if (directory && !directory.includes(' ')) {
                return directory;
            }
        }
        el = el.parentElement;
        depth++;
    }
    return null;
}

function findModelNameForButton(btn) {
    // Walk up to the row root and find the model name
    let el = btn.parentElement;
    const maxDepth = 10;
    let depth = 0;

    while (el && depth < maxDepth) {
        const nameEl = el.querySelector('p[title]');
        if (nameEl) {
            const title = nameEl.getAttribute('title');
            if (title) return title;
            return nameEl.textContent.trim().replace(/\s*\(\d+\)\s*$/, '').trim();
        }
        el = el.parentElement;
        depth++;
    }
    return null;
}

function patchSingleDownloadButton(btn) {
    btn.dataset.autoModelPatched = 'true';

    btn.addEventListener('click', (e) => {
        const directory = findDirectoryForButton(btn);
        if (directory) {
            lastClickedDirectory = directory;
            console.log(`[AutoModelDownloader] Click context: directory=${directory}`);
        }
    }, true); // capture phase — runs before Vue's handler
}

function patchDownloadAllButton(btn) {
    btn.dataset.autoModelPatched = 'true';

    btn.addEventListener('click', (e) => {
        console.log('[AutoModelDownloader] "Download All" clicked — server downloads will be intercepted via <a> tag patching');
        // The <a> tag interception handles the actual routing.
        // We just log here for debugging.
    }, true);
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
// Listen for download events and show a floating progress indicator
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
        max-height: 400px; overflow-y: auto;
        display: none;
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
        if (item) {
            setTimeout(() => item?.remove(), 3000);
        }
        // Hide overlay if no more active downloads
        setTimeout(() => {
            if (container.children.length === 0) {
                overlay.style.display = 'none';
            }
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

    // Update overall counter
    const overall = document.getElementById('automodel-overall');
    if (overall && isDownloadingAll) {
        overall.textContent = `${completedDownloads}/${totalDownloads}`;
    }
});

// ── Extension registration ──
app.registerExtension({
    name: "ComfyUI.AutoModelDownloader",
    async setup() {
        console.log("[AutoModelDownloader] Extension setup — new frontend interception mode");
        setupButtonObserver();
        console.log("[AutoModelDownloader] Ready. Browser model downloads will be intercepted and routed to server.");
    }
});
