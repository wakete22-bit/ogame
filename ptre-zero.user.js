// ==UserScript==
// @name         PTRE Zero
// @namespace    https://openuserjs.org/users/GeGe_GM
// @version      1.0.0
// @description  Master/slave simple, remote history only.
// @match        https://*.ogame.gameforge.com/game/*
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

    const VERSION = '1.0.0';
    const PANEL_ID = 'ptreZeroPanel';
    const ICON_CLASS = 'ptreZeroTargetIcon';
    const ICON_ACTIVE_CLASS = 'ptreZeroTargetIconActive';

    const KEY_MODE = 'ptreZeroMode';
    const KEY_ENDPOINT = 'ptreZeroEndpoint';
    const KEY_TOKEN = 'ptreZeroToken';
    const KEY_SELECTED_TARGET = 'ptreZeroSelectedTarget';
    const KEY_SELECTED_DATE = 'ptreZeroSelectedDate';
    const KEY_INTERVAL_MS = 'ptreZeroIntervalMs';
    const KEY_SLAVE_ID = 'ptreZeroSlaveId';
    const KEY_RUNTIME = 'ptreZeroSlaveRuntime';

    const DEFAULT_MODE = 'off';
    const DEFAULT_ENDPOINT = '';
    const DEFAULT_TOKEN = '';
    const DEFAULT_INTERVAL_MS = 60000;
    const HOST_POLL_MS = 8000;
    const SLAVE_POLL_MS = 4000;
    const STEP_DELAY_MS = 1200;
    const STEP_TIMEOUT_MS = 15000;
    const TOKEN_HEADER = 'x-ptre-token';
    const BUCKET_MS = 5 * 60 * 1000;

    const isGalaxy = /component=galaxy/.test(location.href);

    let mode = normalizeMode(GM_getValue(KEY_MODE, DEFAULT_MODE));
    let endpoint = String(GM_getValue(KEY_ENDPOINT, DEFAULT_ENDPOINT) || '').trim();
    let token = String(GM_getValue(KEY_TOKEN, DEFAULT_TOKEN) || '').trim();
    let selectedTargetKey = String(GM_getValue(KEY_SELECTED_TARGET, '') || '').trim();
    let selectedDateKey = String(GM_getValue(KEY_SELECTED_DATE, '') || '').trim();
    let slaveId = String(GM_getValue(KEY_SLAVE_ID, '') || '').trim();
    if (!slaveId) {
        slaveId = 'slave-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        GM_setValue(KEY_SLAVE_ID, slaveId);
    }

    let panelStatus = '';
    let remoteState = createRemoteState();
    let historyDatesCache = new Map();
    let historyDayCache = new Map();
    let historyHtml = '<div class="ptreZeroMeta">Sin cargar</div>';
    let historyLoading = false;
    let hostPollTimer = null;
    let slavePollTimer = null;
    let hostPollingInFlight = false;
    let slavePollingInFlight = false;
    let galaxyObserver = null;
    let runtime = loadRuntime();

    if (!/\/game\//.test(location.pathname)) {
        return;
    }

    GM_addStyle(buildCss());
    ensurePanel();
    bindGalaxyObserver();
    renderPanel();
    startLoops();

    function buildCss() {
        return `
#${PANEL_ID} {
    position: fixed;
    top: 88px;
    right: 12px;
    width: 370px;
    max-height: calc(100vh - 100px);
    overflow: auto;
    z-index: 999999;
    background: rgba(12, 18, 24, 0.97);
    color: #d6dee6;
    border: 1px solid #000;
    box-shadow: 0 6px 18px rgba(0,0,0,0.4);
    font: 12px/1.35 Arial, sans-serif;
}
#${PANEL_ID} .zeroHead {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px;
    background: #121920;
    border-bottom: 1px solid #000;
}
#${PANEL_ID} .zeroTitle {
    color: #9fd861;
    font-weight: bold;
}
#${PANEL_ID} .zeroBody {
    padding: 8px 10px 12px;
}
#${PANEL_ID} .zeroRow {
    margin-bottom: 8px;
}
#${PANEL_ID} .zeroMeta {
    color: #b5c0ca;
}
#${PANEL_ID} .zeroStatus {
    color: #d6dee6;
}
#${PANEL_ID} .zeroBox {
    border: 1px solid #000;
    background: #171f26;
    padding: 6px;
}
#${PANEL_ID} button,
#${PANEL_ID} select {
    font: 12px Arial, sans-serif;
}
#${PANEL_ID} button {
    cursor: pointer;
    border: 1px solid #000;
    background: #2a333d;
    color: #d6dee6;
    padding: 4px 6px;
}
#${PANEL_ID} button:hover {
    background: #35414c;
}
#${PANEL_ID} button.danger {
    background: #642626;
}
#${PANEL_ID} select {
    width: 100%;
    box-sizing: border-box;
    padding: 4px;
    background: #1a232b;
    color: #d6dee6;
    border: 1px solid #000;
}
#${PANEL_ID} .zeroButtons3 {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
}
#${PANEL_ID} .zeroButtons2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
}
#${PANEL_ID} .zeroCoords {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
#${PANEL_ID} .zeroCoord {
    padding: 3px 5px;
    border: 1px solid #000;
    background: #243140;
    color: #d6dee6;
}
#${PANEL_ID} .zeroCoord.primary {
    background: #335b23;
}
#${PANEL_ID} .zeroHistory {
    overflow-x: auto;
    border: 1px solid #000;
    background: #171f26;
    padding: 6px;
}
#${PANEL_ID} table {
    border-collapse: collapse;
    font-size: 11px;
}
#${PANEL_ID} th,
#${PANEL_ID} td {
    border: 1px solid #000;
    padding: 2px 4px;
    min-width: 48px;
    text-align: center;
    vertical-align: top;
}
#${PANEL_ID} th {
    position: sticky;
    top: 0;
    background: #121920;
}
#${PANEL_ID} .zeroRowTitle {
    background: #121920;
    min-width: 82px;
}
#${PANEL_ID} .zeroGreen { background: #234223; display: block; }
#${PANEL_ID} .zeroYellow { background: #6f5d1c; display: block; }
#${PANEL_ID} .zeroRed { background: #6b2525; display: block; }
#${PANEL_ID} .zeroDebrisYes { color: #f8b95b; display: block; }
#${PANEL_ID} .zeroDebrisNo { color: #98a2ad; display: block; }
.${ICON_CLASS} {
    display: inline-block;
    margin-left: 6px;
    font-weight: bold;
    cursor: pointer;
    color: #6f7a86;
}
.${ICON_CLASS}.${ICON_ACTIVE_CLASS} {
    color: #9fd861;
}
        `;
    }

    function createRemoteState() {
        return {
            updatedAt: 0,
            targets: {},
            command: null,
            slave: {
                online: false,
                state: 'idle',
                currentSystem: '',
                progressIndex: 0,
                progressTotal: 0,
                activeCommandId: '',
                lastError: '',
                lastSeenAt: 0
            }
        };
    }

    function createRuntime() {
        return {
            active: false,
            commandId: '',
            mode: 'once',
            playerKey: '',
            queue: [],
            index: 0,
            intervalMs: DEFAULT_INTERVAL_MS,
            waiting: false,
            currentSystem: '',
            currentCoord: '',
            lastError: '',
            sleepingUntil: 0
        };
    }

    function normalizeMode(value) {
        const normalized = String(value || '').trim().toLowerCase();
        return normalized === 'host' || normalized === 'slave' ? normalized : 'off';
    }

    function isHost() {
        return mode === 'host';
    }

    function isSlave() {
        return mode === 'slave';
    }

    function isConfigured() {
        return /^https?:\/\//i.test(endpoint);
    }

    function txt(value) {
        return String(value || '').trim();
    }

    function coord(value) {
        const raw = txt(value);
        if (!raw) {
            return '';
        }
        const parts = raw.split(':');
        if (parts.length !== 3) {
            return '';
        }
        const nums = parts.map((part) => Number(part));
        if (nums.some((num) => !Number.isFinite(num) || num <= 0)) {
            return '';
        }
        return nums.join(':');
    }

    function systemCoord(value) {
        const normalized = coord(value);
        if (!normalized) {
            return '';
        }
        const parts = normalized.split(':');
        return parts[0] + ':' + parts[1];
    }

    function compareCoords(a, b) {
        const pa = String(a || '').split(':').map((part) => Number(part));
        const pb = String(b || '').split(':').map((part) => Number(part));
        if (pa.length !== 3 || pb.length !== 3) {
            return String(a || '').localeCompare(String(b || ''));
        }
        for (let i = 0; i < 3; i += 1) {
            const na = Number.isFinite(pa[i]) ? pa[i] : 0;
            const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
            if (na !== nb) {
                return na - nb;
            }
        }
        return 0;
    }

    function normalizeName(text) {
        return String(text || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function floorBucket(ts) {
        return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    }

    function buildTargetKey(playerId, playerName) {
        if (Number.isFinite(playerId) && playerId > 0) {
            return 'id:' + playerId;
        }
        return 'name:' + (playerName || 'unknown');
    }

    function candidateKeys(playerId, playerName) {
        const keys = [];
        const primary = buildTargetKey(playerId, playerName);
        if (primary) {
            keys.push(primary);
        }
        const nameKey = 'name:' + (playerName || 'unknown');
        if (nameKey && !keys.includes(nameKey)) {
            keys.push(nameKey);
        }
        return keys;
    }

    function findTargetKey(targets, playerId, playerName) {
        const map = targets && typeof targets === 'object' ? targets : {};
        const possible = candidateKeys(playerId, playerName);
        for (const key of possible) {
            if (Object.prototype.hasOwnProperty.call(map, key)) {
                return key;
            }
        }
        const name = normalizeName(playerName);
        if (!name) {
            return '';
        }
        const keys = Object.keys(map);
        for (const key of keys) {
            const rec = map[key];
            if (!rec || typeof rec !== 'object') {
                continue;
            }
            if (normalizeName(rec.playerName || '') === name) {
                return key;
            }
        }
        return '';
    }

    function saveRuntime() {
        GM_setValue(KEY_RUNTIME, JSON.stringify(runtime));
    }

    function clearRuntime() {
        runtime = createRuntime();
        saveRuntime();
    }

    function loadRuntime() {
        const raw = String(GM_getValue(KEY_RUNTIME, '') || '');
        if (!raw) {
            return createRuntime();
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return createRuntime();
            }
            return {
                active: Boolean(parsed.active),
                commandId: txt(parsed.commandId),
                mode: txt(parsed.mode) === 'continuous' ? 'continuous' : 'once',
                playerKey: txt(parsed.playerKey),
                queue: Array.isArray(parsed.queue) ? parsed.queue.map(coord).filter(Boolean) : [],
                index: Math.max(0, Number(parsed.index || 0)),
                intervalMs: Math.max(10000, Number(parsed.intervalMs || DEFAULT_INTERVAL_MS)),
                waiting: Boolean(parsed.waiting),
                currentSystem: systemCoord(parsed.currentSystem) || '',
                currentCoord: coord(parsed.currentCoord) || '',
                lastError: txt(parsed.lastError),
                sleepingUntil: Math.max(0, Number(parsed.sleepingUntil || 0))
            };
        } catch (err) {
            return createRuntime();
        }
    }

    function api(pathname, params) {
        const base = endpoint.replace(/\/+$/, '');
        let url = base + pathname;
        if (params && typeof params === 'object') {
            const query = Object.keys(params)
                .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
                .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])))
                .join('&');
            if (query) {
                url += (url.includes('?') ? '&' : '?') + query;
            }
        }
        return url;
    }

    function requestJson(method, pathname, payload, params) {
        if (!isConfigured()) {
            return Promise.reject(new Error('sync no configurado'));
        }
        return new Promise((resolve, reject) => {
            const details = {
                method: method,
                url: api(pathname, params),
                timeout: 15000,
                headers: {}
            };
            if (token) {
                details.headers[TOKEN_HEADER] = token;
            }
            if (payload !== undefined) {
                details.data = JSON.stringify(payload);
                details.headers['Content-Type'] = 'application/json';
            }
            details.onload = (response) => {
                const body = String(response.responseText || '');
                let json = {};
                try {
                    json = body ? JSON.parse(body) : {};
                } catch (err) {
                    reject(new Error('respuesta JSON invalida'));
                    return;
                }
                if (response.status >= 200 && response.status < 300) {
                    resolve(json);
                    return;
                }
                reject(new Error(json && json.error ? json.error : ('HTTP ' + response.status)));
            };
            details.onerror = () => reject(new Error('network error'));
            details.ontimeout = () => reject(new Error('timeout'));
            GM_xmlhttpRequest(details);
        });
    }

    function setPanelStatus(message) {
        panelStatus = txt(message);
        renderPanel();
    }

    function ensurePanel() {
        let panel = document.getElementById(PANEL_ID);
        if (panel) {
            return panel;
        }
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        document.body.appendChild(panel);
        return panel;
    }

    function buildIntervalOptions() {
        const current = Math.max(10000, Number(GM_getValue(KEY_INTERVAL_MS, DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS));
        const values = [30000, 60000, 120000, 300000];
        return values.map((value) => {
            const label = value < 60000 ? (value / 1000) + 's' : (value / 60000) + 'm';
            return '<option value="' + value + '"' + (value === current ? ' selected' : '') + '>' + label + '</option>';
        }).join('');
    }

    function renderPanel() {
        const panel = ensurePanel();
        const targets = remoteState.targets && typeof remoteState.targets === 'object' ? remoteState.targets : {};
        const keys = Object.keys(targets).sort((a, b) => {
            const aName = txt(targets[a] && targets[a].playerName ? targets[a].playerName : a).toLowerCase();
            const bName = txt(targets[b] && targets[b].playerName ? targets[b].playerName : b).toLowerCase();
            return aName.localeCompare(bName);
        });
        if (selectedTargetKey && !keys.includes(selectedTargetKey)) {
            selectedTargetKey = '';
            selectedDateKey = '';
            GM_setValue(KEY_SELECTED_TARGET, '');
            GM_setValue(KEY_SELECTED_DATE, '');
        }
        if (!selectedTargetKey && keys.length > 0) {
            selectedTargetKey = keys[0];
            GM_setValue(KEY_SELECTED_TARGET, selectedTargetKey);
        }
        const selectedTarget = selectedTargetKey ? targets[selectedTargetKey] : null;
        const coords = selectedTarget && Array.isArray(selectedTarget.coords)
            ? selectedTarget.coords.slice().sort(compareCoords)
            : [];
        const coordsHtml = coords.length
            ? coords.map((value) => {
                const isPrimary = selectedTarget && selectedTarget.primaryCoord === value;
                return '<button class="zeroCoord' + (isPrimary ? ' primary' : '') + '" data-coord="' + value + '">' +
                    value + (isPrimary ? ' *' : '') + '</button>';
            }).join('')
            : '<div class="zeroMeta">Sin coordenadas</div>';

        const slave = remoteState.slave || createRemoteState().slave;
        const slaveSummary = isConfigured()
            ? ((slave.online ? 'online' : 'offline') +
                ' | ' + (slave.state || 'idle') +
                (slave.currentSystem ? ' | ' + slave.currentSystem : '') +
                ((slave.progressTotal || 0) > 0 ? ' | ' + (slave.progressIndex || 0) + '/' + (slave.progressTotal || 0) : '') +
                (slave.lastError ? ' | error: ' + escapeHtml(slave.lastError) : ''))
            : 'sync no configurado';

        const statusText = panelStatus || ('Modo ' + mode + ' | ' + slaveSummary);
        const targetOptions = ['<option value="">-- Selecciona --</option>'].concat(
            keys.map((key) => {
                const rec = targets[key];
                const label = escapeHtml(txt(rec && rec.playerName ? rec.playerName : key) || key);
                return '<option value="' + key + '"' + (key === selectedTargetKey ? ' selected' : '') + '>' + label + '</option>';
            })
        ).join('');
        const dates = historyDatesCache.get(selectedTargetKey) || [];
        const dateOptions = ['<option value="">-- Selecciona --</option>'].concat(
            dates.map((value) => '<option value="' + value + '"' + (value === selectedDateKey ? ' selected' : '') + '>' + value + '</option>')
        ).join('');

        const hostHtml = isHost() ? `
            <div class="zeroRow">
                <select id="zeroTargetSelect">${targetOptions}</select>
            </div>
            <div class="zeroRow">
                <div class="zeroBox"><div class="zeroCoords">${coordsHtml}</div></div>
            </div>
            <div class="zeroRow">
                <div class="zeroButtons3">
                    <button id="zeroRunOnce">Recorrer</button>
                    <button id="zeroRunContinuous">Continuo</button>
                    <button id="zeroStop" class="danger">Parar</button>
                </div>
            </div>
            <div class="zeroRow">
                <div class="zeroButtons2">
                    <button id="zeroDeleteTarget" class="danger">Eliminar objetivo</button>
                    <select id="zeroInterval">${buildIntervalOptions()}</select>
                </div>
            </div>
            <div class="zeroRow">
                <div class="zeroButtons2">
                    <select id="zeroDateSelect">${dateOptions}</select>
                    <button id="zeroRefreshHistory">${historyLoading ? 'Cargando...' : 'Actualizar historial'}</button>
                </div>
            </div>
            <div class="zeroRow">
                <div class="zeroHistory" id="zeroHistoryRoot">${historyHtml}</div>
            </div>
        ` : '';

        const slaveHtml = isSlave() ? `
            <div class="zeroRow">
                <div class="zeroBox">
                    <div class="zeroMeta">Slave: ${escapeHtml(slaveId)}</div>
                    <div class="zeroMeta">Runtime: ${runtime.active ? 'activo' : 'idle'}${runtime.currentSystem ? ' | ' + escapeHtml(runtime.currentSystem) : ''}</div>
                    <div class="zeroMeta">Command: ${escapeHtml(runtime.commandId || '-')}</div>
                </div>
            </div>
        ` : '';

        panel.innerHTML = `
            <div class="zeroHead">
                <div class="zeroTitle">PTRE Zero</div>
                <button id="zeroConfig">Sync...</button>
            </div>
            <div class="zeroBody">
                <div class="zeroRow zeroStatus">v${VERSION} | ${statusText}</div>
                <div class="zeroRow zeroMeta">Endpoint: ${escapeHtml(endpoint || '(sin configurar)')}</div>
                <div class="zeroRow zeroMeta">Slave remoto: ${slaveSummary}</div>
                ${hostHtml}
                ${slaveHtml}
            </div>
        `;

        bindPanelEvents();
    }

    function bindPanelEvents() {
        const configBtn = document.getElementById('zeroConfig');
        if (configBtn) {
            configBtn.onclick = configureSync;
        }

        const targetSelect = document.getElementById('zeroTargetSelect');
        if (targetSelect) {
            targetSelect.onchange = async () => {
                selectedTargetKey = txt(targetSelect.value);
                selectedDateKey = '';
                GM_setValue(KEY_SELECTED_TARGET, selectedTargetKey);
                GM_setValue(KEY_SELECTED_DATE, '');
                historyHtml = '<div class="zeroMeta">Cargando...</div>';
                renderPanel();
                await loadHistory(false);
            };
        }

        const intervalSelect = document.getElementById('zeroInterval');
        if (intervalSelect) {
            intervalSelect.onchange = () => {
                GM_setValue(KEY_INTERVAL_MS, Math.max(10000, Number(intervalSelect.value || DEFAULT_INTERVAL_MS)));
            };
        }

        const runOnceBtn = document.getElementById('zeroRunOnce');
        if (runOnceBtn) {
            runOnceBtn.onclick = () => startSelectedCommand('once');
        }
        const runContBtn = document.getElementById('zeroRunContinuous');
        if (runContBtn) {
            runContBtn.onclick = () => startSelectedCommand('continuous');
        }
        const stopBtn = document.getElementById('zeroStop');
        if (stopBtn) {
            stopBtn.onclick = stopRemoteSlave;
        }
        const deleteBtn = document.getElementById('zeroDeleteTarget');
        if (deleteBtn) {
            deleteBtn.onclick = deleteSelectedTarget;
        }
        const dateSelect = document.getElementById('zeroDateSelect');
        if (dateSelect) {
            dateSelect.onchange = async () => {
                selectedDateKey = txt(dateSelect.value);
                GM_setValue(KEY_SELECTED_DATE, selectedDateKey);
                await loadHistory(false);
            };
        }
        const refreshHistoryBtn = document.getElementById('zeroRefreshHistory');
        if (refreshHistoryBtn) {
            refreshHistoryBtn.onclick = async () => {
                if (!selectedTargetKey) {
                    return;
                }
                historyDatesCache.delete(selectedTargetKey);
                if (selectedDateKey) {
                    historyDayCache.delete(selectedTargetKey + '|' + selectedDateKey);
                }
                await loadHistory(true);
            };
        }

        document.querySelectorAll('#' + PANEL_ID + ' .zeroCoord').forEach((button) => {
            button.onclick = async () => {
                if (!isHost() || !selectedTargetKey) {
                    return;
                }
                const value = coord(button.getAttribute('data-coord'));
                if (!value) {
                    return;
                }
                try {
                    await requestJson('POST', '/master/target/primary', {
                        playerKey: selectedTargetKey,
                        coord: value
                    });
                    await refreshHostState();
                    await loadHistory(false);
                } catch (err) {
                    setPanelStatus('Error guardando principal: ' + err.message);
                }
            };
        });
    }

    async function configureSync() {
        const nextMode = normalizeMode(window.prompt('Modo: off | host | slave', mode));
        const nextEndpoint = window.prompt('Endpoint base Zero (ej: http://IP:8790/zero)', endpoint);
        if (nextEndpoint === null) {
            return;
        }
        const nextToken = window.prompt('Token', token);
        if (nextToken === null) {
            return;
        }
        mode = nextMode;
        endpoint = String(nextEndpoint || '').trim().replace(/\/+$/, '');
        token = String(nextToken || '').trim();
        GM_setValue(KEY_MODE, mode);
        GM_setValue(KEY_ENDPOINT, endpoint);
        GM_setValue(KEY_TOKEN, token);
        panelStatus = 'Configuracion guardada';
        if (!isSlave()) {
            clearRuntime();
        }
        remoteState = createRemoteState();
        historyDatesCache = new Map();
        historyDayCache = new Map();
        historyHtml = '<div class="zeroMeta">Sin cargar</div>';
        renderPanel();
        startLoops();
    }

    function startLoops() {
        if (hostPollTimer) {
            clearInterval(hostPollTimer);
            hostPollTimer = null;
        }
        if (slavePollTimer) {
            clearInterval(slavePollTimer);
            slavePollTimer = null;
        }
        if (isHost()) {
            refreshHostState();
            hostPollTimer = setInterval(refreshHostState, HOST_POLL_MS);
        }
        if (isSlave()) {
            restoreOrAdvanceRuntime();
            slavePoll();
            slavePollTimer = setInterval(slavePoll, SLAVE_POLL_MS);
        }
        renderPanel();
    }

    async function refreshHostState() {
        if (!isHost() || !isConfigured() || hostPollingInFlight) {
            return;
        }
        hostPollingInFlight = true;
        try {
            const payload = await requestJson('GET', '/state');
            applyRemoteState(payload);
            if (isGalaxy) {
                paintGalaxyIcons();
            }
            if (selectedTargetKey && !historyDatesCache.has(selectedTargetKey)) {
                loadHistory(false).catch(() => {});
            }
            renderPanel();
        } catch (err) {
            setPanelStatus('Sync host error: ' + err.message);
        } finally {
            hostPollingInFlight = false;
        }
    }

    async function slavePoll() {
        if (!isSlave() || !isConfigured() || slavePollingInFlight) {
            return;
        }
        slavePollingInFlight = true;
        try {
            const payload = await requestJson('POST', '/slave/poll', buildSlavePollPayload());
            if (payload && payload.targets && typeof payload.targets === 'object') {
                remoteState.targets = payload.targets;
            }
            if (payload && payload.slave && typeof payload.slave === 'object') {
                remoteState.slave = payload.slave;
            }
            if (payload && payload.command) {
                applyCommand(payload.command);
            }
            restoreOrAdvanceRuntime();
            renderPanel();
        } catch (err) {
            setPanelStatus('Sync slave error: ' + err.message);
        } finally {
            slavePollingInFlight = false;
        }
    }

    function applyRemoteState(payload) {
        remoteState.updatedAt = Number(payload && payload.updatedAt || 0);
        remoteState.targets = payload && payload.targets && typeof payload.targets === 'object'
            ? payload.targets
            : {};
        remoteState.command = payload && payload.command ? payload.command : null;
        remoteState.slave = payload && payload.slave && typeof payload.slave === 'object'
            ? payload.slave
            : createRemoteState().slave;
    }

    function buildSlavePollPayload() {
        return {
            slaveId: slaveId,
            state: runtime.active ? (runtime.waiting ? 'waiting' : 'running') : 'idle',
            currentSystem: runtime.currentSystem,
            progressIndex: runtime.index,
            progressTotal: runtime.queue.length,
            activeCommandId: runtime.commandId,
            lastError: runtime.lastError
        };
    }

    async function startSelectedCommand(commandMode) {
        if (!isHost()) {
            return;
        }
        if (!selectedTargetKey) {
            window.alert('Selecciona un objetivo.');
            return;
        }
        try {
            await requestJson('POST', '/master/command/start', {
                playerKey: selectedTargetKey,
                mode: commandMode,
                intervalMs: Math.max(10000, Number(GM_getValue(KEY_INTERVAL_MS, DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS))
            });
            await refreshHostState();
            setPanelStatus(commandMode === 'continuous' ? 'Continuo enviado al slave' : 'Recorrido enviado al slave');
        } catch (err) {
            setPanelStatus('Error lanzando orden: ' + err.message);
        }
    }

    async function stopRemoteSlave() {
        if (!isHost()) {
            return;
        }
        try {
            await requestJson('POST', '/master/command/stop', {});
            await refreshHostState();
            setPanelStatus('Parada enviada al slave');
        } catch (err) {
            setPanelStatus('Error parando slave: ' + err.message);
        }
    }

    async function deleteSelectedTarget() {
        if (!isHost() || !selectedTargetKey) {
            return;
        }
        if (!window.confirm('¿Eliminar objetivo seleccionado?')) {
            return;
        }
        try {
            await requestJson('POST', '/master/target/delete', {
                playerKey: selectedTargetKey
            });
            historyDatesCache.delete(selectedTargetKey);
            selectedTargetKey = '';
            selectedDateKey = '';
            GM_setValue(KEY_SELECTED_TARGET, '');
            GM_setValue(KEY_SELECTED_DATE, '');
            historyHtml = '<div class="zeroMeta">Objetivo eliminado</div>';
            await refreshHostState();
        } catch (err) {
            setPanelStatus('Error eliminando objetivo: ' + err.message);
        }
    }

    async function loadHistory(force) {
        if (!isHost()) {
            historyHtml = '<div class="zeroMeta">Historial solo en master</div>';
            renderPanel();
            return;
        }
        if (!selectedTargetKey) {
            historyHtml = '<div class="zeroMeta">Selecciona un objetivo</div>';
            renderPanel();
            return;
        }
        historyLoading = true;
        renderPanel();
        try {
            let dates = historyDatesCache.get(selectedTargetKey);
            if (!dates || force) {
                const response = await requestJson('GET', '/history/dates', undefined, {
                    playerKey: selectedTargetKey
                });
                dates = Array.isArray(response && response.dates) ? response.dates : [];
                historyDatesCache.set(selectedTargetKey, dates);
            }
            if (!selectedDateKey || !dates.includes(selectedDateKey)) {
                selectedDateKey = dates.length ? dates[dates.length - 1] : '';
                GM_setValue(KEY_SELECTED_DATE, selectedDateKey);
            }
            if (!selectedDateKey) {
                historyHtml = '<div class="zeroMeta">Sin datos todavía para este objetivo</div>';
                return;
            }
            const cacheKey = selectedTargetKey + '|' + selectedDateKey;
            let day = historyDayCache.get(cacheKey);
            if (!day || force) {
                day = await requestJson('GET', '/history/day', undefined, {
                    playerKey: selectedTargetKey,
                    date: selectedDateKey
                });
                historyDayCache.set(cacheKey, day);
            }
            historyHtml = renderHistoryDay(day);
        } catch (err) {
            historyHtml = '<div class="zeroMeta">Error cargando historial: ' + escapeHtml(err.message) + '</div>';
        } finally {
            historyLoading = false;
            renderPanel();
        }
    }

    function renderHistoryDay(day) {
        if (!day || !Array.isArray(day.buckets) || day.buckets.length === 0) {
            return '<div class="zeroMeta">Sin datos en la fecha seleccionada</div>';
        }
        const start = floorBucket(new Date(day.date + 'T00:00:00').getTime());
        const end = start + (24 * 60 * 60 * 1000) - BUCKET_MS;
        const slots = [];
        for (let ts = start; ts <= end; ts += BUCKET_MS) {
            slots.push(ts);
        }
        const byCoord = new Map();
        day.buckets.forEach((bucket) => {
            const key = coord(bucket.coords) || 'unknown';
            if (!byCoord.has(key)) {
                byCoord.set(key, {});
            }
            byCoord.get(key)[bucket.bucketTs] = bucket;
        });
        const coords = Array.from(byCoord.keys()).filter((value) => value !== 'unknown').sort(compareCoords);
        let html = '<div class="zeroMeta">Jugador: ' + escapeHtml(day.player && day.player.playerName ? day.player.playerName : day.player.playerKey) + '</div>';
        html += '<table><thead><tr><th class="zeroRowTitle">Coords</th>';
        slots.forEach((ts) => {
            html += '<th>' + formatTime(ts) + '</th>';
        });
        html += '</tr></thead><tbody>';
        coords.forEach((value) => {
            const isPrimary = day.player && day.player.primaryCoord === value;
            html += '<tr><td class="zeroRowTitle">' + escapeHtml(value) + (isPrimary ? '<br>*Principal*' : '') + '</td>';
            slots.forEach((ts) => {
                html += '<td>' + renderBucketCell(byCoord.get(value)[ts]) + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
    }

    function renderBucketCell(bucket) {
        if (!bucket || !Array.isArray(bucket.entries) || bucket.entries.length === 0) {
            return '';
        }
        const entry = bucket.entries[bucket.entries.length - 1];
        return '<span class="' + activityClass(entry.planet) + '">P:' + escapeHtml(txt(entry.planet || '-')) + '</span>' +
            '<span class="' + activityClass(entry.moon) + '">L:' + escapeHtml(txt(entry.moon || '-')) + '</span>' +
            '<span class="' + (txt(entry.debris) === 'si' ? 'zeroDebrisYes' : 'zeroDebrisNo') + '">D:' + escapeHtml(txt(entry.debris || 'no')) + '</span>';
    }

    function activityClass(value) {
        const raw = txt(value || '-');
        if (raw === '*') {
            return 'zeroRed';
        }
        if (raw !== '-') {
            return 'zeroYellow';
        }
        return 'zeroGreen';
    }

    function formatTime(ts) {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function bindGalaxyObserver() {
        if (!isGalaxy || galaxyObserver) {
            return;
        }
        const loading = document.getElementById('galaxyLoading');
        if (!loading) {
            return;
        }
        const onGalaxyReady = () => {
            if (isHost()) {
                paintGalaxyIcons();
            }
            if (isSlave()) {
                maybeCaptureSystem();
            }
        };
        if (window.getComputedStyle(loading).display === 'none') {
            onGalaxyReady();
        }
        galaxyObserver = new MutationObserver(() => {
            if (window.getComputedStyle(loading).display === 'none') {
                onGalaxyReady();
            }
        });
        galaxyObserver.observe(loading, { attributes: true, childList: true });
    }

    function paintGalaxyIcons() {
        if (!isGalaxy) {
            return;
        }
        const targets = remoteState.targets && typeof remoteState.targets === 'object' ? remoteState.targets : {};
        for (let pos = 1; pos <= 15; pos += 1) {
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
            let icon = cellPlayerName.querySelector('.' + ICON_CLASS);
            if (!icon) {
                icon = document.createElement('span');
                icon.className = ICON_CLASS;
                icon.textContent = '●';
                cellPlayerName.appendChild(icon);
            }
            const playerName = getPlayerName(row, cellPlayerName);
            const playerId = getPlayerId(cellPlayerName);
            const existingKey = findTargetKey(targets, playerId, playerName);
            icon.classList.toggle(ICON_ACTIVE_CLASS, Boolean(existingKey));
            icon.title = isHost() ? (existingKey ? 'Quitar objetivo' : 'Añadir objetivo') : 'Solo master';
            icon.onclick = async (event) => {
                event.stopPropagation();
                if (!isHost()) {
                    setPanelStatus('Solo el master puede editar objetivos');
                    return;
                }
                if (!isConfigured()) {
                    setPanelStatus('Configura sync primero');
                    return;
                }
                try {
                    const currentSystem = readCurrentSystem();
                    const currentCoord = currentSystem
                        ? coord(currentSystem.galaxy + ':' + currentSystem.system + ':' + pos)
                        : '';
                    if (existingKey) {
                        await requestJson('POST', '/master/target/delete', {
                            playerKey: existingKey
                        });
                        if (selectedTargetKey === existingKey) {
                            selectedTargetKey = '';
                            selectedDateKey = '';
                            GM_setValue(KEY_SELECTED_TARGET, '');
                            GM_setValue(KEY_SELECTED_DATE, '');
                            historyHtml = '<div class="zeroMeta">Objetivo eliminado</div>';
                        }
                    } else {
                        const playerKey = buildTargetKey(playerId, playerName);
                        await requestJson('POST', '/master/target/upsert', {
                            playerKey: playerKey,
                            playerName: playerName,
                            coord: currentCoord
                        });
                        selectedTargetKey = playerKey;
                        GM_setValue(KEY_SELECTED_TARGET, selectedTargetKey);
                        const runNow = window.confirm('Objetivo añadido. ¿Lanzar recorrido del slave ahora?');
                        if (runNow) {
                            await requestJson('POST', '/master/command/start', {
                                playerKey: playerKey,
                                mode: 'once',
                                intervalMs: Math.max(10000, Number(GM_getValue(KEY_INTERVAL_MS, DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS))
                            });
                        }
                    }
                    historyDatesCache = new Map();
                    historyDayCache = new Map();
                    await refreshHostState();
                    if (selectedTargetKey) {
                        await loadHistory(true);
                    } else {
                        renderPanel();
                    }
                } catch (err) {
                    setPanelStatus('Error editando objetivo: ' + err.message);
                }
            };
        }
    }

    function readCurrentSystem() {
        const galaxyInput = document.querySelector('input#galaxy_input');
        const systemInput = document.querySelector('input#system_input');
        if (!galaxyInput || !systemInput) {
            return null;
        }
        return {
            galaxy: txt(galaxyInput.value),
            system: txt(systemInput.value)
        };
    }

    function getPlayerName(row, cellPlayerName) {
        let name = '';
        const node = row.querySelector('.galaxyCell .playerName.tooltipRel');
        if (node && node.childNodes[0]) {
            name = txt(node.childNodes[0].textContent);
        }
        if (!name) {
            const ownRow = cellPlayerName.querySelector('.ownPlayerRow');
            if (ownRow) {
                name = txt(ownRow.textContent);
            }
        }
        if (!name) {
            name = txt(cellPlayerName.textContent);
        }
        return name;
    }

    function getPlayerId(cellPlayerName) {
        const span = cellPlayerName.querySelector('span[rel^="player"]');
        if (!span) {
            return -1;
        }
        const rel = txt(span.getAttribute('rel'));
        const id = Number(rel.replace(/\D/g, ''));
        return Number.isFinite(id) && id > 0 ? id : -1;
    }

    function readActivity(element) {
        if (!element) {
            return '-';
        }
        if (element.classList.contains('minute15')) {
            return '*';
        }
        if (element.classList.contains('showMinutes')) {
            return txt(element.textContent) || '-';
        }
        return '-';
    }

    function readDebris(position) {
        let debris = 0;
        document.querySelectorAll('#debris' + position + ' .ListLinks .debris-content').forEach((node) => {
            const parts = String(node.textContent || '').split(':');
            let value = parts[1] ? parts[1].trim() : '0';
            value = value.replace(/[^\d]/g, '');
            const num = Number(value);
            if (Number.isFinite(num)) {
                debris += num;
            }
        });
        return debris > 0 ? 'si' : 'no';
    }

    function applyCommand(command) {
        if (!isSlave() || !command || typeof command !== 'object') {
            return;
        }
        if (command.type === 'stop') {
            if (runtime.active || runtime.commandId === txt(command.commandId)) {
                runtime.active = false;
                runtime.waiting = false;
                runtime.lastError = '';
                saveRuntime();
                ackStop(command.commandId).catch(() => {});
            }
            return;
        }
        if (command.type !== 'scan') {
            return;
        }
        const commandId = txt(command.commandId);
        if (runtime.active && runtime.commandId === commandId) {
            return;
        }
        runtime = {
            active: true,
            commandId: commandId,
            mode: txt(command.mode) === 'continuous' ? 'continuous' : 'once',
            playerKey: txt(command.playerKey),
            queue: Array.isArray(command.queue) ? command.queue.map(coord).filter(Boolean) : [],
            index: 0,
            intervalMs: Math.max(10000, Number(command.intervalMs || DEFAULT_INTERVAL_MS)),
            waiting: false,
            currentSystem: '',
            currentCoord: '',
            lastError: '',
            sleepingUntil: 0
        };
        saveRuntime();
    }

    async function ackStop(commandId) {
        if (!isConfigured()) {
            return;
        }
        clearRuntime();
        await requestJson('POST', '/slave/report', {
            slaveId: slaveId,
            activeCommandId: txt(commandId),
            ackStop: true,
            state: 'idle',
            currentSystem: '',
            progressIndex: 0,
            progressTotal: 0,
            lastError: ''
        });
    }

    async function completeCommand() {
        const commandId = runtime.commandId;
        clearRuntime();
        if (!isConfigured()) {
            return;
        }
        await requestJson('POST', '/slave/report', {
            slaveId: slaveId,
            activeCommandId: commandId,
            complete: true,
            state: 'idle',
            currentSystem: '',
            progressIndex: 0,
            progressTotal: 0,
            lastError: ''
        });
    }

    function restoreOrAdvanceRuntime() {
        if (!isSlave() || !runtime.active) {
            return;
        }
        if (!Array.isArray(runtime.queue) || runtime.queue.length === 0) {
            completeCommand().catch(() => {});
            return;
        }
        if (runtime.index >= runtime.queue.length) {
            if (runtime.mode === 'continuous') {
                if (!runtime.sleepingUntil) {
                    runtime.sleepingUntil = Date.now() + runtime.intervalMs;
                    saveRuntime();
                }
                if (Date.now() >= runtime.sleepingUntil) {
                    runtime.index = 0;
                    runtime.sleepingUntil = 0;
                    runtime.waiting = false;
                    runtime.currentSystem = '';
                    runtime.currentCoord = '';
                    saveRuntime();
                }
                return;
            }
            completeCommand().catch(() => {});
            return;
        }
        if (!isGalaxy) {
            navigateToGalaxy();
            return;
        }
        if (runtime.waiting) {
            maybeCaptureSystem();
            return;
        }
        navigateToQueuedSystem();
    }

    function navigateToGalaxy() {
        const url = location.origin + '/game/index.php?page=ingame&component=galaxy';
        location.assign(url);
    }

    function navigateToQueuedSystem() {
        const targetCoord = coord(runtime.queue[runtime.index]);
        if (!targetCoord) {
            runtime.index += 1;
            saveRuntime();
            return;
        }
        runtime.currentCoord = targetCoord;
        runtime.currentSystem = systemCoord(targetCoord);
        runtime.waiting = true;
        runtime.lastError = '';
        saveRuntime();
        const ok = goToCoord(targetCoord);
        if (!ok) {
            runtime.waiting = false;
            runtime.lastError = 'No se pudo navegar a ' + targetCoord;
            runtime.index += 1;
            saveRuntime();
        }
    }

    async function maybeCaptureSystem() {
        if (!isSlave() || !runtime.active || !runtime.waiting) {
            return;
        }
        const current = readCurrentSystem();
        if (!current) {
            return;
        }
        const currentSystem = systemCoord(current.galaxy + ':' + current.system + ':1');
        if (!currentSystem || currentSystem !== runtime.currentSystem) {
            return;
        }
        runtime.waiting = false;
        saveRuntime();
        const batch = collectObservationsForCurrentSystem();
        try {
            await requestJson('POST', '/slave/report', {
                slaveId: slaveId,
                activeCommandId: runtime.commandId,
                state: 'running',
                currentSystem: runtime.currentSystem,
                progressIndex: runtime.index + 1,
                progressTotal: runtime.queue.length,
                lastError: runtime.lastError,
                batch: batch
            });
        } catch (err) {
            runtime.lastError = err.message;
        }
        runtime.index += 1;
        saveRuntime();
        setTimeout(() => {
            restoreOrAdvanceRuntime();
        }, STEP_DELAY_MS);
    }

    function collectObservationsForCurrentSystem() {
        const current = readCurrentSystem();
        if (!current) {
            return [];
        }
        const batch = [];
        const targets = remoteState.targets && typeof remoteState.targets === 'object' ? remoteState.targets : {};
        for (let pos = 1; pos <= 15; pos += 1) {
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
            const playerKey = findTargetKey(targets, playerId, playerName);
            if (!playerKey) {
                continue;
            }
            batch.push({
                playerKey: playerKey,
                playerName: playerName || playerKey,
                coords: current.galaxy + ':' + current.system + ':' + pos,
                planet: readActivity(row.querySelector('[data-planet-id] .activity')),
                moon: readActivity(row.querySelector('[data-moon-id] .activity')),
                debris: readDebris(pos),
                seenAt: Date.now(),
                bucketTs: floorBucket(Date.now())
            });
        }
        return batch;
    }

    function goToCoord(targetCoord) {
        const parts = String(targetCoord || '').split(':').map((part) => Number(part));
        if (parts.length !== 3 || parts.some((num) => !Number.isFinite(num))) {
            return false;
        }
        const [g, s, p] = parts;
        const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (page.galaxy && typeof page.galaxy.updateGalaxy === 'function') {
            try {
                page.galaxy.updateGalaxy(g, s, p);
                setTimeout(() => {
                    if (runtime.active && runtime.waiting && runtime.currentCoord === targetCoord) {
                        runtime.waiting = false;
                        runtime.lastError = 'Timeout en ' + targetCoord;
                        runtime.index += 1;
                        saveRuntime();
                        restoreOrAdvanceRuntime();
                    }
                }, STEP_TIMEOUT_MS);
                return true;
            } catch (err) {
                // fallback
            }
        }

        const galaxyInput = document.querySelector('input#galaxy_input');
        const systemInput = document.querySelector('input#system_input');
        const positionInput = document.querySelector('input#position_input');
        if (galaxyInput) {
            galaxyInput.value = g;
            galaxyInput.dispatchEvent(new Event('input', { bubbles: true }));
            galaxyInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (systemInput) {
            systemInput.value = s;
            systemInput.dispatchEvent(new Event('input', { bubbles: true }));
            systemInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (positionInput) {
            positionInput.value = p;
            positionInput.dispatchEvent(new Event('input', { bubbles: true }));
            positionInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (page.galaxy && typeof page.galaxy.submitGalaxy === 'function') {
            try {
                page.galaxy.submitGalaxy();
                setTimeout(() => {
                    if (runtime.active && runtime.waiting && runtime.currentCoord === targetCoord) {
                        runtime.waiting = false;
                        runtime.lastError = 'Timeout en ' + targetCoord;
                        runtime.index += 1;
                        saveRuntime();
                        restoreOrAdvanceRuntime();
                    }
                }, STEP_TIMEOUT_MS);
                return true;
            } catch (err) {
                return false;
            }
        }
        return false;
    }
})();
