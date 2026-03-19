import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ComfyUI.AutoModelDownloader Extension
// Version: 3.1.0 — DOM-agnostic button injection
//
// v3.0.0 targeted the right-side panel DOM structure (border-interface
// category groups, p[title] elements). But the missing-model UI also
// renders as a popup dialog with a different, simpler DOM. Both views
// use the same Vue components (MissingModelRow.vue) internally.
//
// v3.1.0: Instead of matching specific CSS layout classes, we find
// download buttons by their icon class (icon-[lucide--download]) which
// exists in both the panel and dialog views. We walk up from each
// download button to the row component, use Vue introspection to get
// model data (url, directory, name), and inject a sibling server
// download button. This works regardless of the container layout.
console.log('[AutoModelDownloader] v3.1.0');

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

// ── Vue component introspection ──
// Walk up the DOM to find a Vue 3 component instance that has model data.
// Vue 3 attaches __vueParentComponent on the element that is the root of
// a component's template. We look for one whose props contain a `model`
// object with the download URL.
function findModelData(el) {
    let node = el;
    // Walk up at most 15 levels to find the MissingModelRow component
    for (let i = 0; i < 15 && node; i++) {
        // Vue 3 internal: __vueParentComponent on component root elements
        const vcomp = node.__vueParentComponent;
        if (vcomp) {
            const props = vcomp.props;
            if (props?.model) {
                // MissingModelRow has model.representative.url and model.representative.directory
                const rep = props.model.representative || props.model;
                const url = rep?.url || props.model?.url;
                const directory = rep?.directory || props.model?.directory || props.directory;
                const name = rep?.name || props.model?.name;
                if (url || name) {
                    return { url, directory, name };
                }
            }
        }
        // Also check for Vue 3 internal fiber keys (__vue_*, __vnode)
        if (node.__vue_app__ || node.__vnode) {
            // Root app node — skip
        } else {
            const keys = Object.getOwnPropertyNames(node);
            for (const key of keys) {
                if (!key.startsWith('__vue')) continue;
                try {
                    const val = node[key];
                    if (val?.props?.model) {
                        const rep = val.props.model.representative || val.props.model;
                        const url = rep?.url || val.props.model?.url;
                        const directory = rep?.directory || val.props.model?.directory || val.props?.directory;
                        const name = rep?.name || val.props.model?.name;
                        if (url || name) return { url, directory, name };
                    }
                    if (val?.proxy?.$props?.model) {
                        const m = val.proxy.$props.model;
                        const rep = m.representative || m;
                        return { url: rep?.url || m?.url, directory: rep?.directory || m?.directory, name: rep?.name || m?.name };
                    }
                } catch (_) { /* ignore */ }
            }
        }
        node = node.parentElement;
    }
    return null;
}

// ── DOM-agnostic model discovery ──
// Instead of matching specific panel layout classes, we find all download
// buttons by their icon class. MissingModelRow.vue renders:
//   <Button @click="handleDownload">
//     <template #icon><i class="icon-[lucide--download]" /></template>
//     Download
//   </Button>
//
// We find every <i> with class containing "icon-[lucide--download]" (or
// similar patterns), walk up to the <button>, then walk up further to
// find the row component and extract model data via Vue introspection.

function discoverModels() {
    const models = [];
    const seen = new Set();

    // Strategy 1: Find download icon elements
    // The icon class uses Iconify/UnoCSS format: icon-[lucide--download]
    // In the rendered DOM this becomes a CSS class. Query broadly.
    const downloadIcons = document.querySelectorAll(
        'i[class*="lucide--download"], i[class*="download"], span[class*="lucide--download"]'
    );

    for (const icon of downloadIcons) {
        // Walk up to the button
        const btn = icon.closest('button');
        if (!btn) continue;

        // Skip our own injected buttons
        if (btn.hasAttribute('data-automodel-server')) continue;

        // Walk up to find the row container and Vue model data
        const modelData = findModelData(btn);
        if (!modelData) continue;

        const key = `${modelData.directory}/${modelData.name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        models.push({
            url: modelData.url,
            directory: modelData.directory,
            filename: modelData.name,
            downloadButton: btn,  // The original download button — we inject next to it
        });
    }

    // Strategy 2: Fallback — find p[title] elements that look like model filenames
    // and walk up to find Vue data. This catches cases where the icon class
    // doesn't match our selector (e.g., different icon library version).
    if (models.length === 0) {
        const titleEls = document.querySelectorAll('p[title]');
        for (const el of titleEls) {
            const title = el.getAttribute('title');
            if (!title || !title.includes('.')) continue;
            // Looks like a filename (has extension)
            if (seen.has(title)) continue;

            const modelData = findModelData(el);
            if (!modelData) continue;

            const key = `${modelData.directory}/${modelData.name}`;
            if (seen.has(key)) continue;
            seen.add(key);

            // Find the nearest button to inject next to
            const row = el.closest('div');
            const nearestBtn = row?.querySelector('button:not([data-automodel-server])');

            models.push({
                url: modelData.url,
                directory: modelData.directory,
                filename: modelData.name || title,
                downloadButton: nearestBtn,
            });
        }
    }

    console.log(`[AutoModelDownloader] Discovered ${models.length} models`);
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
        display: inline-flex; align-items: center; gap: 4px;
        border-radius: 6px; background: #1a6b3c; color: #e0e0e0;
        border: 1px solid #2a8a4e; cursor: pointer; white-space: nowrap;
        transition: background 0.15s;
    `;
    if (size === 'sm') {
        btn.style.cssText = baseStyle + 'padding: 2px 8px; font-size: 12px; height: 28px;';
    } else {
        btn.style.cssText = baseStyle + 'padding: 6px 14px; font-size: 13px; height: 32px; font-weight: 500;';
    }
    btn.addEventListener('mouseenter', () => { btn.style.background = '#228b47'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#1a6b3c'; });
    return btn;
}

function injectServerButtons() {
    // Clean up stale buttons from previous renders
    document.querySelectorAll(`[${BUTTON_MARKER}]`).forEach(el => {
        if (!document.body.contains(el.parentElement)) el.remove();
    });

    const models = discoverModels();
    if (models.length === 0) return;

    let injectedCount = 0;

    for (const model of models) {
        if (!model.downloadButton) continue;

        // Skip if already injected next to this button
        const parent = model.downloadButton.parentElement;
        if (!parent) continue;
        if (parent.querySelector(`[${BUTTON_MARKER}]`)) continue;

        if (!model.url) {
            const btn = createServerButton('⬇ Server', () => {}, 'sm');
            btn.disabled = true;
            btn.style.opacity = '0.4';
            btn.style.cursor = 'not-allowed';
            btn.title = 'URL not available — use browser download';
            model.downloadButton.insertAdjacentElement('afterend', btn);
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

        // Insert right after the original download button
        model.downloadButton.insertAdjacentElement('afterend', btn);
        injectedCount++;
    }

    // Inject "Download All to Server" button
    injectDownloadAllServerButton(models);

    if (injectedCount > 0) {
        console.log(`[AutoModelDownloader] Injected ${injectedCount} server download buttons`);
    }
}

function injectDownloadAllServerButton(models) {
    // Find the existing "Download All" button (text match)
    let downloadAllBtn = null;
    for (const btn of document.querySelectorAll('button')) {
        const text = btn.textContent.trim().toLowerCase();
        if (text.includes('download all') && !btn.hasAttribute(BUTTON_MARKER)) {
            downloadAllBtn = btn;
            break;
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

// ── MutationObserver: watch for missing-model UI in any container ──
function setupPanelObserver() {
    console.log('[AutoModelDownloader] Setting up DOM observer');

    let injectTimeout = null;
    function scheduleInject() {
        if (injectTimeout) clearTimeout(injectTimeout);
        injectTimeout = setTimeout(() => injectServerButtons(), 300);
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length === 0) continue;
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                // Trigger on any DOM addition that looks like it could contain
                // model rows: download icons, p[title] elements, or "Download All" text
                if (node.querySelector && (
                    node.querySelector('i[class*="download"]') ||
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

    // Also inject on initial load after delays (panel/dialog may already be open)
    setTimeout(scheduleInject, 2000);
    setTimeout(scheduleInject, 5000);
}

// ── Extension registration ──
app.registerExtension({
    name: "ComfyUI.AutoModelDownloader",
    async setup() {
        console.log("[AutoModelDownloader] Extension setup — v3.1.0 DOM-agnostic buttons");
        setupPanelObserver();
        console.log("[AutoModelDownloader] Ready. Server download buttons will appear next to missing models.");
    }
});
