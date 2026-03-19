import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ComfyUI.AutoModelDownloader Extension
// Version: 2.2.0 — Fixed first-model browser fallback during "Download All"
//
// v2.1.0 fix: Build a filename→directory lookup by scraping the missing
// model panel's category headers BEFORE any downloads start.
//
// v2.2.0 fix: "Download All" first model fell through to browser download
// because the capture-phase listener that pre-builds the directory map
// could fire after Vue's handler already called downloadModel() for the
// first item. Fix: build the map eagerly whenever the missing-model panel
// DOM appears (MutationObserver), so it's always warm before any click.
console.log('[AutoModelDownloader] v2.2.0');

// ── State ──
const downloadStates = new Map();
let isDownloadingAll = false;
let completedDownloads = 0;
let totalDownloads = 0;
const downloadStartTimes = new Map();

// ── filename→directory lookup built from the DOM ──
let modelDirectoryMap = new Map();

function buildModelDirectoryMap() {
    const map = new Map();

    // Strategy 1: Find category groups by border-t + border-interface classes
    // MissingModelCard renders each directory as a group with these classes
    const groups = document.querySelectorAll('[class*="border-t"][class*="border-interface"]');
    for (const group of groups) {
        const headerP = group.querySelector(':scope > div > p.font-medium, :scope > div > p[class*="font-medium"]');
        if (!headerP) continue;

        const catText = headerP.textContent.trim();
        // "checkpoints (3)" or "diffusion_models (5)" → strip count
        const directory = catText.replace(/\s*\(\d+\)\s*$/, '').trim();
        if (!directory || directory.includes(' ')) continue;

        const titleEls = group.querySelectorAll('p[title]');
        for (const el of titleEls) {
            const title = el.getAttribute('title');
            if (title && title.includes('.')) {
                map.set(title, directory);
            }
        }
    }

    // Strategy 2: Broader search if Strategy 1 found nothing
    if (map.size === 0) {
        const allPs = document.querySelectorAll('p.font-medium, p[class*="font-medium"]');
        for (const p of allPs) {
            const catText = p.textContent.trim();
            const match = catText.match(/^([a-z_]+)\s*\(\d+\)$/);
            if (!match) continue;
            const directory = match[1];

            let container = p.parentElement?.parentElement;
            if (!container) continue;

            const titleEls = container.querySelectorAll('p[title]');
            for (const el of titleEls) {
                const title = el.getAttribute('title');
                if (title && title.includes('.')) {
                    map.set(title, directory);
                }
            }
        }
    }

    if (map.size > 0) {
        console.log(`[AutoModelDownloader] Built directory map: ${map.size} models`);
    }

    modelDirectoryMap = map;
    return map;
}

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

// ── Primary interception: Monkey-patch document.createElement ──
// The frontend's downloadModel() creates an <a> tag with href=url and
// download=filename, then clicks it. We intercept the click to route
// through our server download API instead.
//
// Key fix in v2.1.0: We resolve the directory (save_path) from our
// modelDirectoryMap which is built by scraping the missing model panel,
// NOT from URL heuristics.
const originalCreateElement = document.createElement.bind(document);
let interceptEnabled = true;

document.createElement = function(tagName, options) {
    const el = originalCreateElement(tagName, options);

    if (tagName.toLowerCase() === 'a' && interceptEnabled) {
        const originalClick = el.click.bind(el);
        let clickIntercepted = false;

        el.click = function() {
            if (clickIntercepted) return;

            const href = el.href || el.getAttribute('href') || '';
            const download = el.download || el.getAttribute('download') || '';

            if (href && isModelDownloadUrl(href) && download) {
                clickIntercepted = true;
                const filename = download;

                // v2.1.0: Look up directory from our pre-built map first
                // Rebuild the map on every intercept to catch dynamic DOM changes
                buildModelDirectoryMap();
                let directory = modelDirectoryMap.get(filename);

                if (!directory) {
                    // Fallback: try partial match (filename without path prefix)
                    const baseName = filename.split('/').pop();
                    directory = modelDirectoryMap.get(baseName);
                }

                if (!directory) {
                    // Last resort: URL heuristic (kept for edge cases)
                    directory = guessDirectoryFromUrl(href, filename);
                }

                if (directory) {
                    console.log(`[AutoModelDownloader] Intercepted: ${directory}/${filename} (from ${href})`);
                    startServerDownload(href, directory, filename).then(result => {
                        if (result.success) {
                            showDownloadToast(filename, 'queued');
                        } else {
                            console.error(`[AutoModelDownloader] Server download failed: ${result.error}`);
                            showDownloadToast(filename, 'error', result.error);
                            interceptEnabled = false;
                            originalClick();
                            interceptEnabled = true;
                        }
                    });
                } else {
                    console.warn('[AutoModelDownloader] Could not determine directory for', filename, '- falling back to browser');
                    originalClick();
                }
                return;
            }

            originalClick();
        };
    }

    return el;
};

function guessDirectoryFromUrl(url, filename) {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('/lora') || urlLower.includes('lora')) return 'loras';
    if (urlLower.includes('/checkpoint') || urlLower.includes('checkpoint')) return 'checkpoints';
    if (urlLower.includes('/vae') || urlLower.includes('vae')) return 'vae';
    if (urlLower.includes('/controlnet') || urlLower.includes('controlnet')) return 'controlnet';
    if (urlLower.includes('/embedding') || urlLower.includes('embedding')) return 'embeddings';
    if (urlLower.includes('/upscale') || urlLower.includes('upscale')) return 'upscale_models';
    if (urlLower.includes('/unet') || urlLower.includes('unet')) return 'unet';
    if (urlLower.includes('/clip') || urlLower.includes('clip')) return 'clip';
    if (urlLower.includes('/text_encoder') || urlLower.includes('text_encoder')) return 'text_encoders';
    if (urlLower.includes('/diffusion_model') || urlLower.includes('diffusion_model')) return 'diffusion_models';
    // No more default to checkpoints — return null to force browser fallback
    return null;
}

// ── Secondary: Watch for download buttons to pre-build the map ──
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

    // Process existing content after a delay
    setTimeout(() => processNewNode(document.body), 2000);
    setTimeout(() => processNewNode(document.body), 5000);
}

function processNewNode(root) {
    if (!root || !root.querySelectorAll) return;

    // Eagerly rebuild the directory map whenever new DOM content appears
    // that looks like the missing-model panel. This ensures the map is warm
    // BEFORE any download button is clicked — fixing the race where the
    // first "Download All" model fell through to browser download.
    const hasTitlePs = root.querySelector ? root.querySelector('p[title]') : null;
    if (hasTitlePs) {
        buildModelDirectoryMap();
    }

    const buttons = root.querySelectorAll('button');
    for (const btn of buttons) {
        if (btn.dataset.autoModelPatched) continue;

        const text = btn.textContent.trim().toLowerCase();
        const hasDownloadIcon = btn.querySelector('[class*="icon-"][class*="download"]');

        if ((text.startsWith('download') && !text.includes('all')) && hasDownloadIcon) {
            patchSingleDownloadButton(btn);
        }

        if (text.startsWith('download all')) {
            patchDownloadAllButton(btn);
        }
    }
}

function patchSingleDownloadButton(btn) {
    btn.dataset.autoModelPatched = 'true';
    // Pre-build the map when any download button appears
    buildModelDirectoryMap();
}

function patchDownloadAllButton(btn) {
    btn.dataset.autoModelPatched = 'true';

    btn.addEventListener('click', (e) => {
        // Pre-build the map right before "Download All" triggers
        buildModelDirectoryMap();
        console.log('[AutoModelDownloader] "Download All" clicked — directory map has', modelDirectoryMap.size, 'entries');
    }, true); // capture phase — runs before Vue's handler
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

    const overall = document.getElementById('automodel-overall');
    if (overall && isDownloadingAll) {
        overall.textContent = `${completedDownloads}/${totalDownloads}`;
    }
});

// ── Extension registration ──
app.registerExtension({
    name: "ComfyUI.AutoModelDownloader",
    async setup() {
        console.log("[AutoModelDownloader] Extension setup — v2.2.0 with eager directory map");
        setupButtonObserver();
        console.log("[AutoModelDownloader] Ready. Browser model downloads will be intercepted and routed to server.");
    }
});
