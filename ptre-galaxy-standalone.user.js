// ==UserScript==
// @name         PTRE Galaxy Local Panel
// @namespace    https://openuserjs.org/users/GeGe_GM
// @version      0.7.30
// @description  Local panel with targets + activity history (IndexedDB).
// @match        https://*.ogame.gameforge.com/game/*
// @match        https://lobby.ogame.gameforge.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    const PANEL_ID = 'ptreLocalPanel';
    const STATUS_ID = 'ptreLocalStatus';
    const OPEN_ID = 'ptreLocalOpenHistory';
    const ICON_CLASS = 'ptreLocalPlayerIcon';
    const ICON_TARGET_CLASS = 'ptreLocalPlayerIconTarget';
    const KEY_TARGETS = 'ptreLocalTargets';
    const TARGET_SELECT_ID = 'ptreLocalTargetSelect';
    const TARGET_COORDS_ID = 'ptreLocalTargetCoords';
    const KEY_CLEANED = 'ptreLocalCleanedUnknowns';
    const KEY_LAST_TARGET = 'ptreLocalLastTarget';
    const KEY_SCAN_SPEED = 'ptreLocalScanSpeed';
    const KEY_CONTINUOUS_INTERVAL = 'ptreLocalContinuousInterval';
    const KEY_CONTINUOUS_ACTIVE = 'ptreLocalContinuousActive';
    const KEY_EXECUTE_ON_SLAVE = 'ptreLocalExecuteOnSlave';
    const KEY_LAST_REMOTE_CMD = 'ptreLocalLastRemoteCmd';
    const KEY_SYNC_MODE = 'ptreLocalSyncMode';
    const KEY_SYNC_ENDPOINT = 'ptreLocalSyncEndpoint';
    const KEY_SYNC_TOKEN = 'ptreLocalSyncToken';
    const SCAN_SPEED_ID = 'ptreLocalScanSpeed';
    const CONTINUOUS_INTERVAL_ID = 'ptreLocalContinuousInterval';
    const SCAN_START_ID = 'ptreLocalScanStart';
    const SCAN_CONTINUOUS_ID = 'ptreLocalScanContinuous';
    const SCAN_STOP_ID = 'ptreLocalScanStop';
    const SYNC_CONFIG_ID = 'ptreLocalSyncConfig';
    const SYNC_STATUS_ID = 'ptreLocalSyncStatus';
    const EXECUTE_SLAVE_ID = 'ptreLocalExecuteOnSlave';

    const DB_NAME = 'ptreLocalActivityDB';
    const DB_VERSION = 3;
    const STORE_PLAYERS = 'players';
    const STORE_BUCKETS = 'buckets';
    const BUCKET_MS = 5 * 60 * 1000;
    const DEFAULT_RANGE_HOURS = 24;
    const GALAXY_LOAD_TIMEOUT_MS = 15000;
    const RELOAD_DELAY_MS = 1500;
    const LOBBY_START_DELAY_MS = 10000;
    const LOBBY_AUTOCLICK_MAX_MS = 30000;
    const LOBBY_POST_CLICK_WAIT_MS = 10000;
    const LOBBY_PANEL_ID = 'ptreLobbyPanel';
    const LOBBY_STATUS_ID = 'ptreLobbyStatusLine';
    const LOBBY_GAME_URL_RE = /\/game\/|page=ingame/i;
    const LOBBY_TEXT_MATCHERS = [
        ['jugado', 'ultima', 'vez'],
        ['ultimo', 'servidor', 'jugado'],
        ['last', 'played']
    ];

    // Sync host/slave defaults for targets. Real values are loaded from GM storage per machine.
    const DEFAULT_SYNC_MODE = 'off'; // off | host | slave
    const DEFAULT_SYNC_ENDPOINT = ''; // Example: http://YOUR_VPS_IP:8787/targets
    const DEFAULT_SYNC_TOKEN = ''; // Must match X-PTRE-Token expected by your VPS endpoint.
    const SYNC_PULL_INTERVAL_MS = 5000;
    const SYNC_PUSH_DEBOUNCE_MS = 700;
    const SYNC_ACTIVITY_PUSH_DEBOUNCE_MS = 1000;
    const SYNC_ACTIVITY_BATCH_SIZE = 80;
    const SYNC_ACTIVITY_MAX_QUEUE = 1000;
    const SYNC_HTTP_TIMEOUT_MS = 10000;
    const SYNC_TOKEN_HEADER = 'x-ptre-token';
    const HISTORY_BRIDGE_REQUEST = 'ptreLocalHistoryRemoteRequest';
    const HISTORY_BRIDGE_RESPONSE = 'ptreLocalHistoryRemoteResponse';
    const HISTORY_BRIDGE_TIMEOUT_MS = 12000;

    const isLobby = location.hostname === 'lobby.ogame.gameforge.com' || /\/lobby/i.test(location.pathname);
    if (isLobby) {
        initLobbyAutoClick();
        return;
    }
    const isGalaxy = /component=galaxy/.test(location.href);
    const isIngameRoot = /page=ingame/.test(location.search || '') && !isGalaxy;
    // Only auto-open galaxy if continuous scan was active before reload.
    const shouldAutoOpenGalaxy = Boolean(GM_getValue(KEY_CONTINUOUS_ACTIVE, false));
    if (isIngameRoot && shouldAutoOpenGalaxy) {
        initIngameAutoGalaxy();
    }

    let lastGalaxy = null;
    let lastSystem = null;
    let dbPromise = null;
    let dbQueue = Promise.resolve();
    let scanActive = false;
    let continuousActive = false;
    let scanQueue = [];
    let scanIndex = 0;
    let scanPending = false;
    let scanTimer = null;
    let continuousTimer = null;
    let scanDelayMs = Number(GM_getValue(KEY_SCAN_SPEED, 1000));
    let continuousIntervalMs = Number(GM_getValue(KEY_CONTINUOUS_INTERVAL, 60000));
    let resumeContinuous = Boolean(GM_getValue(KEY_CONTINUOUS_ACTIVE, false));
    let resumeContinuousDone = false;
    let galaxyLoadTimeoutId = null;
    let scanPendingSince = 0;
    let scanWatchdogId = null;
    let reloadScheduled = false;
    let executeOnSlave = Boolean(GM_getValue(KEY_EXECUTE_ON_SLAVE, false));
    let remoteScanPlan = null;
    let lastRemoteCmdId = String(GM_getValue(KEY_LAST_REMOTE_CMD, '') || '');
    let syncMode = normalizeSyncMode(String(GM_getValue(KEY_SYNC_MODE, DEFAULT_SYNC_MODE) || DEFAULT_SYNC_MODE));
    let syncEndpoint = String(GM_getValue(KEY_SYNC_ENDPOINT, DEFAULT_SYNC_ENDPOINT) || DEFAULT_SYNC_ENDPOINT).trim();
    let syncToken = String(GM_getValue(KEY_SYNC_TOKEN, DEFAULT_SYNC_TOKEN) || DEFAULT_SYNC_TOKEN).trim();
    let syncPullTimer = null;
    let syncPullInFlight = false;
    let syncPushTimer = null;
    let syncPushInFlight = false;
    let syncPendingTargets = null;
    let syncActivityPushTimer = null;
    let syncActivityPushInFlight = false;
    let syncPendingActivity = [];
    let syncLastRemoteUpdatedAt = 0;
    let syncLastRemoteSerialized = '';
    let syncOnline = false;
    let syncLastError = '';
    let historyBridgeBound = false;

    function addStyles() {
        GM_addStyle(`
#${PANEL_ID} {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 10050;
    background: #171d22;
    border: 2px solid #000;
    color: #d7dee5;
    font: 12px/1.4 "Courier New", monospace;
    padding: 8px 10px;
    min-width: 240px;
    box-shadow: 0 8px 20px rgba(0,0,0,0.4);
}
#${PANEL_ID} .ptreLocalTitle {
    font-weight: bold;
    color: #ff4d4d;
    margin-bottom: 6px;
}
#${PANEL_ID} .ptreLocalActions {
    margin-top: 6px;
}
#${PANEL_ID} .ptreLocalSyncStatus {
    margin-top: 4px;
    color: #ffd166;
}
#${PANEL_ID} .ptreLocalSyncStatus.ok {
    color: #9ccf5f;
}
#${PANEL_ID} .ptreLocalSyncStatus.error {
    color: #ff4d4d;
}
#${PANEL_ID} .ptreLocalButton {
    cursor: pointer;
    background: #25303a;
    color: #d7dee5;
    border: 1px solid #000;
    padding: 2px 6px;
    font: 12px/1.4 "Courier New", monospace;
}
#${PANEL_ID} .ptreLocalSection {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid #000;
}
#${PANEL_ID} .ptreLocalSectionTitle {
    color: #6f9fc8;
    margin-bottom: 4px;
    font-weight: bold;
}
#${PANEL_ID} select {
    width: 100%;
    background: #171d22;
    color: #d7dee5;
    border: 1px solid #000;
    padding: 2px 4px;
}
#${PANEL_ID} .ptreLocalCoords {
    margin-top: 6px;
}
#${PANEL_ID} .ptreLocalCoordButton {
    display: block;
    margin: 4px 0;
    padding: 2px 6px;
    border: 1px solid #000;
    background: #25303a;
    color: #d7dee5;
    cursor: pointer;
}
#${PANEL_ID} .ptreLocalRow {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 6px;
}
#${PANEL_ID} .ptreLocalRow select {
    flex: 1 1 auto;
}
#${PANEL_ID} .ptreLocalToggle {
    margin-top: 6px;
}
#${PANEL_ID} .ptreLocalToggle label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
}
#${PANEL_ID} .ptreLocalToggle input[type="checkbox"] {
    margin: 0;
}
.${ICON_CLASS} {
    display: inline-block;
    width: 10px;
    height: 10px;
    margin-left: 4px;
    border-radius: 50%;
    background: #9ccf5f;
    border: 1px solid #000;
    vertical-align: middle;
    cursor: pointer;
}
.${ICON_TARGET_CLASS} {
    background: #d43635;
}
        `);
    }

    function ensurePanel() {
        if (!document.body) {
            return null;
        }
        let panel = document.getElementById(PANEL_ID);
        if (panel) {
            return panel;
        }
        addStyles();
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="ptreLocalTitle">Panel Local</div>
            <div id="${STATUS_ID}">Listo</div>
            <div class="ptreLocalActions">
                <button id="${OPEN_ID}" class="ptreLocalButton">Abrir historial</button>
                <button id="${SYNC_CONFIG_ID}" class="ptreLocalButton">Sync: off</button>
            </div>
            <div id="${SYNC_STATUS_ID}" class="ptreLocalSyncStatus">Sync: off</div>
            <div class="ptreLocalSection">
                <div class="ptreLocalSectionTitle">Objetivos</div>
                <select id="${TARGET_SELECT_ID}">
                    <option value="">-- Selecciona --</option>
                </select>
                <div id="${TARGET_COORDS_ID}" class="ptreLocalCoords"></div>
                <div class="ptreLocalRow">
                    <span>Velocidad</span>
                    <select id="${SCAN_SPEED_ID}">
                        <option value="1000">1s</option>
                        <option value="2000">2s</option>
                        <option value="3000">3s</option>
                        <option value="4000">4s</option>
                        <option value="5000">5s</option>
                    </select>
                </div>
                <div class="ptreLocalRow">
                    <span>Continuo</span>
                    <select id="${CONTINUOUS_INTERVAL_ID}">
                        <option value="60000">1 min</option>
                        <option value="300000">5 min</option>
                        <option value="600000">10 min</option>
                        <option value="900000">15 min</option>
                        <option value="1800000">30 min</option>
                        <option value="3600000">60 min</option>
                    </select>
                </div>
                <div class="ptreLocalRow">
                    <button id="${SCAN_START_ID}" class="ptreLocalButton">Recorrer</button>
                    <button id="${SCAN_CONTINUOUS_ID}" class="ptreLocalButton">Continuo</button>
                    <button id="${SCAN_STOP_ID}" class="ptreLocalButton">Parar</button>
                </div>
                <div class="ptreLocalToggle">
                    <label>
                        <input id="${EXECUTE_SLAVE_ID}" type="checkbox">
                        Ejecutar en esclavo
                    </label>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        const openBtn = document.getElementById(OPEN_ID);
        if (openBtn) {
            openBtn.addEventListener('click', openHistoryWindow);
        }
        const syncConfigBtn = document.getElementById(SYNC_CONFIG_ID);
        if (syncConfigBtn && !syncConfigBtn.dataset.bound) {
            syncConfigBtn.dataset.bound = 'true';
            syncConfigBtn.addEventListener('click', configureSyncSettings);
        }
        const executeSlaveToggle = document.getElementById(EXECUTE_SLAVE_ID);
        if (executeSlaveToggle) {
            executeSlaveToggle.checked = Boolean(executeOnSlave);
            executeSlaveToggle.disabled = !isSyncHost();
            if (!executeSlaveToggle.dataset.bound) {
                executeSlaveToggle.dataset.bound = 'true';
                executeSlaveToggle.addEventListener('change', () => {
                    executeOnSlave = Boolean(executeSlaveToggle.checked);
                    GM_setValue(KEY_EXECUTE_ON_SLAVE, executeOnSlave);
                });
            }
        }
        updateSyncButtonLabel();
        renderSyncStatus();
        const targetSelect = document.getElementById(TARGET_SELECT_ID);
        if (targetSelect && !targetSelect.dataset.bound) {
            targetSelect.dataset.bound = 'true';
            targetSelect.addEventListener('change', () => {
                GM_setValue(KEY_LAST_TARGET, targetSelect.value || '');
                showCoordsForPlayer(targetSelect.value);
            });
        }
        const speedSelect = document.getElementById(SCAN_SPEED_ID);
        if (speedSelect) {
            const current = clampSpeed(scanDelayMs);
            speedSelect.value = String(current);
            if (!speedSelect.dataset.bound) {
                speedSelect.dataset.bound = 'true';
                speedSelect.addEventListener('change', () => {
                    const val = clampSpeed(Number(speedSelect.value));
                    scanDelayMs = val;
                    GM_setValue(KEY_SCAN_SPEED, val);
                });
            }
        }
        const intervalSelect = document.getElementById(CONTINUOUS_INTERVAL_ID);
        if (intervalSelect) {
            const currentInterval = clampInterval(continuousIntervalMs);
            intervalSelect.value = String(currentInterval);
            if (!intervalSelect.dataset.bound) {
                intervalSelect.dataset.bound = 'true';
                intervalSelect.addEventListener('change', () => {
                    const val = clampInterval(Number(intervalSelect.value));
                    continuousIntervalMs = val;
                    GM_setValue(KEY_CONTINUOUS_INTERVAL, val);
                });
            }
        }
        const startBtn = document.getElementById(SCAN_START_ID);
        if (startBtn && !startBtn.dataset.bound) {
            startBtn.dataset.bound = 'true';
            startBtn.addEventListener('click', () => {
                if (isSyncSlave()) {
                    setStatus('Modo esclava: controlado por master');
                    return;
                }
                if (executeOnSlave) {
                    sendRemoteScanCommand(false);
                    return;
                }
                startScan(false);
            });
        }
        const continuousBtn = document.getElementById(SCAN_CONTINUOUS_ID);
        if (continuousBtn && !continuousBtn.dataset.bound) {
            continuousBtn.dataset.bound = 'true';
            continuousBtn.addEventListener('click', () => {
                if (isSyncSlave()) {
                    setStatus('Modo esclava: controlado por master');
                    return;
                }
                if (executeOnSlave) {
                    sendRemoteScanCommand(true);
                    return;
                }
                startScan(true);
            });
        }
        const stopBtn = document.getElementById(SCAN_STOP_ID);
        if (stopBtn && !stopBtn.dataset.bound) {
            stopBtn.dataset.bound = 'true';
            stopBtn.addEventListener('click', () => {
                if (isSyncSlave()) {
                    setStatus('Modo esclava: controlado por master');
                    return;
                }
                if (executeOnSlave) {
                    sendRemoteStopCommand();
                    return;
                }
                GM_setValue(KEY_CONTINUOUS_ACTIVE, false);
                stopScan('Recorrido detenido');
            });
        }
        return panel;
    }

    function setStatus(message) {
        ensurePanel();
        const el = document.getElementById(STATUS_ID);
        if (el) {
            el.textContent = message;
        }
    }

    function renderSyncStatus() {
        const el = document.getElementById(SYNC_STATUS_ID);
        if (!el) {
            return;
        }
        let text = 'Sync: off';
        let kind = '';
        if (!isSyncEnabled()) {
            text = 'Sync: off';
            kind = '';
        } else if (!isSyncConfigured()) {
            text = 'Sync: offline (config incompleta)';
            kind = 'error';
        } else if (syncOnline) {
            text = 'Sync: online';
            kind = 'ok';
        } else if (syncLastError) {
            text = 'Sync: offline (' + syncLastError + ')';
            kind = 'error';
        } else {
            text = 'Sync: offline';
            kind = 'error';
        }
        el.textContent = text;
        el.classList.remove('ok', 'error');
        if (kind) {
            el.classList.add(kind);
        }
    }

    function setSyncOnline() {
        syncOnline = true;
        syncLastError = '';
        renderSyncStatus();
    }

    function setSyncOffline(reason) {
        syncOnline = false;
        syncLastError = reason ? String(reason) : '';
        renderSyncStatus();
    }

    function looksLikeTargetKey(key) {
        return typeof key === 'string' && (key.startsWith('id:') || key.startsWith('name:'));
    }

    function looksLikeTargetMap(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            return false;
        }
        const keys = Object.keys(obj);
        if (keys.length === 0) {
            return false;
        }
        return keys.every((key) => looksLikeTargetKey(key));
    }

    function normalizeCoord(coord) {
        const raw = String(coord || '').trim();
        if (!raw) {
            return '';
        }
        const parts = raw.split(':');
        if (parts.length !== 3) {
            return '';
        }
        const nums = parts.map((part) => Number(part));
        if (nums.some((num) => Number.isNaN(num) || num <= 0)) {
            return '';
        }
        return nums.join(':');
    }

    function normalizeCoordList(list) {
        if (!Array.isArray(list)) {
            return [];
        }
        const set = new Set();
        list.forEach((item) => {
            const coord = normalizeCoord(item);
            if (coord) {
                set.add(coord);
            }
        });
        return Array.from(set);
    }

    function normalizeActivityValue(value) {
        const raw = String(value || '-').trim();
        if (raw === '*') {
            return '*';
        }
        if (raw === '-') {
            return '-';
        }
        if (/^\d+$/.test(raw)) {
            return raw;
        }
        return '-';
    }

    function normalizeDebrisValue(value) {
        return String(value || '').trim().toLowerCase() === 'si' ? 'si' : 'no';
    }

    function normalizeActivityObservation(obs) {
        if (!obs || typeof obs !== 'object' || Array.isArray(obs)) {
            return null;
        }
        const playerKey = String(obs.playerKey || '').trim();
        const coords = normalizeCoord(obs.coords);
        const seenAt = Number(obs.seenAt);
        const bucketTs = Number(obs.bucketTs);
        if (!playerKey || !coords || !Number.isFinite(seenAt) || !Number.isFinite(bucketTs) || seenAt <= 0 || bucketTs <= 0) {
            return null;
        }
        const playerName = String(obs.playerName || '').trim() || playerKey;
        return {
            playerKey: playerKey,
            playerName: playerName,
            coords: coords,
            planet: normalizeActivityValue(obs.planet),
            moon: normalizeActivityValue(obs.moon),
            debris: normalizeDebrisValue(obs.debris),
            seenAt: seenAt,
            bucketTs: bucketTs
        };
    }

    function buildRemoteControlCommand(action, extra) {
        const payload = extra && typeof extra === 'object' ? extra : {};
        return {
            cmdId: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
            action: String(action || '').toLowerCase(),
            issuedAt: Date.now(),
            continuous: Boolean(payload.continuous),
            queue: normalizeCoordList(payload.queue),
            scanDelayMs: clampSpeed(Number(payload.scanDelayMs || scanDelayMs)),
            continuousIntervalMs: clampInterval(Number(payload.continuousIntervalMs || continuousIntervalMs))
        };
    }

    function refreshExecuteSlaveToggle() {
        const toggle = document.getElementById(EXECUTE_SLAVE_ID);
        if (!toggle) {
            return;
        }
        const allowed = isSyncHost();
        if (!allowed && executeOnSlave) {
            executeOnSlave = false;
            GM_setValue(KEY_EXECUTE_ON_SLAVE, false);
        }
        toggle.checked = Boolean(executeOnSlave);
        toggle.disabled = !allowed;
    }

    function normalizeSyncMode(value) {
        const mode = String(value || '').trim().toLowerCase();
        if (mode === 'host' || mode === 'slave') {
            return mode;
        }
        return 'off';
    }

    function isSyncHost() {
        return syncMode === 'host';
    }

    function isSyncSlave() {
        return syncMode === 'slave';
    }

    function isSyncEnabled() {
        return isSyncHost() || isSyncSlave();
    }

    function isSyncConfigured() {
        return isSyncEnabled() && /^https?:\/\//i.test(syncEndpoint);
    }

    function normalizeTargets(targets) {
        const normalized = {};
        if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
            return normalized;
        }
        Object.keys(targets).forEach((key) => {
            if (!key) {
                return;
            }
            const value = targets[key];
            if (value === true) {
                normalized[key] = { name: '' };
                return;
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return;
            }
            const copy = Object.assign({}, value);
            copy.name = typeof copy.name === 'string' ? copy.name : '';
            normalized[key] = copy;
        });
        return normalized;
    }

    function parseJsonSafe(text) {
        if (!text || !text.trim()) {
            return {};
        }
        try {
            return JSON.parse(text);
        } catch (err) {
            return {};
        }
    }

    function appendQueryParam(url, key, value) {
        const baseUrl = String(url || '').trim();
        if (!baseUrl) {
            return '';
        }
        try {
            const parsed = new URL(baseUrl, window.location.href);
            parsed.searchParams.set(key, value);
            return parsed.toString();
        } catch (err) {
            const sep = baseUrl.indexOf('?') === -1 ? '?' : '&';
            return baseUrl + sep + encodeURIComponent(key) + '=' + encodeURIComponent(value);
        }
    }

    function buildRemoteActivitySyncUrl() {
        return appendQueryParam(syncEndpoint, 'includeActivity', '1');
    }

    function requestSyncJson(method, payload, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const requestUrl = String(opts.url || syncEndpoint || '').trim();
        if (!/^https?:\/\//i.test(requestUrl)) {
            return Promise.reject(new Error('sync endpoint invalid'));
        }
        const headers = {};
        if (payload !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        if (syncToken) {
            headers[SYNC_TOKEN_HEADER] = syncToken;
        }
        const data = payload !== undefined ? JSON.stringify(payload) : undefined;
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: method,
                    url: requestUrl,
                    headers: headers,
                    data: data,
                    timeout: SYNC_HTTP_TIMEOUT_MS,
                    onload: (res) => {
                        if (res.status < 200 || res.status >= 300) {
                            setSyncOffline('http ' + res.status);
                            reject(new Error('sync http ' + res.status));
                            return;
                        }
                        setSyncOnline();
                        resolve(parseJsonSafe(res.responseText || ''));
                    },
                    onerror: () => {
                        setSyncOffline('network');
                        reject(new Error('sync network error'));
                    },
                    ontimeout: () => {
                        setSyncOffline('timeout');
                        reject(new Error('sync timeout'));
                    }
                });
                return;
            }
            const init = {
                method: method,
                headers: headers
            };
            if (data !== undefined) {
                init.body = data;
            }
            fetch(requestUrl, init)
                .then(async (res) => {
                    if (!res.ok) {
                        setSyncOffline('http ' + res.status);
                        throw new Error('sync http ' + res.status);
                    }
                    const text = await res.text();
                    setSyncOnline();
                    return parseJsonSafe(text);
                })
                .then(resolve)
                .catch((err) => {
                    if (!syncLastError) {
                        setSyncOffline('network');
                    }
                    reject(err);
                });
        });
    }

    function ensureHistoryBridge() {
        if (historyBridgeBound) {
            return;
        }
        historyBridgeBound = true;
        window.addEventListener('message', (event) => {
            const data = event && event.data;
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                return;
            }
            if (data.type !== HISTORY_BRIDGE_REQUEST) {
                return;
            }
            const reqId = String(data.reqId || '').trim();
            const sourceWin = event.source;
            if (!reqId || !sourceWin || typeof sourceWin.postMessage !== 'function') {
                return;
            }
            const reply = (payload, error) => {
                try {
                    sourceWin.postMessage({
                        type: HISTORY_BRIDGE_RESPONSE,
                        reqId: reqId,
                        payload: payload || null,
                        error: error ? String(error) : ''
                    }, '*');
                } catch (err) {
                    // ignore bridge reply failures
                }
            };

            if (!isSyncHost()) {
                reply(null, 'modo host requerido');
                return;
            }
            if (!isSyncConfigured()) {
                reply(null, 'sync no configurado');
                return;
            }

            const activityUrl = buildRemoteActivitySyncUrl();
            requestSyncJson('GET', undefined, { url: activityUrl })
                .then((payload) => reply(payload, ''))
                .catch((err) => reply(null, err && err.message ? err.message : 'sync error'));
        });
    }

    function parseRemoteTargetsPayload(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return null;
        }
        let rawTargets = {};
        if (payload.targets && typeof payload.targets === 'object' && !Array.isArray(payload.targets)) {
            rawTargets = payload.targets;
        } else if (looksLikeTargetMap(payload)) {
            rawTargets = payload;
        }
        const normalized = normalizeTargets(rawTargets);
        const updatedAtRaw = Number(payload.updatedAt || payload.updated_at || payload.ts || Date.now());
        const updatedAt = Number.isFinite(updatedAtRaw) ? updatedAtRaw : Date.now();
        return {
            targets: normalized,
            updatedAt: updatedAt
        };
    }

    function queueHostTargetsSync(targets) {
        if (!isSyncHost() || !isSyncConfigured()) {
            return;
        }
        syncPendingTargets = normalizeTargets(targets);
        if (syncPushTimer) {
            clearTimeout(syncPushTimer);
        }
        syncPushTimer = setTimeout(() => {
            syncPushTimer = null;
            flushHostTargetsSync();
        }, SYNC_PUSH_DEBOUNCE_MS);
    }

    function flushHostTargetsSync() {
        if (!isSyncHost() || !isSyncConfigured() || !syncPendingTargets) {
            return;
        }
        if (syncPushInFlight) {
            if (!syncPushTimer) {
                syncPushTimer = setTimeout(() => {
                    syncPushTimer = null;
                    flushHostTargetsSync();
                }, SYNC_PUSH_DEBOUNCE_MS);
            }
            return;
        }
        const targetsToSend = syncPendingTargets;
        syncPendingTargets = null;
        syncPushInFlight = true;
        requestSyncJson('PUT', {
            targets: targetsToSend,
            updatedAt: Date.now()
        }).catch((err) => {
            console.warn('[PTRE sync host] push failed:', err);
        }).finally(() => {
            syncPushInFlight = false;
            if (syncPendingTargets && !syncPushTimer) {
                syncPushTimer = setTimeout(() => {
                    syncPushTimer = null;
                    flushHostTargetsSync();
                }, SYNC_PUSH_DEBOUNCE_MS);
            }
        });
    }

    function queueSlaveActivitySync(obs) {
        if (!isSyncSlave() || !isSyncConfigured()) {
            return;
        }
        const normalized = normalizeActivityObservation(obs);
        if (!normalized) {
            return;
        }
        syncPendingActivity.push(normalized);
        if (syncPendingActivity.length > SYNC_ACTIVITY_MAX_QUEUE) {
            syncPendingActivity.splice(0, syncPendingActivity.length - SYNC_ACTIVITY_MAX_QUEUE);
        }
        if (syncActivityPushTimer) {
            return;
        }
        syncActivityPushTimer = setTimeout(() => {
            syncActivityPushTimer = null;
            flushSlaveActivitySync();
        }, SYNC_ACTIVITY_PUSH_DEBOUNCE_MS);
    }

    function flushSlaveActivitySync() {
        if (!isSyncSlave() || !isSyncConfigured() || syncPendingActivity.length === 0) {
            return;
        }
        if (syncActivityPushInFlight) {
            if (!syncActivityPushTimer) {
                syncActivityPushTimer = setTimeout(() => {
                    syncActivityPushTimer = null;
                    flushSlaveActivitySync();
                }, SYNC_ACTIVITY_PUSH_DEBOUNCE_MS);
            }
            return;
        }
        const batch = syncPendingActivity.splice(0, SYNC_ACTIVITY_BATCH_SIZE);
        if (batch.length === 0) {
            return;
        }
        syncActivityPushInFlight = true;
        requestSyncJson('PUT', {
            activityBatch: batch,
            activityUpdatedAt: Date.now()
        }).catch((err) => {
            console.warn('[PTRE sync slave] activity push failed:', err);
            syncPendingActivity = batch.concat(syncPendingActivity);
            if (syncPendingActivity.length > SYNC_ACTIVITY_MAX_QUEUE) {
                syncPendingActivity = syncPendingActivity.slice(syncPendingActivity.length - SYNC_ACTIVITY_MAX_QUEUE);
            }
        }).finally(() => {
            syncActivityPushInFlight = false;
            if (syncPendingActivity.length > 0 && !syncActivityPushTimer) {
                syncActivityPushTimer = setTimeout(() => {
                    syncActivityPushTimer = null;
                    flushSlaveActivitySync();
                }, SYNC_ACTIVITY_PUSH_DEBOUNCE_MS);
            }
        });
    }

    function sendRemoteControlCommand(controlCommand) {
        if (!isSyncHost()) {
            setStatus('Sync host requerido para control remoto');
            return Promise.resolve(false);
        }
        if (!isSyncConfigured()) {
            setStatus('Configura Sync antes de controlar esclavo');
            return Promise.resolve(false);
        }
        return requestSyncJson('PUT', {
            control: controlCommand,
            controlUpdatedAt: Date.now()
        }).then(() => true).catch((err) => {
            console.warn('[PTRE sync host] control command failed:', err);
            return false;
        });
    }

    function sendRemoteScanCommand(continuous) {
        const targets = loadTargets();
        const keys = Object.keys(targets);
        if (keys.length === 0) {
            setStatus('Sin objetivos para enviar a esclavo');
            return;
        }
        setStatus('Preparando orden para esclavo...');
        buildScanQueue(keys).then((queue) => {
            const coords = normalizeCoordList(queue);
            if (coords.length === 0) {
                setStatus('Sin coordenadas para esclavo');
                return;
            }
            const command = buildRemoteControlCommand('start', {
                continuous: Boolean(continuous),
                queue: coords,
                scanDelayMs: scanDelayMs,
                continuousIntervalMs: continuousIntervalMs
            });
            sendRemoteControlCommand(command).then((ok) => {
                if (ok) {
                    setStatus('Orden enviada a esclavo (' + coords.length + ' coords)');
                } else {
                    setStatus('No se pudo enviar orden a esclavo');
                }
            });
        }).catch((err) => {
            console.warn('[PTRE sync host] failed building remote queue:', err);
            setStatus('Error preparando coordenadas para esclavo');
        });
    }

    function sendRemoteStopCommand() {
        const command = buildRemoteControlCommand('stop', {
            continuous: false,
            queue: [],
            scanDelayMs: scanDelayMs,
            continuousIntervalMs: continuousIntervalMs
        });
        sendRemoteControlCommand(command).then((ok) => {
            if (ok) {
                setStatus('Orden STOP enviada a esclavo');
            } else {
                setStatus('No se pudo enviar STOP a esclavo');
            }
        });
    }

    function applyRemoteControlCommand(payload) {
        if (!isSyncSlave()) {
            return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return;
        }
        const control = payload.control;
        if (!control || typeof control !== 'object' || Array.isArray(control)) {
            return;
        }
        const cmdId = String(control.cmdId || '').trim();
        if (!cmdId || cmdId === lastRemoteCmdId) {
            return;
        }
        lastRemoteCmdId = cmdId;
        GM_setValue(KEY_LAST_REMOTE_CMD, lastRemoteCmdId);

        const action = String(control.action || '').toLowerCase();
        if (action === 'stop') {
            remoteScanPlan = null;
            GM_setValue(KEY_CONTINUOUS_ACTIVE, false);
            stopScan('Orden STOP recibida del master');
            return;
        }
        if (action !== 'start') {
            return;
        }
        const coords = normalizeCoordList(control.queue);
        if (coords.length === 0) {
            setStatus('Orden remota sin coordenadas');
            return;
        }
        const remoteDelay = clampSpeed(Number(control.scanDelayMs || scanDelayMs));
        const remoteInterval = clampInterval(Number(control.continuousIntervalMs || continuousIntervalMs));
        const remoteContinuous = Boolean(control.continuous);

        remoteScanPlan = {
            queue: coords,
            scanDelayMs: remoteDelay,
            continuousIntervalMs: remoteInterval,
            continuous: remoteContinuous
        };
        startScan(remoteContinuous, {
            fromRemote: true,
            queue: coords,
            scanDelayMs: remoteDelay,
            continuousIntervalMs: remoteInterval
        });
        setStatus('Orden recibida del master (' + coords.length + ' coords)');
    }

    function pullTargetsFromRemote(force) {
        if (!isSyncSlave() || !isSyncConfigured() || syncPullInFlight) {
            return;
        }
        syncPullInFlight = true;
        requestSyncJson('GET').then((payload) => {
            const remote = parseRemoteTargetsPayload(payload);
            if (remote) {
                const remoteSerialized = JSON.stringify(remote.targets);
                const localSerialized = JSON.stringify(loadTargets());
                const hasChange = force
                    || remote.updatedAt > syncLastRemoteUpdatedAt
                    || remoteSerialized !== syncLastRemoteSerialized;
                if (hasChange) {
                    syncLastRemoteUpdatedAt = remote.updatedAt;
                    syncLastRemoteSerialized = remoteSerialized;
                    if (remoteSerialized !== localSerialized) {
                        saveTargets(remote.targets, { skipSync: true });
                        refreshTargetIcons();
                        updateTargetPanel();
                        setStatus('Sync esclava: objetivos actualizados');
                    }
                }
            }
            applyRemoteControlCommand(payload);
        }).catch((err) => {
            console.warn('[PTRE sync slave] pull failed:', err);
        }).finally(() => {
            syncPullInFlight = false;
        });
    }

    function startTargetsSync() {
        if (!isSyncEnabled()) {
            setSyncOffline('');
            refreshExecuteSlaveToggle();
            return;
        }
        if (!isSyncConfigured()) {
            console.warn('[PTRE sync] mode enabled but syncEndpoint is not valid');
            setSyncOffline('config incompleta');
            refreshExecuteSlaveToggle();
            return;
        }
        setSyncOffline('');
        refreshExecuteSlaveToggle();
        if (isSyncHost()) {
            queueHostTargetsSync(loadTargets());
            return;
        }
        pullTargetsFromRemote(true);
        if (syncPullTimer) {
            clearInterval(syncPullTimer);
        }
        const pollMs = Math.max(2000, Number(SYNC_PULL_INTERVAL_MS) || 5000);
        syncPullTimer = setInterval(() => {
            pullTargetsFromRemote(false);
        }, pollMs);
    }

    function stopTargetsSync() {
        if (syncPullTimer) {
            clearInterval(syncPullTimer);
            syncPullTimer = null;
        }
        if (syncPushTimer) {
            clearTimeout(syncPushTimer);
            syncPushTimer = null;
        }
        if (syncActivityPushTimer) {
            clearTimeout(syncActivityPushTimer);
            syncActivityPushTimer = null;
        }
        syncPullInFlight = false;
        syncPushInFlight = false;
        syncActivityPushInFlight = false;
        syncPendingTargets = null;
        syncPendingActivity = [];
        syncLastRemoteUpdatedAt = 0;
        syncLastRemoteSerialized = '';
        setSyncOffline('');
        refreshExecuteSlaveToggle();
    }

    function restartTargetsSync() {
        stopTargetsSync();
        startTargetsSync();
    }

    function updateSyncButtonLabel() {
        const btn = document.getElementById(SYNC_CONFIG_ID);
        if (!btn) {
            return;
        }
        btn.textContent = 'Sync: ' + syncMode;
        renderSyncStatus();
        refreshExecuteSlaveToggle();
    }

    function configureSyncSettings() {
        const modeInput = window.prompt('Modo sync: off | host | slave', syncMode);
        if (modeInput === null) {
            return;
        }
        const endpointInput = window.prompt('Sync endpoint (ej: http://IP_VPS:8787/targets)', syncEndpoint);
        if (endpointInput === null) {
            return;
        }
        const tokenInput = window.prompt('Sync token (X-PTRE-Token, opcional)', syncToken);
        if (tokenInput === null) {
            return;
        }
        syncMode = normalizeSyncMode(modeInput);
        syncEndpoint = String(endpointInput || '').trim();
        syncToken = String(tokenInput || '').trim();
        if (!isSyncHost()) {
            executeOnSlave = false;
            GM_setValue(KEY_EXECUTE_ON_SLAVE, false);
        }
        GM_setValue(KEY_SYNC_MODE, syncMode);
        GM_setValue(KEY_SYNC_ENDPOINT, syncEndpoint);
        GM_setValue(KEY_SYNC_TOKEN, syncToken);
        updateSyncButtonLabel();
        restartTargetsSync();
        refreshTargetIcons();
        setStatus('Sync: ' + syncMode);
    }

    function refreshTargetIcons() {
        const targets = loadTargets();
        const icons = document.querySelectorAll('.' + ICON_CLASS);
        icons.forEach((icon) => {
            const key = icon.dataset.targetKey;
            if (!key) {
                return;
            }
            if (targets[key]) {
                icon.classList.add(ICON_TARGET_CLASS);
            } else {
                icon.classList.remove(ICON_TARGET_CLASS);
            }
            icon.title = isSyncSlave() ? 'Modo esclava: solo lectura' : 'Marcar objetivo';
        });
    }


    function ensureLobbyPanel() {
        let panel = document.getElementById(LOBBY_PANEL_ID);
        if (panel) {
            return panel;
        }
        GM_addStyle(`
#${LOBBY_PANEL_ID} {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 10050;
    background: #171d22;
    border: 2px solid #000;
    color: #d7dee5;
    font: 12px/1.4 "Courier New", monospace;
    padding: 8px 10px;
    min-width: 240px;
    box-shadow: 0 8px 20px rgba(0,0,0,0.4);
}
#${LOBBY_PANEL_ID} .ptreLobbyTitle {
    font-weight: bold;
    color: #ff4d4d;
    margin-bottom: 6px;
}
#${LOBBY_PANEL_ID} .ptreLobbyStatus {
    color: #ffd166;
}
#${LOBBY_PANEL_ID} .ptreLobbyStatus.ok {
    color: #9ccf5f;
}
#${LOBBY_PANEL_ID} .ptreLobbyStatus.error {
    color: #ff4d4d;
}
`);
        panel = document.createElement('div');
        panel.id = LOBBY_PANEL_ID;
        panel.innerHTML = `
<div class="ptreLobbyTitle">PTRE Lobby</div>
<div id="${LOBBY_STATUS_ID}" class="ptreLobbyStatus">Lobby: buscando botón...</div>
`;
        document.body.appendChild(panel);
        return panel;
    }

    function setLobbyStatus(message, kind) {
        ensureLobbyPanel();
        const el = document.getElementById(LOBBY_STATUS_ID);
        if (!el) {
            return;
        }
        el.textContent = message;
        el.classList.remove('ok', 'error');
        if (kind) {
            el.classList.add(kind);
        }
    }

    function initLobbyAutoClick() {
        let done = false;
        let entryTimer = null;
        let lobbyCardRoot = null;
        let openHookInstalled = false;
        setLobbyStatus('Lobby: esperando 10s...', null);

        const installOpenHook = () => {
            if (openHookInstalled) {
                return;
            }
            openHookInstalled = true;
            const originalOpen = window.open;
            window.open = function(url, name, specs) {
                try {
                    if (typeof url === 'string' && LOBBY_GAME_URL_RE.test(url)) {
                        setLobbyStatus('Lobby: abriendo juego...', 'ok');
                        window.location.href = url;
                        return null;
                    }
                } catch (err) {
                    // ignore and fallback to original open
                }
                return originalOpen ? originalOpen.call(window, url, name, specs) : null;
            };
        };

        const smartClick = (el) => {
            if (!el) {
                return false;
            }
            el.click();
            return true;
        };

        const isMatch = (text) => {
            if (!text) {
                return false;
            }
            const normalized = normalizeText(text);
            if (!normalized) {
                return false;
            }
            return LOBBY_TEXT_MATCHERS.some((parts) => parts.every((p) => normalized.includes(normalizeText(p))));
        };

        const findButton = () => {
            const allButtons = Array.from(document.querySelectorAll('button'));
            for (const btn of allButtons) {
                if (isMatch(btn.textContent)) {
                    return btn;
                }
            }
            const serverButtons = allButtons.filter((btn) => btn.querySelector('span.serverDetails'));
            if (serverButtons.length === 1) {
                return serverButtons[0];
            }
            return null;
        };

        const findLobbyCardRoot = (btn) => {
            let node = btn;
            while (node && node !== document.body) {
                if (node.querySelector && node.querySelector('span.serverDetails')) {
                    return node;
                }
                node = node.parentElement;
            }
            return btn ? (btn.parentElement || document.body) : document.body;
        };

        const findEntryTarget = () => {
            const scope = lobbyCardRoot || document;
            const scopedAnchors = Array.from(scope.querySelectorAll('a[href]'));
            for (const a of scopedAnchors) {
                if (a.href && a.href.includes('/game/')) {
                    return a;
                }
            }
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (const a of anchors) {
                if (a.href && a.href.includes('/game/')) {
                    return a;
                }
            }
            return null;
        };

        const tryEnter = () => {
            if (location.hostname !== 'lobby.ogame.gameforge.com') {
                return true;
            }
            const target = findEntryTarget();
            if (target) {
                setLobbyStatus('Lobby: intentando entrar...', 'ok');
                smartClick(target);
                return true;
            }
            return false;
        };

        const startEntryLoop = () => {
            if (entryTimer) {
                return;
            }
            if (tryEnter()) {
                return;
            }
            setLobbyStatus('Lobby: botón pulsado, esperando ventana...', 'ok');
            entryTimer = setTimeout(() => {
                entryTimer = null;
                setLobbyStatus('Lobby: si no se abrió ventana, pulsa manualmente', 'error');
            }, LOBBY_POST_CLICK_WAIT_MS);
        };

        const tryClick = () => {
            const btn = findButton();
            if (btn) {
                installOpenHook();
                smartClick(btn);
                done = true;
                lobbyCardRoot = findLobbyCardRoot(btn);
                setLobbyStatus('Lobby: botón encontrado, entrando...', 'ok');
                startEntryLoop();
                return true;
            }
            return false;
        };
        const startSearch = () => {
            setLobbyStatus('Lobby: buscando botón...', null);
            if (tryClick()) {
                return;
            }
            let intervalId = null;
            const observer = new MutationObserver(() => {
                if (tryClick()) {
                    observer.disconnect();
                    if (intervalId) {
                        clearInterval(intervalId);
                    }
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            intervalId = setInterval(() => {
                if (tryClick()) {
                    observer.disconnect();
                    clearInterval(intervalId);
                }
            }, 1000);
            setTimeout(() => {
                if (done) {
                    return;
                }
                observer.disconnect();
                if (intervalId) {
                    clearInterval(intervalId);
                }
                setLobbyStatus('Lobby: no se encontró botón para relogin', 'error');
            }, LOBBY_AUTOCLICK_MAX_MS);
        };

        setTimeout(startSearch, LOBBY_START_DELAY_MS);
    }

    function initIngameAutoGalaxy() {
        setTimeout(() => {
            const link = document.querySelector('a[data-ipi-hint="ipiToolbarGalaxy"], a.menubutton[href*="component=galaxy"], a[href*="component=galaxy"]');
            if (link && link.href) {
                window.location.href = link.href;
                return;
            }
            if (link) {
                link.click();
            }
        }, 10000);
    }

    function scheduleReload() {
        if (reloadScheduled) {
            return;
        }
        reloadScheduled = true;
        setTimeout(() => {
            window.location.reload();
        }, RELOAD_DELAY_MS);
    }

    function startScanWatchdog() {
        if (scanWatchdogId) {
            return;
        }
        scanWatchdogId = setInterval(() => {
            if (!scanActive || !scanPending || !scanPendingSince) {
                return;
            }
            const elapsed = Date.now() - scanPendingSince;
            if (elapsed < GALAXY_LOAD_TIMEOUT_MS) {
                return;
            }
            scanPendingSince = 0;
            clearGalaxyLoadTimeout();
            handleGalaxyLoadTimeout();
        }, 1000);
    }

    function stopScanWatchdog() {
        if (scanWatchdogId) {
            clearInterval(scanWatchdogId);
            scanWatchdogId = null;
        }
    }

    function armGalaxyLoadTimeout() {
        if (galaxyLoadTimeoutId) {
            clearTimeout(galaxyLoadTimeoutId);
        }
        galaxyLoadTimeoutId = setTimeout(() => {
            galaxyLoadTimeoutId = null;
            if (handleGalaxyLoadTimeout()) {
                return;
            }
            setStatus('Timeout cargando galaxia');
        }, GALAXY_LOAD_TIMEOUT_MS);
    }

    function clearGalaxyLoadTimeout() {
        if (galaxyLoadTimeoutId) {
            clearTimeout(galaxyLoadTimeoutId);
            galaxyLoadTimeoutId = null;
        }
    }

    function handleGalaxyLoadTimeout() {
        clearGalaxyLoadTimeout();
        if (scanActive && scanPending) {
            stopScan('Timeout cargando galaxia. Recargando...');
            scheduleReload();
            return true;
        }
        return false;
    }

    function clampSpeed(val) {
        const ms = Number(val);
        if (!ms || Number.isNaN(ms)) {
            return 1000;
        }
        return Math.min(5000, Math.max(1000, ms));
    }

    scanDelayMs = clampSpeed(scanDelayMs);

    function clampInterval(val) {
        const ms = Number(val);
        if (!ms || Number.isNaN(ms)) {
            return 60000;
        }
        return Math.min(3600000, Math.max(60000, ms));
    }

    continuousIntervalMs = clampInterval(continuousIntervalMs);

    function applyScanQueueAndRun(queue) {
        const coords = normalizeCoordList(queue);
        if (!coords.length) {
            return false;
        }
        scanQueue = coords;
        scanIndex = 0;
        scanActive = true;
        scanPending = false;
        runScanCurrent();
        return true;
    }

    function startScan(continuous, options) {
        const opts = options || {};
        if (isSyncSlave() && !opts.fromRemote) {
            setStatus('Modo esclava: controlado por master');
            return;
        }
        if (opts.scanDelayMs !== undefined) {
            scanDelayMs = clampSpeed(Number(opts.scanDelayMs));
        }
        if (opts.continuousIntervalMs !== undefined) {
            continuousIntervalMs = clampInterval(Number(opts.continuousIntervalMs));
        }
        if (continuous) {
            continuousActive = true;
            GM_setValue(KEY_CONTINUOUS_ACTIVE, true);
        } else {
            continuousActive = false;
            GM_setValue(KEY_CONTINUOUS_ACTIVE, false);
        }
        if (!opts.fromRemote) {
            remoteScanPlan = null;
        }
        if (scanActive) {
            if (!opts.fromRemote) {
                setStatus('Recorrido en curso');
                return;
            }
            stopScan('', { keepRemotePlan: true });
        }
        if (opts.queue && Array.isArray(opts.queue)) {
            const started = applyScanQueueAndRun(opts.queue);
            if (!started) {
                setStatus('Sin coordenadas');
            }
            return;
        }
        startScanRound();
    }

    function startScanRound() {
        remoteScanPlan = null;
        const targets = loadTargets();
        const keys = Object.keys(targets);
        if (keys.length === 0) {
            setStatus('Sin objetivos');
            if (continuousActive) {
                scheduleNextRound();
            }
            return;
        }
        setStatus('Preparando recorrido...');
        buildScanQueue(keys).then((queue) => {
            const started = applyScanQueueAndRun(queue);
            if (!started) {
                setStatus('Sin coordenadas');
                if (continuousActive) {
                    scheduleNextRound();
                }
            }
        });
    }

    function stopScan(message, options) {
        const opts = options || {};
        scanActive = false;
        continuousActive = false;
        scanPending = false;
        scanPendingSince = 0;
        if (!opts.keepRemotePlan) {
            remoteScanPlan = null;
        }
        stopScanWatchdog();
        clearGalaxyLoadTimeout();
        if (scanTimer) {
            clearTimeout(scanTimer);
            scanTimer = null;
        }
        if (continuousTimer) {
            clearTimeout(continuousTimer);
            continuousTimer = null;
        }
        if (message) {
            setStatus(message);
        }
    }

    function runScanCurrent() {
        if (!scanActive) {
            return;
        }
        if (scanIndex >= scanQueue.length) {
            scanActive = false;
            scanPending = false;
            if (continuousActive) {
                setStatus('Recorrido terminado. Próxima ronda...');
                scheduleNextRound();
            } else {
                setStatus('Recorrido terminado');
            }
            return;
        }
        const coord = scanQueue[scanIndex];
        setStatus('Recorrido: ' + (scanIndex + 1) + '/' + scanQueue.length + ' -> ' + coord);
        const ok = goToCoords(coord);
        if (!ok) {
            stopScan('No se pudo navegar sin recargar');
            return;
        }
        scanPending = true;
        scanPendingSince = Date.now();
        startScanWatchdog();
        armGalaxyLoadTimeout();
    }

    function scheduleNextScan() {
        if (!scanActive) {
            return;
        }
        if (scanTimer) {
            clearTimeout(scanTimer);
        }
        scanTimer = setTimeout(() => {
            scanIndex += 1;
            runScanCurrent();
        }, scanDelayMs);
    }

    function scheduleNextRound() {
        if (continuousTimer) {
            clearTimeout(continuousTimer);
        }
        continuousTimer = setTimeout(() => {
            if (continuousActive) {
                if (isSyncSlave() && remoteScanPlan && remoteScanPlan.continuous) {
                    scanDelayMs = clampSpeed(Number(remoteScanPlan.scanDelayMs || scanDelayMs));
                    continuousIntervalMs = clampInterval(Number(remoteScanPlan.continuousIntervalMs || continuousIntervalMs));
                    const started = applyScanQueueAndRun(remoteScanPlan.queue || []);
                    if (!started) {
                        continuousActive = false;
                        GM_setValue(KEY_CONTINUOUS_ACTIVE, false);
                        setStatus('Orden remota sin coordenadas');
                    }
                    return;
                }
                startScanRound();
            }
        }, continuousIntervalMs);
    }

    function buildScanQueue(keys) {
        return Promise.all(keys.map((key) => getCoordsForPlayer(key)))
            .then((lists) => {
                const set = new Set();
                lists.forEach((coords) => {
                    coords.forEach((c) => set.add(c));
                });
                const arr = Array.from(set);
                arr.sort((a, b) => {
                    const [ga, sa, pa] = a.split(':').map(Number);
                    const [gb, sb, pb] = b.split(':').map(Number);
                    if (ga !== gb) return ga - gb;
                    if (sa !== sb) return sa - sb;
                    return pa - pb;
                });
                return arr;
            });
    }

    function floorToBucket(ts) {
        return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    }

    function readCoords() {
        const galaxyInput = document.querySelector('input#galaxy_input');
        const systemInput = document.querySelector('input#system_input');
        if (!galaxyInput || !systemInput) {
            return null;
        }
        return {
            galaxy: galaxyInput.value,
            system: systemInput.value
        };
    }

    function onGalaxyReady() {
        clearGalaxyLoadTimeout();
        scanPendingSince = 0;
        const coords = readCoords();
        if (!coords) {
            return;
        }
        if (coords.galaxy !== lastGalaxy || coords.system !== lastSystem) {
            setStatus('Has cambiado de galaxia: ' + coords.galaxy + ':' + coords.system);
            lastGalaxy = coords.galaxy;
            lastSystem = coords.system;
        }
        addIcons();
        recordVisibleTargets();
        updateTargetPanel();
        if (resumeContinuous && !resumeContinuousDone && !scanActive && !isSyncSlave()) {
            resumeContinuousDone = true;
            startScan(true);
        }
        if (scanActive && scanPending) {
            scanPending = false;
            scheduleNextScan();
        }
    }

    function addIcons() {
        const targets = loadTargets();
        for (let pos = 1; pos <= 15; pos++) {
            const row = document.getElementById('galaxyRow' + pos);
            if (!row) {
                continue;
            }
            const cellPlayerName = row.querySelector('.cellPlayerName');
            if (!cellPlayerName) {
                continue;
            }
            const hasPlayer = cellPlayerName.querySelector('span[rel^="player"]') || cellPlayerName.querySelector('.ownPlayerRow');
            if (!hasPlayer) {
                continue;
            }
            if (cellPlayerName.querySelector('.' + ICON_CLASS)) {
                continue;
            }
            const playerName = getPlayerName(row, cellPlayerName);
            const playerId = getPlayerId(cellPlayerName);
            const targetKey = buildTargetKey(playerId, playerName);
            const icon = document.createElement('span');
            icon.className = ICON_CLASS;
            icon.title = isSyncSlave() ? 'Modo esclava: solo lectura' : 'Marcar objetivo';
            icon.dataset.playerName = playerName || 'Desconocido';
            icon.dataset.targetKey = targetKey;
            if (targets[targetKey]) {
                icon.classList.add(ICON_TARGET_CLASS);
            }
            icon.addEventListener('click', (event) => {
                event.stopPropagation();
                if (isSyncSlave()) {
                    setStatus('Modo esclava: objetivos solo lectura');
                    return;
                }
                const key = icon.dataset.targetKey;
                const store = loadTargets();
                if (store[key]) {
                    delete store[key];
                    icon.classList.remove(ICON_TARGET_CLASS);
                    setStatus('Objetivo quitado: ' + icon.dataset.playerName);
                } else {
                    store[key] = { name: icon.dataset.playerName };
                    icon.classList.add(ICON_TARGET_CLASS);
                    setStatus('Objetivo: ' + icon.dataset.playerName);
                }
                saveTargets(store);
                updateTargetPanel();
            });
            cellPlayerName.appendChild(icon);
        }
    }

    function getPlayerName(row, cellPlayerName) {
        let playerName = '';
        const nameNode = row.querySelector('.galaxyCell .playerName.tooltipRel');
        if (nameNode && nameNode.childNodes[0]) {
            playerName = nameNode.childNodes[0].textContent.trim();
        }
        if (!playerName) {
            const ownRow = cellPlayerName.querySelector('.ownPlayerRow');
            if (ownRow) {
                playerName = ownRow.textContent.trim();
            }
        }
        if (!playerName) {
            playerName = cellPlayerName.textContent.trim();
        }
        return playerName;
    }

    function getPlayerId(cellPlayerName) {
        const playerSpan = cellPlayerName.querySelector('span[rel^="player"]');
        if (playerSpan) {
            const rel = playerSpan.getAttribute('rel');
            const id = Number(rel.replace(/\D/g, ''));
            if (!Number.isNaN(id) && id > 0) {
                return id;
            }
        }
        return -1;
    }

    function buildTargetKey(playerId, playerName) {
        if (playerId > 0) {
            return 'id:' + playerId;
        }
        return 'name:' + (playerName || 'unknown');
    }

    function loadTargets() {
        const raw = GM_getValue(KEY_TARGETS, '{}');
        try {
            const parsed = JSON.parse(raw);
            return normalizeTargets(parsed);
        } catch (err) {
            // ignore
        }
        return {};
    }

    function saveTargets(targets, options) {
        const opts = options || {};
        const normalized = normalizeTargets(targets);
        GM_setValue(KEY_TARGETS, JSON.stringify(normalized));
        if (!opts.skipSync && isSyncHost()) {
            queueHostTargetsSync(normalized);
        }
    }

    function updateTargetPanel() {
        ensurePanel();
        const targetSelect = document.getElementById(TARGET_SELECT_ID);
        const coordsContainer = document.getElementById(TARGET_COORDS_ID);
        if (!targetSelect || !coordsContainer) {
            return;
        }
        const targets = loadTargets();
        const keys = Object.keys(targets);
        targetSelect.innerHTML = '<option value="">-- Selecciona --</option>';
        if (keys.length === 0) {
            coordsContainer.textContent = 'Sin objetivos';
            refreshTargetIcons();
            return;
        }
        keys.forEach((key) => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = targets[key].name || key;
            targetSelect.appendChild(opt);
        });
        const lastTarget = GM_getValue(KEY_LAST_TARGET, '');
        if (lastTarget && keys.includes(lastTarget)) {
            targetSelect.value = lastTarget;
            showCoordsForPlayer(lastTarget);
        } else {
            coordsContainer.textContent = 'Selecciona un jugador';
        }
        updateOptionNamesFromDb(keys, targets, targetSelect);
        refreshTargetIcons();
    }

    function updateOptionNamesFromDb(keys, targets, targetSelect) {
        openDb().then((db) => {
            const tx = db.transaction([STORE_PLAYERS], 'readonly');
            const store = tx.objectStore(STORE_PLAYERS);
            keys.forEach((key) => {
                const req = store.get(key);
                req.onsuccess = () => {
                    const rec = req.result;
                    if (rec && rec.playerName) {
                        const opt = Array.from(targetSelect.options).find((o) => o.value === key);
                        if (opt) {
                            opt.textContent = rec.playerName;
                        }
                    }
                };
            });
        }).catch(() => {});
    }

    function showCoordsForPlayer(playerKey) {
        const coordsContainer = document.getElementById(TARGET_COORDS_ID);
        if (!coordsContainer) {
            return;
        }
        coordsContainer.textContent = '';
        if (!playerKey) {
            coordsContainer.textContent = 'Selecciona un jugador';
            return;
        }
        coordsContainer.textContent = 'Cargando...';
        getCoordsForPlayer(playerKey).then((coords) => {
            coordsContainer.textContent = '';
            if (!coords || coords.length === 0) {
                coordsContainer.textContent = 'Sin coordenadas';
                return;
            }
            coords.forEach((coord) => {
                const btn = document.createElement('button');
                btn.className = 'ptreLocalCoordButton';
                btn.textContent = coord;
                btn.addEventListener('click', () => {
                    const ok = goToCoords(coord);
                    if (!ok) {
                        setStatus('No se pudo navegar sin recargar');
                    }
                });
                coordsContainer.appendChild(btn);
            });
        });
    }

    function getCoordsForPlayer(playerKey) {
        return openDb().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_BUCKETS], 'readonly');
            const store = tx.objectStore(STORE_BUCKETS);
            const idx = store.index('byPlayer');
            const coords = new Set();
            const req = idx.openCursor(IDBKeyRange.only(playerKey));
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve(Array.from(coords).filter((c) => c && c !== 'unknown').sort());
                    return;
                }
                const val = cursor.value;
                if (val.coords) {
                    coords.add(val.coords);
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        }));
    }

    function goToCoords(coord) {
        const parts = coord.split(':').map((p) => Number(p));
        if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) {
            return false;
        }
        const [g, s, p] = parts;
        const galaxyInput = document.querySelector('input#galaxy_input');
        const systemInput = document.querySelector('input#system_input');
        const positionInput = document.querySelector('input#position_input');

        const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        if (pageWindow.galaxy && typeof pageWindow.galaxy.updateGalaxy === 'function') {
            try {
                pageWindow.galaxy.updateGalaxy(g, s, p);
                return true;
            } catch (err) {
                // fallback below
            }
        }

        if (galaxyInput) {
            galaxyInput.value = g;
            galaxyInput.dispatchEvent(new Event('input', { bubbles: true }));
            galaxyInput.dispatchEvent(new Event('change', { bubbles: true }));
            galaxyInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        }
        if (systemInput) {
            systemInput.value = s;
            systemInput.dispatchEvent(new Event('input', { bubbles: true }));
            systemInput.dispatchEvent(new Event('change', { bubbles: true }));
            systemInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        }
        if (positionInput) {
            positionInput.value = p;
            positionInput.dispatchEvent(new Event('input', { bubbles: true }));
            positionInput.dispatchEvent(new Event('change', { bubbles: true }));
            positionInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        }
        if (pageWindow.galaxy && typeof pageWindow.galaxy.submitGalaxy === 'function') {
            try {
                pageWindow.galaxy.submitGalaxy();
                return true;
            } catch (err) {
                // fallback below
            }
        }
        if (typeof pageWindow.submitForm === 'function') {
            try {
                pageWindow.submitForm();
                return true;
            } catch (err) {
                // fallback below
            }
        }
        const vamosBtn = findVamosButton();
        if (vamosBtn) {
            vamosBtn.click();
            return true;
        }
        return false;
    }

    function findVamosButton() {
        const form = document.querySelector('#galaxyForm') || document;
        const candidates = form.querySelectorAll('button, input[type="submit"], a, div');
        for (const el of candidates) {
            const tag = el.tagName.toLowerCase();
            const text = (tag === 'input') ? (el.value || '') : (el.textContent || '');
            if (normalizeText(text).includes('vamos')) {
                return el;
            }
            const onclick = el.getAttribute('onclick') || '';
            if (onclick.includes('submitForm')) {
                return el;
            }
        }
        return null;
    }

    function normalizeText(text) {
        return (text || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '');
    }

    function readActivity(elem) {
        if (!elem) {
            return '-';
        }
        if (elem.classList.contains('minute15')) {
            return '*';
        }
        if (elem.classList.contains('showMinutes')) {
            const txt = elem.textContent.trim();
            return txt || '-';
        }
        return '-';
    }

    function readDebris(pos) {
        let debris = 0;
        const debrisElements = document.querySelectorAll('#debris' + pos + ' .ListLinks .debris-content');
        debrisElements.forEach((element) => {
            const parts = element.textContent.split(':');
            let value = parts[1] ? parts[1].trim() : '0';
            value = value.replace(/[^\d]/g, '');
            const num = Number(value);
            if (!Number.isNaN(num)) {
                debris += num;
            }
        });
        return debris;
    }

    function recordVisibleTargets() {
        const coords = readCoords();
        if (!coords) {
            return;
        }
        const targets = loadTargets();
        const targetKeys = Object.keys(targets);
        if (targetKeys.length === 0) {
            return;
        }
        for (let pos = 1; pos <= 15; pos++) {
            const row = document.getElementById('galaxyRow' + pos);
            if (!row) {
                continue;
            }
            const cellPlayerName = row.querySelector('.cellPlayerName');
            if (!cellPlayerName) {
                continue;
            }
            const hasPlayer = cellPlayerName.querySelector('span[rel^="player"]') || cellPlayerName.querySelector('.ownPlayerRow');
            if (!hasPlayer) {
                continue;
            }
            const playerName = getPlayerName(row, cellPlayerName);
            const playerId = getPlayerId(cellPlayerName);
            const targetKey = buildTargetKey(playerId, playerName);
            if (!targets[targetKey]) {
                continue;
            }

            const planetActi = readActivity(row.querySelector('[data-planet-id] .activity'));
            const moonActi = readActivity(row.querySelector('[data-moon-id] .activity'));
            const debris = readDebris(pos);
            const debrisFlag = debris > 0 ? 'si' : 'no';
            const now = Date.now();
            const bucketTs = floorToBucket(now);
            const coordKey = coords.galaxy + ':' + coords.system + ':' + pos;

            queueObservation({
                playerKey: targetKey,
                playerName: playerName || 'Desconocido',
                coords: coordKey,
                planet: planetActi,
                moon: moonActi,
                debris: debrisFlag,
                seenAt: now,
                bucketTs: bucketTs
            });
        }
    }

    function openDb() {
        if (dbPromise) {
            return dbPromise;
        }
        dbPromise = openDbInternal(true).then((db) => {
            if (GM_getValue(KEY_CLEANED, 'false') !== 'true') {
                return cleanupUnknowns(db)
                    .then(() => {
                        GM_setValue(KEY_CLEANED, 'true');
                        return db;
                    })
                    .catch(() => db);
            }
            return db;
        });
        return dbPromise;
    }

    function openDbInternal(allowReset) {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB not supported'));
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_PLAYERS)) {
                    db.createObjectStore(STORE_PLAYERS, { keyPath: 'playerKey' });
                }
                if (!db.objectStoreNames.contains(STORE_BUCKETS)) {
                    const store = db.createObjectStore(STORE_BUCKETS, { keyPath: 'id' });
                    store.createIndex('byPlayer', 'playerKey', { unique: false });
                    store.createIndex('byBucketTs', 'bucketTs', { unique: false });
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_PLAYERS) || !db.objectStoreNames.contains(STORE_BUCKETS)) {
                    db.close();
                    if (allowReset) {
                        const del = indexedDB.deleteDatabase(DB_NAME);
                        del.onsuccess = () => {
                            dbPromise = openDbInternal(false);
                            dbPromise.then(resolve).catch(reject);
                        };
                        del.onerror = () => reject(del.error);
                    } else {
                        reject(new Error('Missing object stores'));
                    }
                    return;
                }
                resolve(db);
            };
            request.onerror = () => reject(request.error);
        });
    }

    function clearDatabase() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(DB_NAME);
            req.onsuccess = () => {
                dbPromise = null;
                resolve();
            };
            req.onerror = () => reject(req.error);
        });
    }

    function queueObservation(obs) {
        queueSlaveActivitySync(obs);
        dbQueue = dbQueue.then(() => recordObservation(obs)).catch((err) => {
            console.log('[PTRE Local] DB error', err);
            setStatus('DB error');
        });
    }

    function cleanupUnknowns(db) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_BUCKETS], 'readwrite');
            const store = tx.objectStore(STORE_BUCKETS);
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                const val = cursor.value;
                if (!val.coords || val.coords === 'unknown') {
                    store.delete(cursor.primaryKey);
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    function recordObservation(obs) {
        return openDb().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_PLAYERS, STORE_BUCKETS], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);

            const players = tx.objectStore(STORE_PLAYERS);
            players.put({
                playerKey: obs.playerKey,
                playerName: obs.playerName,
                lastSeen: obs.seenAt
            });

            const buckets = tx.objectStore(STORE_BUCKETS);
            const bucketId = obs.playerKey + '|' + obs.coords + '|' + obs.bucketTs;
            const req = buckets.get(bucketId);
            req.onsuccess = () => {
                const rec = req.result || {
                    id: bucketId,
                    playerKey: obs.playerKey,
                    playerName: obs.playerName,
                    coords: obs.coords,
                    bucketTs: obs.bucketTs,
                    entries: [],
                    lastUpdated: obs.seenAt
                };
                rec.playerName = obs.playerName || rec.playerName;
                rec.coords = obs.coords || rec.coords;
                const newEntry = { t: obs.seenAt, planet: obs.planet, moon: obs.moon, debris: obs.debris };
                if (!rec.entries || rec.entries.length === 0 || obs.seenAt >= rec.lastUpdated) {
                    rec.entries = [newEntry];
                    rec.lastUpdated = obs.seenAt;
                }
                buckets.put(rec);
            };
        }));
    }

    function openHistoryWindow() {
        if (isSyncHost()) {
            ensureHistoryBridge();
        }
        const win = window.open('', 'ptreLocalHistory', 'width=1200,height=700');
        if (!win) {
            setStatus('Popup bloqueado');
            return;
        }
        const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>PTRE Local Historial</title>
<style>
body { font: 12px/1.4 "Courier New", monospace; background: #0f1317; color: #d7dee5; margin: 0; padding: 10px; }
h2 { color: #9ccf5f; margin: 12px 0 6px; }
.meta { color: #b3bcc6; margin-bottom: 8px; }
.player-block { margin-bottom: 18px; }
.table-wrap { overflow-x: auto; border: 1px solid #000; background: #171d22; padding: 6px; }
table { border-collapse: collapse; font-size: 11px; }
th, td { border: 1px solid #000; padding: 2px 4px; min-width: 70px; vertical-align: top; }
th { position: sticky; top: 0; background: #0f1317; z-index: 1; }
.row-title { background: #0f1317; font-weight: bold; }
.cell-empty { color: #44505a; }
#controls { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; }
#controls label { display: flex; gap: 6px; align-items: center; }
#controls select { background: #171d22; color: #d7dee5; border: 1px solid #000; padding: 2px 4px; }
#controls button { background: #25303a; color: #d7dee5; border: 1px solid #000; padding: 2px 6px; cursor: pointer; }
#controls .danger { background: #5c1a1a; }
.cell-planet span, .cell-moon span, .cell-debris span { padding: 0 4px; border-radius: 2px; display: inline-block; }
.bg-red { background: #d43635; color: #fff; }
.bg-yellow { background: #d2a900; color: #111; }
.bg-green { background: #2e7d32; color: #fff; }
</style>
</head>
<body>
<h2>PTRE Local Historial</h2>
<div class="meta">Selecciona jugador y fecha.</div>
<div id="controls">
  <label>Jugador:
    <select id="playerSelect">
      <option value="">-- Selecciona --</option>
    </select>
  </label>
  <label>Fecha:
    <select id="dateSelect" disabled>
      <option value="">-- Selecciona --</option>
    </select>
  </label>
  <button id="datePrev" title="Anterior">&lt;</button>
  <button id="dateToday" title="Hoy">Hoy</button>
  <button id="dateNext" title="Siguiente">&gt;</button>
  <button id="refreshNow" title="Actualizar">Actualizar</button>
  <button id="clearPlayer" class="danger" title="Borrar jugador">Borrar jugador</button>
</div>
<div id="root"></div>
<script>
(function() {
    const DB_NAME = ${JSON.stringify(DB_NAME)};
    const DB_VERSION = ${DB_VERSION};
    const STORE_PLAYERS = ${JSON.stringify(STORE_PLAYERS)};
    const STORE_BUCKETS = ${JSON.stringify(STORE_BUCKETS)};
    const BUCKET_MS = ${BUCKET_MS};
    const RANGE_HOURS = ${DEFAULT_RANGE_HOURS};
    const REMOTE_HISTORY_ONLY = ${JSON.stringify(isSyncHost())};
    const HISTORY_BRIDGE_REQUEST = ${JSON.stringify(HISTORY_BRIDGE_REQUEST)};
    const HISTORY_BRIDGE_RESPONSE = ${JSON.stringify(HISTORY_BRIDGE_RESPONSE)};
    const HISTORY_BRIDGE_TIMEOUT_MS = ${HISTORY_BRIDGE_TIMEOUT_MS};
    const REMOTE_REFRESH_MS = 15000;
    let remoteDataset = { players: [], buckets: [] };
    let remoteLoadedAt = 0;

    function openDb() {
        return openDbInternal(true);
    }

    function openDbInternal(allowReset) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_PLAYERS)) {
                    db.createObjectStore(STORE_PLAYERS, { keyPath: 'playerKey' });
                }
                if (!db.objectStoreNames.contains(STORE_BUCKETS)) {
                    const store = db.createObjectStore(STORE_BUCKETS, { keyPath: 'id' });
                    store.createIndex('byPlayer', 'playerKey', { unique: false });
                    store.createIndex('byBucketTs', 'bucketTs', { unique: false });
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_PLAYERS) || !db.objectStoreNames.contains(STORE_BUCKETS)) {
                    db.close();
                    if (allowReset) {
                        const del = indexedDB.deleteDatabase(DB_NAME);
                        del.onsuccess = () => {
                            openDbInternal(false).then(resolve).catch(reject);
                        };
                        del.onerror = () => reject(del.error);
                    } else {
                        reject(new Error('Missing object stores'));
                    }
                    return;
                }
                resolve(db);
            };
            request.onerror = () => reject(request.error);
        });
    }

    function floorToBucket(ts) {
        return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    }

    function formatTime(ts) {
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function dateKey(ts) {
        const d = new Date(ts);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    }

    function parseDateKey(key) {
        const parts = key.split('-');
        return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }

    function setRootMessage(root, text) {
        root.innerHTML = '';
        const line = document.createElement('div');
        line.className = 'meta';
        line.textContent = text;
        root.appendChild(line);
    }

    function requestRemotePayloadThroughBridge() {
        return new Promise((resolve, reject) => {
            if (!window.opener || window.opener.closed) {
                reject(new Error('ventana master no disponible'));
                return;
            }
            const reqId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
            let done = false;
            const timer = setTimeout(() => {
                if (done) {
                    return;
                }
                done = true;
                window.removeEventListener('message', onMessage);
                reject(new Error('timeout bridge'));
            }, HISTORY_BRIDGE_TIMEOUT_MS);
            const onMessage = (event) => {
                const data = event && event.data;
                if (!data || typeof data !== 'object' || Array.isArray(data)) {
                    return;
                }
                if (data.type !== HISTORY_BRIDGE_RESPONSE || data.reqId !== reqId) {
                    return;
                }
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                if (data.error) {
                    reject(new Error(String(data.error)));
                    return;
                }
                resolve(data.payload || {});
            };
            window.addEventListener('message', onMessage);
            try {
                window.opener.postMessage({
                    type: HISTORY_BRIDGE_REQUEST,
                    reqId: reqId
                }, '*');
            } catch (err) {
                clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                reject(new Error('no se pudo pedir datos al master'));
            }
        });
    }

    function normalizeActivityValue(value) {
        const raw = String(value || '-').trim();
        if (raw === '*') {
            return '*';
        }
        if (raw === '-') {
            return '-';
        }
        if (/^\\d+$/.test(raw)) {
            return raw;
        }
        return '-';
    }

    function normalizeDebrisValue(value) {
        return String(value || '').trim().toLowerCase() === 'si' ? 'si' : 'no';
    }

    function normalizeRemoteDataset(payload) {
        const data = { players: [], buckets: [] };
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return data;
        }
        const activity = payload.activity;
        if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
            return data;
        }

        const playersMap = new Map();
        const rawPlayers = activity.players;
        if (rawPlayers && typeof rawPlayers === 'object' && !Array.isArray(rawPlayers)) {
            Object.keys(rawPlayers).forEach((key) => {
                const rec = rawPlayers[key];
                if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
                    return;
                }
                const playerKey = String(rec.playerKey || key || '').trim();
                if (!playerKey) {
                    return;
                }
                const lastSeen = Number(rec.lastSeen || 0);
                playersMap.set(playerKey, {
                    playerKey: playerKey,
                    playerName: String(rec.playerName || playerKey).trim() || playerKey,
                    lastSeen: Number.isFinite(lastSeen) ? lastSeen : 0
                });
            });
        }

        const rawBuckets = activity.buckets;
        if (rawBuckets && typeof rawBuckets === 'object' && !Array.isArray(rawBuckets)) {
            Object.keys(rawBuckets).forEach((id) => {
                const rec = rawBuckets[id];
                if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
                    return;
                }
                const playerKey = String(rec.playerKey || '').trim();
                const bucketTs = Number(rec.bucketTs || 0);
                if (!playerKey || !Number.isFinite(bucketTs) || bucketTs <= 0) {
                    return;
                }
                const coords = String(rec.coords || 'unknown').trim() || 'unknown';
                const entries = [];
                if (Array.isArray(rec.entries)) {
                    rec.entries.forEach((entry) => {
                        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                            return;
                        }
                        const t = Number(entry.t || 0);
                        if (!Number.isFinite(t) || t <= 0) {
                            return;
                        }
                        entries.push({
                            t: t,
                            planet: normalizeActivityValue(entry.planet),
                            moon: normalizeActivityValue(entry.moon),
                            debris: normalizeDebrisValue(entry.debris)
                        });
                    });
                }
                const lastUpdatedRaw = Number(rec.lastUpdated || 0);
                const lastUpdated = Number.isFinite(lastUpdatedRaw) && lastUpdatedRaw > 0
                    ? lastUpdatedRaw
                    : (entries.length > 0 ? entries[entries.length - 1].t : bucketTs);
                const playerName = String(rec.playerName || playerKey).trim() || playerKey;
                data.buckets.push({
                    id: String(rec.id || id || (playerKey + '|' + coords + '|' + bucketTs)),
                    playerKey: playerKey,
                    playerName: playerName,
                    coords: coords,
                    bucketTs: bucketTs,
                    entries: entries,
                    lastUpdated: lastUpdated
                });
                const existing = playersMap.get(playerKey);
                if (!existing || lastUpdated >= (existing.lastSeen || 0)) {
                    playersMap.set(playerKey, {
                        playerKey: playerKey,
                        playerName: playerName,
                        lastSeen: lastUpdated
                    });
                }
            });
        }

        data.players = Array.from(playersMap.values());
        return data;
    }

    async function fetchRemoteDataset() {
        const payload = await requestRemotePayloadThroughBridge();
        return normalizeRemoteDataset(payload);
    }

    async function ensureRemoteDataset(forceRefresh) {
        if (!REMOTE_HISTORY_ONLY) {
            return remoteDataset;
        }
        const now = Date.now();
        if (!forceRefresh && remoteLoadedAt > 0 && (now - remoteLoadedAt) < REMOTE_REFRESH_MS) {
            return remoteDataset;
        }
        remoteDataset = await fetchRemoteDataset();
        remoteLoadedAt = now;
        return remoteDataset;
    }

    async function getSource(options) {
        const opts = options || {};
        if (REMOTE_HISTORY_ONLY) {
            return ensureRemoteDataset(Boolean(opts.forceRemote));
        }
        return openDb();
    }

    async function loadPlayers(source) {
        if (REMOTE_HISTORY_ONLY) {
            return Array.isArray(source.players) ? source.players.slice() : [];
        }
        return new Promise((resolve, reject) => {
            const tx = source.transaction([STORE_PLAYERS], 'readonly');
            const store = tx.objectStore(STORE_PLAYERS);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async function loadDatesForPlayer(source, playerKey) {
        if (REMOTE_HISTORY_ONLY) {
            const dates = new Set();
            const list = Array.isArray(source.buckets) ? source.buckets : [];
            list.forEach((rec) => {
                if (rec.playerKey === playerKey) {
                    dates.add(dateKey(rec.bucketTs));
                }
            });
            return Array.from(dates).sort();
        }
        return new Promise((resolve, reject) => {
            const tx = source.transaction([STORE_BUCKETS], 'readonly');
            const store = tx.objectStore(STORE_BUCKETS);
            const idx = store.index('byPlayer');
            const dates = new Set();
            const req = idx.openCursor(IDBKeyRange.only(playerKey));
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve(Array.from(dates).sort());
                    return;
                }
                const val = cursor.value;
                dates.add(dateKey(val.bucketTs));
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    async function loadBucketsForPlayer(source, playerKey, startTs, endTs) {
        if (REMOTE_HISTORY_ONLY) {
            const list = Array.isArray(source.buckets) ? source.buckets : [];
            return list.filter((rec) => rec.playerKey === playerKey && rec.bucketTs >= startTs && rec.bucketTs <= endTs);
        }
        return new Promise((resolve, reject) => {
            const tx = source.transaction([STORE_BUCKETS], 'readonly');
            const store = tx.objectStore(STORE_BUCKETS);
            const idx = store.index('byPlayer');
            const list = [];
            const req = idx.openCursor(IDBKeyRange.only(playerKey));
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve(list);
                    return;
                }
                const val = cursor.value;
                if (val.bucketTs >= startTs && val.bucketTs <= endTs) {
                    list.push(val);
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    async function deletePlayerData(db, playerKey) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_PLAYERS, STORE_BUCKETS], 'readwrite');
            const players = tx.objectStore(STORE_PLAYERS);
            const buckets = tx.objectStore(STORE_BUCKETS);
            const idx = buckets.index('byPlayer');
            players.delete(playerKey);
            const req = idx.openCursor(IDBKeyRange.only(playerKey));
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                buckets.delete(cursor.primaryKey);
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    function formatActivityValue(value, type) {
        if (type === 'debris') {
            const cls = value === 'si' ? 'bg-red' : 'bg-green';
            return '<span class="' + cls + '">' + value + '</span>';
        }
        if (value === '*') {
            return '<span class="bg-red">*</span>';
        }
        if (value && value !== '-') {
            return '<span class="bg-yellow">' + value + '</span>';
        }
        return '<span class="bg-green">-</span>';
    }

    function formatCell(rec) {
        if (!rec) {
            return '';
        }
        if (rec.entries && rec.entries.length > 0) {
            const e = rec.entries[rec.entries.length - 1];
            return '<div class="cell-planet">P:' + formatActivityValue(e.planet, 'planet') + '</div>' +
                   '<div class="cell-moon">L:' + formatActivityValue(e.moon, 'moon') + '</div>' +
                   '<div class="cell-debris">D:' + formatActivityValue(e.debris, 'debris') + '</div>';
        }
        // Backward compatibility if old arrays exist
        if (rec.planet || rec.moon || rec.debris) {
            const lines = [];
            const p = rec.planet || [];
            const m = rec.moon || [];
            const d = rec.debris || [];
            const max = Math.max(p.length, m.length, d.length);
            for (let i = 0; i < max; i++) {
                const pt = p[i] ? (formatTime(p[i].t) + ' P:' + p[i].v) : '';
                const mt = m[i] ? (' L:' + m[i].v) : '';
                const dt = d[i] ? (' D:' + d[i].v) : '';
                const line = (pt + mt + dt).trim();
                if (line) {
                    lines.push(line);
                }
            }
            return lines.join('<br>');
        }
        return '';
    }

    function setDateOption(dateSelect, value) {
        if (!value) {
            return;
        }
        dateSelect.value = value;
        dateSelect.dispatchEvent(new Event('change'));
    }

    function getDateOptions(dateSelect) {
        return Array.from(dateSelect.options)
            .map((opt) => opt.value)
            .filter((v) => v);
    }

    function adjustDate(dateSelect, direction) {
        const values = getDateOptions(dateSelect);
        if (values.length === 0) {
            return;
        }
        const current = dateSelect.value;
        if (!current) {
            setDateOption(dateSelect, values[0]);
            return;
        }
        const idx = values.indexOf(current);
        if (idx === -1) {
            setDateOption(dateSelect, values[0]);
            return;
        }
        const nextIdx = Math.min(values.length - 1, Math.max(0, idx + direction));
        setDateOption(dateSelect, values[nextIdx]);
    }

    function ensureControls() {
        if (document.getElementById('controls')) {
            return;
        }
        const meta = document.querySelector('.meta');
        const controls = document.createElement('div');
        controls.id = 'controls';
        controls.innerHTML =
            '<label>Jugador:' +
              '<select id="playerSelect">' +
                '<option value="">-- Selecciona --</option>' +
              '</select>' +
            '</label>' +
            '<label>Fecha:' +
              '<select id="dateSelect" disabled>' +
                '<option value="">-- Selecciona --</option>' +
              '</select>' +
            '</label>' +
            '<button id="datePrev" title="Anterior">&lt;</button>' +
            '<button id="dateToday" title="Hoy">Hoy</button>' +
            '<button id="dateNext" title="Siguiente">&gt;</button>' +
            '<button id="refreshNow" title="Actualizar">Actualizar</button>' +
            '<button id="clearPlayer" class="danger" title="Borrar jugador">Borrar jugador</button>';
        if (meta && meta.nextSibling) {
            meta.parentNode.insertBefore(controls, meta.nextSibling);
        } else {
            document.body.appendChild(controls);
        }
    }

    async function render() {
        ensureControls();
        const root = document.getElementById('root');
        const playerSelect = document.getElementById('playerSelect');
        const dateSelect = document.getElementById('dateSelect');
        const datePrev = document.getElementById('datePrev');
        const dateToday = document.getElementById('dateToday');
        const dateNext = document.getElementById('dateNext');
        const refreshNow = document.getElementById('refreshNow');
        const clearPlayer = document.getElementById('clearPlayer');
        const meta = document.querySelector('.meta');
        if (meta) {
            meta.textContent = REMOTE_HISTORY_ONLY
                ? 'Fuente: historial remoto del slave. Pulsa Actualizar para recargar.'
                : 'Selecciona jugador y fecha.';
        }

        let source;
        try {
            source = await getSource({ forceRemote: true });
        } catch (err) {
            playerSelect.innerHTML = '<option value="">-- Selecciona --</option>';
            dateSelect.innerHTML = '<option value="">-- Selecciona --</option>';
            dateSelect.disabled = true;
            setRootMessage(root, 'Error cargando historial remoto: ' + (err && err.message ? err.message : 'desconocido'));
            return;
        }

        const players = await loadPlayers(source);
        players.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

        const currentPlayer = playerSelect.value;
        playerSelect.innerHTML = '<option value="">-- Selecciona --</option>';
        players.forEach((p) => {
            const opt = document.createElement('option');
            opt.value = p.playerKey;
            opt.textContent = p.playerName || p.playerKey;
            playerSelect.appendChild(opt);
        });
        if (currentPlayer) {
            playerSelect.value = currentPlayer;
        }

        if (!playerSelect.dataset.bound) {
            playerSelect.dataset.bound = 'true';
            playerSelect.addEventListener('change', async () => {
                root.innerHTML = '';
                dateSelect.innerHTML = '<option value="">-- Selecciona --</option>';
                dateSelect.disabled = true;
                const key = playerSelect.value;
                if (!key) {
                    return;
                }
                let sourceNow;
                try {
                    sourceNow = await getSource({ forceRemote: REMOTE_HISTORY_ONLY });
                } catch (err) {
                    setRootMessage(root, 'Error cargando fechas: ' + (err && err.message ? err.message : 'desconocido'));
                    return;
                }
                const dates = await loadDatesForPlayer(sourceNow, key);
                dates.forEach((d) => {
                    const opt = document.createElement('option');
                    opt.value = d;
                    opt.textContent = d;
                    dateSelect.appendChild(opt);
                });
                dateSelect.disabled = false;
            });
        }

        if (!dateSelect.dataset.bound) {
            dateSelect.dataset.bound = 'true';
            dateSelect.addEventListener('change', async () => {
                const playerKey = playerSelect.value;
                const dateKeyStr = dateSelect.value;
                if (!playerKey || !dateKeyStr) {
                    root.innerHTML = '';
                    return;
                }
                const dateObj = parseDateKey(dateKeyStr);
                const startTs = floorToBucket(dateObj.getTime());
                const endTs = floorToBucket(dateObj.getTime() + 24 * 60 * 60 * 1000 - BUCKET_MS);
                const bucketTimes = [];
                for (let t = startTs; t <= endTs; t += BUCKET_MS) {
                    bucketTimes.push(t);
                }

                let sourceNow;
                try {
                    sourceNow = await getSource({ forceRemote: REMOTE_HISTORY_ONLY });
                } catch (err) {
                    setRootMessage(root, 'Error cargando datos: ' + (err && err.message ? err.message : 'desconocido'));
                    return;
                }
                const bucketList = await loadBucketsForPlayer(sourceNow, playerKey, startTs, endTs);
                const bucketsByCoord = new Map();
                bucketList.forEach((rec) => {
                    const coord = rec.coords || 'unknown';
                    if (!bucketsByCoord.has(coord)) {
                        bucketsByCoord.set(coord, {});
                    }
                    bucketsByCoord.get(coord)[rec.bucketTs] = rec;
                });

                let html = '';
                html += '<div class="player-block">';
                html += '<div class="meta">Jugador: ' + (playerSelect.options[playerSelect.selectedIndex].textContent || playerKey) + '</div>';
                html += '<div class="table-wrap"><table><thead><tr>';
                html += '<th class="row-title">Coords</th>';
                for (const t of bucketTimes) {
                    html += '<th>' + formatTime(t) + '</th>';
                }
                html += '</tr></thead><tbody>';

                const coordsList = Array.from(bucketsByCoord.keys()).filter((coord) => coord !== 'unknown').sort();
                for (const coord of coordsList) {
                    html += '<tr><td class="row-title">' + coord + '</td>';
                    for (const t of bucketTimes) {
                        const rec = bucketsByCoord.get(coord)[t];
                        const content = formatCell(rec);
                        if (content) {
                            html += '<td>' + content + '</td>';
                        } else {
                            html += '<td class="cell-empty"></td>';
                        }
                    }
                    html += '</tr>';
                }
                html += '</tbody></table></div></div>';
                root.innerHTML = html || '<div class="meta">Sin datos</div>';
            });
        }

        if (!datePrev.dataset.bound) {
            datePrev.dataset.bound = 'true';
            datePrev.addEventListener('click', () => adjustDate(dateSelect, -1));
        }
        if (!dateNext.dataset.bound) {
            dateNext.dataset.bound = 'true';
            dateNext.addEventListener('click', () => adjustDate(dateSelect, 1));
        }
        if (!dateToday.dataset.bound) {
            dateToday.dataset.bound = 'true';
            dateToday.addEventListener('click', () => {
                const todayKey = dateKey(Date.now());
                setDateOption(dateSelect, todayKey);
            });
        }
        if (refreshNow && !refreshNow.dataset.bound) {
            refreshNow.dataset.bound = 'true';
            refreshNow.addEventListener('click', () => {
                root.innerHTML = '';
                if (playerSelect.value && dateSelect.value) {
                    dateSelect.dispatchEvent(new Event('change'));
                    return;
                }
                if (playerSelect.value) {
                    playerSelect.dispatchEvent(new Event('change'));
                    return;
                }
                render();
            });
        }
        if (clearPlayer) {
            clearPlayer.style.display = REMOTE_HISTORY_ONLY ? 'none' : '';
        }
        if (!REMOTE_HISTORY_ONLY && clearPlayer && !clearPlayer.dataset.bound) {
            clearPlayer.dataset.bound = 'true';
            clearPlayer.addEventListener('click', async () => {
                const playerKey = playerSelect.value;
                if (!playerKey) {
                    window.alert('Selecciona un jugador.');
                    return;
                }
                const ok = window.confirm('¿Borrar el historial del jugador seleccionado?');
                if (!ok) {
                    return;
                }
                const dbNow = await getSource();
                await deletePlayerData(dbNow, playerKey);
                playerSelect.value = '';
                dateSelect.value = '';
                dateSelect.disabled = true;
                root.innerHTML = '';
                render();
            });
        }

        if (!playerSelect.value) {
            root.innerHTML = '';
        }
    }

    render();
})();
<\/script>
</body>
</html>
        `;
        win.document.open();
        win.document.write(html);
        win.document.close();
    }

    function waitForGalaxyToBeLoaded() {
        const galaxyLoading = document.getElementById('galaxyLoading');
        if (!galaxyLoading) {
            return;
        }
        if (window.getComputedStyle(galaxyLoading).display === 'none') {
            onGalaxyReady();
        } else {
            const observer = new MutationObserver((mutations, obs) => {
                if (window.getComputedStyle(galaxyLoading).display === 'none') {
                    obs.disconnect();
                    onGalaxyReady();
                }
            });
            observer.observe(galaxyLoading, { childList: true, attributes: true });
        }
    }

    function watchGalaxyChanges() {
        const galaxyLoading = document.getElementById('galaxyLoading');
        if (!galaxyLoading) {
            return;
        }
        const observer = new MutationObserver((mutations, obs) => {
            if (window.getComputedStyle(galaxyLoading).display !== 'none') {
                obs.disconnect();
                waitForGalaxyToBeLoaded();
                watchGalaxyChanges();
            }
        });
        observer.observe(galaxyLoading, { childList: true, attributes: true });
    }

    ensurePanel();
    updateTargetPanel();
    startTargetsSync();
    if (isGalaxy) {
        waitForGalaxyToBeLoaded();
        watchGalaxyChanges();
    } else {
        setStatus('Panel activo (fuera de Galaxia)');
    }
})();
