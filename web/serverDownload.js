import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ComfyUI.AutoModelDownloader Extension
// Version: 3.0.0 — Explicit "Server Download" buttons (no interception)
//
// Previous versions (v1–v2) monkey-patched document.createElement to
// intercept <a> tag clicks from the Vue frontend's downloadModel().
// This caused race conditions ("Download All" first model falling through
// to browser) and was fragile against frontend updates.
//
// v3.0.0: Injects explicit "⬇ Server" buttons next to each model's
// existing controls, plus a "Download All to Server" button. No
// interception of the original download flow — browser downloads still
// work as-is for users who want them.
console.log('[AutoModelDownloader] v3.0.0');

// ── Download state tracking ──
const downloadStates = new Map();
const downloadStartTimes = new Map();
let serverDownloadAllActive = false;
let serverDownloadAllCompleted = 0;
let serverDownloadAllTotal = 0;

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
    if (serverDownloadAllActive) {
        serverDownloadAllCompleted++;
    }
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
        if (response.ok) {
            return { success: true, download_id };
        }
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

// ── DOM scraping: extract model info from the missing-model panel ──
// MissingModelCard.vue renders:
//   <div class="border-t border-interface-stroke ...">     ← category group
//     <p class="font-medium">diffusion_models (5)</p>      ← directory header
//     <div class="pl-2">                                   ← model rows container
//       <MissingModelRow :model :directory />
//         → <div class="flex w-full flex-col pb-3">
//             <div class="flex h-8 ...">
//               <p title="model.safetensors" class="font-medium">model.safetensors (2)</p>
//               ... buttons ...
//             </div>
//
// MissingModelRow doesn't render the download URL in the DOM — it's only
// in Vue's reactive state. But the upstream downloadModel() reads it from
// the model object which has { name, url, directory }. We can't access
// Vue internals, so we extract the URL from the "Copy URL" button or
// from the model's HuggingFace/Civitai link if present.
//
// Strategy: We find each model row's p[title] for the filename, walk up
// to the category group for the directory, and look for a URL source.

function scrapeModelsFromPanel() {
    const models = [];

    // Find category groups: divs with border-t + border-interface classes
    const groups = document.querySelectorAll(
        '[class*="border-t"][class*="border-interface"]'
    );

    for (const group of groups) {
        // Extract directory from header: "diffusion_models (5)" → "diffusion_models"
        const headerP = group.querySelector(
            ':scope > div > p[class*="font-medium"], :scope > div > p.font-medium'
        );
        if (!headerP) continue;

        const catText = headerP.textContent.trim();
        const directory = catText.replace(/\s*\(\d+\)\s*$/, '').trim();
        if (!directory || directory.includes(' ')) continue;

        // Find model rows within this group
        const titleEls = group.querySelectorAll('p[title]');
        for (const el of titleEls) {
            const filename = el.getAttribute('title');
            if (!filename || !filename.includes('.')) continue;

            // Try to find the URL: look for a nearby link or the Vue component's
            // __vueParentComponent which holds the model prop
            let url = null;

            // Method 1: Walk up to the MissingModelRow root and check Vue internals
            let rowRoot = el.closest('.pb-3') || el.closest('[class*="pb-3"]');
            if (rowRoot) {
                // Vue 3 exposes component data on __vueParentComponent
                const vueNode = findVueComponent(rowRoot);
                if (vueNode?.props?.model?.representative?.url) {
                    url = vueNode.props.model.representative.url;
                } else if (vueNode?.props?.model?.url) {
                    url = vueNode.props.model.url;
                }
            }

            // Method 2: Look for a "Copy URL" button sibling and extract from clipboard handler
            // (fallback — less reliable)
            if (!url && rowRoot) {
                const buttons = rowRoot.querySelectorAll('button');
                for (const btn of buttons) {
                    const btnText = btn.textContent.trim().toLowerCase();
                    if (btnText.includes('copy') && btnText.includes('url')) {
                        // The URL is passed to copyToClipboard — we can't intercept that,
                        // but we can try the Vue component approach on the button
                        const btnVue = findVueComponent(btn);
                        if (btnVue?.props?.onClick) {
                            // Can't easily extract — skip
                        }
                    }
                }
            }

            models.push({ filename, directory, url, rowElement: rowRoot });
        }
    }

    return models;
}

// Walk up the DOM to find a Vue 3 component instance
function findVueComponent(el) {
    let node = el;
    while (node) {
        if (node.__vueParentComponent) return node.__vueParentComponent;
        if (node._vnode?.component) return node._vnode.component;
        // Vue 3 internal: __vue_app__ on root, __vnode on elements
        const keys = Object.keys(node);
        for (const key of keys) {
            if (key.startsWith('__vue')) {
                const val = node[key];
                if (val?.props?.model) return val;
                if (val?.proxy?.$props?.model) return { props: val.proxy.$props };
            }
        }
        node = node.parentElement;
    }
    return null;
}

// ── Button injection ──
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

    if (size === 'sm') {
        // Small icon-style button for individual model rows
        btn.style.cssText = `
            display: inline-flex; align-items: center; gap: 4px;
            padding: 2px 8px; border-radius: 6px; font-size: 12px;
            background: #1a6b3c; color: #e0e0e0; border: 1px solid #2a8a4e;
            cursor: pointer; white-space: nowrap; height: 28px;
            transition: background 0.15s;
        `;
        btn.addEventListener('mouseenter', () => { btn.style.background = '#228b47'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = '#1a6b3c'; });
    } else {
        // Larger button for "Download All to Server"
        btn.style.cssText = `
            display: inline-flex; align-items: center; gap: 6px;
            padding: 6px 14px; border-radius: 8px; font-size: 13px;
            background: #1a6b3c; color: #e0e0e0; border: 1px solid #2a8a4e;
            cursor: pointer; white-space: nowrap; height: 32px;
            font-weight: 500; transition: background 0.15s;
        `;
        btn.addEventListener('mouseenter', () => { btn.style.background = '#228b47'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = '#1a6b3c'; });
    }

    return btn;
}

function injectServerButtons() {
    // Skip if already injected (check for our marker)
    const existing = document.querySelectorAll(`[${BUTTON_MARKER}]`);
    // Clean up stale buttons from previous renders
    existing.forEach(el => {
        if (!document.body.contains(el.parentElement)) el.remove();
    });

    const models = scrapeModelsFromPanel();
    if (models.length === 0) return;

    let injectedCount = 0;

    // Inject per-model "⬇ Server" buttons
    for (const model of models) {
        if (!model.rowElement) continue;

        // Find the button row (first child div with flex + h-8)
        const buttonRow = model.rowElement.querySelector('.flex.h-8, [class*="flex"][class*="h-8"]');
        if (!buttonRow) continue;

        // Skip if already injected
        if (buttonRow.querySelector(`[${BUTTON_MARKER}]`)) continue;

        if (!model.url) {
            // No URL available — inject a disabled button with tooltip
            const btn = createServerButton('⬇ Server', () => {}, 'sm');
            btn.disabled = true;
            btn.style.opacity = '0.4';
            btn.style.cursor = 'not-allowed';
            btn.title = 'URL not available — use browser download';
            // Insert before the expand chevron (last button)
            const lastBtn = buttonRow.querySelector('button:last-of-type');
            if (lastBtn) {
                buttonRow.insertBefore(btn, lastBtn);
            } else {
                buttonRow.appendChild(btn);
            }
            injectedCount++;
            continue;
        }

        const btn = createServerButton('⬇ Server', async (btnEl) => {
            btnEl.disabled = true;
            btnEl.textContent = '⏳ Queued';
            btnEl.style.opacity = '0.7';

            const result = await startServerDownload(model.url, model.directory, model.filename);
            if (result.success) {
                btnEl.textContent = '✓ Downloading';
                btnEl.style.background = '#1565c0';
                showDownloadToast(model.filename, 'queued');
            } else {
                btnEl.textContent = '✗ Failed';
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

        // Insert before the expand chevron
        const lastBtn = buttonRow.querySelector('button:last-of-type');
        if (lastBtn) {
            buttonRow.insertBefore(btn, lastBtn);
        } else {
            buttonRow.appendChild(btn);
        }
        injectedCount++;
    }

    // Inject "Download All to Server" button near the existing "Download All"
    injectDownloadAllServerButton(models);

    if (injectedCount > 0) {
        console.log(`[AutoModelDownloader] Injected ${injectedCount} server download buttons`);
    }
}

function injectDownloadAllServerButton(models) {
    // Find the existing "Download All" button
    const allButtons = document.querySelectorAll('button');
    let downloadAllBtn = null;
    for (const btn of allButtons) {
        const text = btn.textContent.trim().toLowerCase();
        if (text.includes('download all') && !btn.hasAttribute(BUTTON_MARKER)) {
            downloadAllBtn = btn;
            break;
        }
    }

    if (!downloadAllBtn) return;

    // Check if we already injected next to it
    const parent = downloadAllBtn.parentElement;
    if (!parent) return;
    if (parent.querySelector(`[${BUTTON_MARKER}="download-all"]`)) return;

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

            // Update button as downloads complete
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

    // Insert after the existing Download All button
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
    if (overall && serverDownloadAllActive) {
        overall.textContent = `${serverDownloadAllCompleted}/${serverDownloadAllTotal}`;
    }
});

// ── MutationObserver: watch for the missing-model panel and inject buttons ──
function setupPanelObserver() {
    console.log('[AutoModelDownloader] Setting up panel observer');

    // Debounce injection to avoid hammering during rapid DOM updates
    let injectTimeout = null;
    function scheduleInject() {
        if (injectTimeout) clearTimeout(injectTimeout);
        injectTimeout = setTimeout(() => {
            injectServerButtons();
        }, 300);
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length === 0) continue;
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                // Check if this looks like missing-model panel content
                if (node.querySelector && (
                    node.querySelector('p[title]') ||
                    node.querySelector('[class*="border-interface"]') ||
                    (node.textContent && node.textContent.includes('Download All'))
                )) {
                    scheduleInject();
                    break;
                }
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Also inject on initial load after delays (panel may already be open)
    setTimeout(scheduleInject, 2000);
    setTimeout(scheduleInject, 5000);
}

// ── Extension registration ──
app.registerExtension({
    name: "ComfyUI.AutoModelDownloader",
    async setup() {
        console.log("[AutoModelDownloader] Extension setup — v3.0.0 explicit server buttons");
        setupPanelObserver();
        console.log("[AutoModelDownloader] Ready. Server download buttons will appear next to missing models.");
    }
});
