// ==UserScript==
// @name         PTRE Galaxy V2
// @namespace    https://openuserjs.org/users/GeGe_GM
// @version      2.0.0
// @description  Master/slave simple with remote-only history.
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

    const VERSION = '2.0.0';
    const PANEL_ID = 'ptreV2Panel';
    const KEY_MODE = 'ptreV2Mode';
    const KEY_ENDPOINT = 'ptreV2Endpoint';
    const KEY_TOKEN = 'ptreV2Token';
    const KEY_SLAVE_ID = 'ptreV2SlaveId';
    const KEY_SELECTED_TARGET = 'ptreV2SelectedTarget';
    const KEY_SELECTED_DATE = 'ptreV2SelectedDate';
    const ICON_CLASS = 'ptreV2TargetIcon';
    const ICON_ACTIVE_CLASS = 'ptreV2TargetIconActive';
    const DEFAULT_ENDPOINT = '';
    const DEFAULT_TOKEN = '';
    const STATUS_POLL_MS = 4000;
    const SLAVE_POLL_MS = 3000;
    const STEP_DELAY_MS = 1200;
    const STEP_TIMEOUT_MS = 15000;
    const DEFAULT_CONTINUOUS_INTERVAL_MS = 60000;
    const TOKEN_HEADER = 'x-ptre-token';
    const BUCKET_MS = 5 * 60 * 1000;

    const isGalaxy = /component=galaxy/.test(location.href);
    let syncMode = normalizeMode(GM_getValue(KEY_MODE, 'off'));
    let syncEndpoint = String(GM_getValue(KEY_ENDPOINT, DEFAULT_ENDPOINT) || '').trim();
    let syncToken = String(GM_getValue(KEY_TOKEN, DEFAULT_TOKEN) || '').trim();
    let slaveId = String(GM_getValue(KEY_SLAVE_ID, '') || '').trim();
    if (!slaveId) {
        slaveId = 'slave-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        GM_setValue(KEY_SLAVE_ID, slaveId);
    }

    let selectedTargetKey = String(GM_getValue(KEY_SELECTED_TARGET, '') || '').trim();
    let selectedDateKey = String(GM_getValue(KEY_SELECTED_DATE, '') || '').trim();
    let panelStatus = '';
    let remoteState = createEmptyRemoteState();
    let historyMetaCache = new Map();
    let historyDayCache = new Map();
    let historyHtml = '<div class="ptreV2Meta">Sin cargar</div>';
    let historyLoading = false;
    let pollingTimer = null;
    let pollingInFlight = false;
    let galaxyObserverBound = false;
    let slaveRuntime = createEmptySlaveRuntime();

    if (!/\/game\//.test(location.pathname)) {
        return;
    }

    GM_addStyle(buildStyles());
    ensurePanel();
    renderPanel();
    if (isGalaxy) {
        installGalaxyWatcher();
        refreshGalaxyIcons();
    }
    restartPolling();

    function buildStyles() {
        return `
#${PANEL_ID} {
    position: fixed;
    right: 12px;
    top: 90px;
    width: 360px;
    max-height: calc(100vh - 110px);
    overflow: auto;
    z-index: 999999;
    background: rgba(12, 18, 24, 0.96);
    color: #d5dde5;
    border: 1px solid #000;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    font: 12px/1.35 Arial, sans-serif;
}
#${PANEL_ID} .ptreV2Head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: #121920;
    border-bottom: 1px solid #000;
    position: sticky;
    top: 0;
    z-index: 2;
}
#${PANEL_ID} .ptreV2Title {
    font-weight: bold;
    color: #91d45a;
}
#${PANEL_ID} .ptreV2Body {
    padding: 8px 10px 12px;
}
#${PANEL_ID} .ptreV2Row {
    margin-bottom: 8px;
}
#${PANEL_ID} .ptreV2Label {
    display: block;
    margin-bottom: 4px;
    color: #b6c0ca;
}
#${PANEL_ID} button,
#${PANEL_ID} select {
    font: 12px Arial, sans-serif;
}
#${PANEL_ID} button {
    cursor: pointer;
    border: 1px solid #000;
    background: #28313a;
    color: #d5dde5;
    padding: 4px 6px;
}
#${PANEL_ID} button:hover {
    background: #33404b;
}
#${PANEL_ID} button.danger {
    background: #5a2222;
}
#${PANEL_ID} select {
    width: 100%;
    box-sizing: border-box;
    background: #182028;
    color: #d5dde5;
    border: 1px solid #000;
    padding: 4px;
}
#${PANEL_ID} .ptreV2Buttons {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
}
#${PANEL_ID} .ptreV2Buttons3 {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
}
#${PANEL_ID} .ptreV2Status {
    color: #b7c2cc;
}
#${PANEL_ID} .ptreV2Meta {
    color: #aeb8c2;
}
#${PANEL_ID} .ptreV2Box {
    border: 1px solid #000;
    background: #161d24;
    padding: 6px;
}
#${PANEL_ID} .ptreV2Coords {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
#${PANEL_ID} .ptreV2Coord {
    border: 1px solid #000;
    background: #21303f;
    color: #d5dde5;
    padding: 3px 5px;
}
#${PANEL_ID} .ptreV2Coord.primary {
    background: #335c22;
}
#${PANEL_ID} .ptreV2History {
    overflow-x: auto;
    border: 1px solid #000;
    background: #161d24;
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
#${PANEL_ID} .ptreV2RowTitle {
    background: #121920;
    min-width: 80px;
}
#${PANEL_ID} .ptreV2Green { background: #214422; display: block; }
#${PANEL_ID} .ptreV2Yellow { background: #6e5a19; display: block; }
#${PANEL_ID} .ptreV2Red { background: #6a2424; display: block; }
#${PANEL_ID} .ptreV2DebrisYes { color: #ffb84a; }
#${PANEL_ID} .ptreV2DebrisNo { color: #97a2ad; }
.${ICON_CLASS} {
    display: inline-block;
    margin-left: 6px;
    cursor: pointer;
    color: #788490;
    font-weight: bold;
}
.${ICON_CLASS}.${ICON_ACTIVE_CLASS} {
    color: #91d45a;
}
        `;
    }

    function createEmptyRemoteState() {
        return {
            updatedAt: 0,
            targets: {},
            runner: {
                currentCommand: null,
                slaveStatus: {
                    online: false,
                    state: 'idle',
                    currentCoord: '',
                    progressIndex: 0,
                    progressTotal: 0,
                    activeCommandId: '',
                    lastError: '',
                    lastSeenAt: 0
                }
            }
        };
    }

    function createEmptySlaveRuntime() {
        return {
            active: false,
            commandId: '',
            mode: 'once',
            queue: [],
            index: 0,
            waiting: false,
            currentCoord: '',
            intervalMs: DEFAULT_CONTINUOUS_INTERVAL_MS,
            cycleTimer: null,
            stepTimer: null,
            timeoutTimer: null,
            lastError: '',
            processing: false
        };
    }

    function normalizeMode(value) {
        const mode = String(value || '').trim().toLowerCase();
        return mode === 'host' || mode === 'slave' ? mode : 'off';
    }

    function isHost() {
        return syncMode === 'host';
    }

    function isSlave() {
        return syncMode === 'slave';
    }

    function isConfigured() {
        return /^https?:\/\//i.test(syncEndpoint);
    }

    function normalizeText(value) {
        return String(value || '').trim();
    }

    function normalizeCoord(coord) {
        const raw = normalizeText(coord);
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

    function normalizeNameForMatch(text) {
        return String(text || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function buildTargetKey(playerId, playerName) {
        if (Number.isFinite(playerId) && playerId > 0) {
            return 'id:' + playerId;
        }
        return 'name:' + (playerName || 'unknown');
    }

    function buildTargetCandidateKeys(playerId, playerName) {
        const keys = [];
        const key = buildTargetKey(playerId, playerName);
        if (key) {
            keys.push(key);
        }
        const nameKey = 'name:' + (playerName || 'unknown');
        if (nameKey && !keys.includes(nameKey)) {
            keys.push(nameKey);
        }
        return keys;
    }

    function findTargetKey(targets, playerId, playerName) {
        const map = targets && typeof targets === 'object' ? targets : {};
        const candidates = buildTargetCandidateKeys(playerId, playerName);
        for (const key of candidates) {
            if (Object.prototype.hasOwnProperty.call(map, key)) {
                return key;
            }
        }
        const normalizedPlayerName = normalizeNameForMatch(playerName);
        if (!normalizedPlayerName) {
            return '';
        }
        const keys = Object.keys(map);
        for (const key of keys) {
            const rec = map[key];
            if (!rec || typeof rec !== 'object') {
                continue;
            }
            if (normalizeNameForMatch(rec.playerName || rec.name || '') === normalizedPlayerName) {
                return key;
            }
        }
        return '';
    }

    function apiUrl(pathname, params) {
        const base = String(syncEndpoint || '').trim().replace(/\/+$/, '');
        const suffix = String(pathname || '').trim();
        const url = new URL(base + suffix, location.href);
        const query = params && typeof params === 'object' ? params : {};
        Object.keys(query).forEach((key) => {
            if (query[key] === undefined || query[key] === null || query[key] === '') {
                return;
            }
            url.searchParams.set(key, String(query[key]));
        });
        return url.toString();
    }

    function requestJson(method, pathname, payload, params) {
        if (!isConfigured()) {
            return Promise.reject(new Error('sync no configurado'));
        }
        return new Promise((resolve, reject) => {
            const details = {
                method: method,
                url: apiUrl(pathname, params),
                timeout: 15000,
                headers: {}
            };
            if (syncToken) {
                details.headers[TOKEN_HEADER] = syncToken;
            }
            if (payload !== undefined) {
                details.data = JSON.stringify(payload);
                details.headers['Content-Type'] = 'application/json';
            }
            details.onload = (response) => {
                const text = response.responseText || '';
                let data = {};
                try {
                    data = text ? JSON.parse(text) : {};
                } catch (err) {
                    reject(new Error('respuesta JSON invalida'));
                    return;
                }
                if (response.status >= 200 && response.status < 300) {
                    resolve(data);
                    return;
                }
                reject(new Error(data && data.error ? data.error : ('HTTP ' + response.status)));
            };
            details.onerror = () => reject(new Error('network error'));
            details.ontimeout = () => reject(new Error('timeout'));
            GM_xmlhttpRequest(details);
        });
    }

    function setPanelStatus(text) {
        panelStatus = String(text || '').trim();
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

    function renderPanel() {
        const panel = ensurePanel();
        const targets = remoteState.targets && typeof remoteState.targets === 'object' ? remoteState.targets : {};
        const targetKeys = Object.keys(targets).sort((a, b) => {
            const an = normalizeText(targets[a] && targets[a].playerName ? targets[a].playerName : a).toLowerCase();
            const bn = normalizeText(targets[b] && targets[b].playerName ? targets[b].playerName : b).toLowerCase();
            return an.localeCompare(bn);
        });
        if (selectedTargetKey && !targetKeys.includes(selectedTargetKey)) {
            selectedTargetKey = '';
            selectedDateKey = '';
            GM_setValue(KEY_SELECTED_TARGET, '');
            GM_setValue(KEY_SELECTED_DATE, '');
        }
        if (!selectedTargetKey && targetKeys.length > 0) {
            selectedTargetKey = targetKeys[0];
            GM_setValue(KEY_SELECTED_TARGET, selectedTargetKey);
        }

        const selectedTarget = selectedTargetKey ? targets[selectedTargetKey] : null;
        const coords = selectedTarget && Array.isArray(selectedTarget.coords)
            ? selectedTarget.coords.slice().sort(compareCoords)
            : [];
        const coordsHtml = coords.length
            ? coords.map((coord) => {
                const isPrimary = selectedTarget && selectedTarget.primaryCoord === coord;
                return '<button class="ptreV2Coord' + (isPrimary ? ' primary' : '') + '" data-coord="' + coord + '">' +
                    coord + (isPrimary ? ' *' : '') + '</button>';
            }).join('')
            : '<div class="ptreV2Meta">Sin coordenadas conocidas</div>';

        const runner = remoteState.runner || {};
        const slaveStatus = runner.slaveStatus || {};
        const slaveStateText = isConfigured()
            ? ((slaveStatus.online ? 'online' : 'offline') +
                ' | ' + (slaveStatus.state || 'idle') +
                (slaveStatus.currentCoord ? ' | ' + slaveStatus.currentCoord : '') +
                ((slaveStatus.progressTotal || 0) > 0 ? ' | ' + (slaveStatus.progressIndex || 0) + '/' + (slaveStatus.progressTotal || 0) : '') +
                (slaveStatus.lastError ? ' | error: ' + slaveStatus.lastError : ''))
            : 'sync no configurado';

        const statusLine = panelStatus || (isConfigured()
            ? ('Modo ' + syncMode + ' | ' + slaveStateText)
            : 'Configura endpoint/token');

        const targetOptions = ['<option value="">-- Selecciona --</option>']
            .concat(targetKeys.map((key) => {
                const rec = targets[key];
                const name = normalizeText(rec && rec.playerName ? rec.playerName : key) || key;
                const selected = key === selectedTargetKey ? ' selected' : '';
                return '<option value="' + key + '"' + selected + '>' + name + '</option>';
            })).join('');

        const historyMeta = selectedTargetKey ? historyMetaCache.get(selectedTargetKey) : null;
        const dateOptions = ['<option value="">-- Selecciona --</option>']
            .concat(historyMeta && Array.isArray(historyMeta.dates)
                ? historyMeta.dates.map((date) => '<option value="' + date + '"' + (date === selectedDateKey ? ' selected' : '') + '>' + date + '</option>')
                : []).join('');

        const hostSection = isHost() ? `
            <div class="ptreV2Row">
                <label class="ptreV2Label">Objetivo</label>
                <select id="ptreV2TargetSelect">${targetOptions}</select>
            </div>
            <div class="ptreV2Row">
                <label class="ptreV2Label">Coordenadas conocidas. Pulsa una para marcarla como principal.</label>
                <div class="ptreV2Box"><div class="ptreV2Coords">${coordsHtml}</div></div>
            </div>
            <div class="ptreV2Row">
                <div class="ptreV2Buttons3">
                    <button id="ptreV2RunOnce">Recorrer slave</button>
                    <button id="ptreV2RunCont">Continuo slave</button>
                    <button id="ptreV2Stop" class="danger">Parar slave</button>
                </div>
            </div>
            <div class="ptreV2Row">
                <div class="ptreV2Buttons">
                    <button id="ptreV2DeleteTarget" class="danger">Eliminar objetivo</button>
                    <select id="ptreV2Interval">
                        ${buildIntervalOptions()}
                    </select>
                </div>
            </div>
            <div class="ptreV2Row">
                <label class="ptreV2Label">Historial</label>
                <div class="ptreV2Buttons">
                    <select id="ptreV2DateSelect">${dateOptions}</select>
                    <button id="ptreV2HistoryRefresh">${historyLoading ? 'Cargando...' : 'Actualizar historial'}</button>
                </div>
            </div>
            <div class="ptreV2Row">
                <div class="ptreV2History" id="ptreV2HistoryRoot">${historyHtml}</div>
            </div>
        ` : '';

        const slaveSection = isSlave() ? `
            <div class="ptreV2Row">
                <div class="ptreV2Box">
                    <div class="ptreV2Meta">Slave: ${slaveId}</div>
                    <div class="ptreV2Meta">Estado local: ${slaveRuntime.active ? 'ejecutando' : 'idle'}${slaveRuntime.currentCoord ? ' | ' + slaveRuntime.currentCoord : ''}</div>
                    <div class="ptreV2Meta">Orden actual: ${slaveRuntime.commandId || '-'}</div>
                </div>
            </div>
        ` : '';

        panel.innerHTML = `
            <div class="ptreV2Head">
                <div class="ptreV2Title">PTRE V2</div>
                <div>
                    <button id="ptreV2Config">Sync...</button>
                </div>
            </div>
            <div class="ptreV2Body">
                <div class="ptreV2Row ptreV2Status">v${VERSION} | ${statusLine}</div>
                <div class="ptreV2Row ptreV2Meta">Endpoint: ${syncEndpoint || '(sin configurar)'}</div>
                <div class="ptreV2Row ptreV2Meta">Slave remoto: ${slaveStateText}</div>
                ${hostSection}
                ${slaveSection}
            </div>
        `;

        bindPanelEvents();
    }

    function buildIntervalOptions() {
        const values = [30000, 60000, 120000, 300000];
        const current = Number(GM_getValue('ptreV2IntervalMs', DEFAULT_CONTINUOUS_INTERVAL_MS) || DEFAULT_CONTINUOUS_INTERVAL_MS);
        return values.map((value) => {
            const label = value < 60000 ? (value / 1000) + 's' : (value / 60000) + 'm';
            return '<option value="' + value + '"' + (value === current ? ' selected' : '') + '>' + label + '</option>';
        }).join('');
    }

    function bindPanelEvents() {
        const configBtn = document.getElementById('ptreV2Config');
        if (configBtn) {
            configBtn.onclick = configureSync;
        }
        const targetSelect = document.getElementById('ptreV2TargetSelect');
        if (targetSelect) {
            targetSelect.onchange = async () => {
                selectedTargetKey = String(targetSelect.value || '').trim();
                selectedDateKey = '';
                GM_setValue(KEY_SELECTED_TARGET, selectedTargetKey);
                GM_setValue(KEY_SELECTED_DATE, '');
                historyHtml = '<div class="ptreV2Meta">Cargando historial...</div>';
                renderPanel();
                await loadHistoryForSelected(true);
            };
        }
        const intervalSelect = document.getElementById('ptreV2Interval');
        if (intervalSelect) {
            intervalSelect.onchange = () => {
                const value = Math.max(10000, Number(intervalSelect.value || DEFAULT_CONTINUOUS_INTERVAL_MS));
                GM_setValue('ptreV2IntervalMs', value);
            };
        }
        const runOnceBtn = document.getElementById('ptreV2RunOnce');
        if (runOnceBtn) {
            runOnceBtn.onclick = () => runSelectedTarget('once');
        }
        const runContBtn = document.getElementById('ptreV2RunCont');
        if (runContBtn) {
            runContBtn.onclick = () => runSelectedTarget('continuous');
        }
        const stopBtn = document.getElementById('ptreV2Stop');
        if (stopBtn) {
            stopBtn.onclick = stopSlaveFromMaster;
        }
        const deleteBtn = document.getElementById('ptreV2DeleteTarget');
        if (deleteBtn) {
            deleteBtn.onclick = deleteSelectedTarget;
        }
        const dateSelect = document.getElementById('ptreV2DateSelect');
        if (dateSelect) {
            dateSelect.onchange = async () => {
                selectedDateKey = String(dateSelect.value || '').trim();
                GM_setValue(KEY_SELECTED_DATE, selectedDateKey);
                await loadHistoryForSelected(false);
            };
        }
        const refreshBtn = document.getElementById('ptreV2HistoryRefresh');
        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                if (!selectedTargetKey) {
                    return;
                }
                historyMetaCache.delete(selectedTargetKey);
                if (selectedDateKey) {
                    historyDayCache.delete(selectedTargetKey + '|' + selectedDateKey);
                }
                await loadHistoryForSelected(true);
            };
        }
        document.querySelectorAll('#' + PANEL_ID + ' .ptreV2Coord').forEach((button) => {
            button.onclick = async () => {
                if (!isHost() || !selectedTargetKey) {
                    return;
                }
                const coord = normalizeCoord(button.getAttribute('data-coord'));
                if (!coord) {
                    return;
                }
                try {
                    await requestJson('POST', '/targets/primary', {
                        playerKey: selectedTargetKey,
                        coord: coord
                    });
                    await refreshHostState();
                } catch (err) {
                    setPanelStatus('Error guardando principal: ' + err.message);
                }
            };
        });
    }

    async function configureSync() {
        const modeInput = window.prompt('Modo: off | host | slave', syncMode);
        if (modeInput === null) {
            return;
        }
        const nextMode = normalizeMode(modeInput);
        const endpointInput = window.prompt('Endpoint v2 (ej: http://IP:8788/v2)', syncEndpoint);
        if (endpointInput === null) {
            return;
        }
        const tokenInput = window.prompt('Token', syncToken);
        if (tokenInput === null) {
            return;
        }
        syncMode = nextMode;
        syncEndpoint = String(endpointInput || '').trim().replace(/\/+$/, '');
        syncToken = String(tokenInput || '').trim();
        GM_setValue(KEY_MODE, syncMode);
        GM_setValue(KEY_ENDPOINT, syncEndpoint);
        GM_setValue(KEY_TOKEN, syncToken);
        remoteState = createEmptyRemoteState();
        historyMetaCache = new Map();
        historyDayCache = new Map();
        historyHtml = '<div class="ptreV2Meta">Sin cargar</div>';
        setPanelStatus('Configuracion guardada');
        renderPanel();
        restartPolling();
    }

    function restartPolling() {
        if (pollingTimer) {
            clearInterval(pollingTimer);
            pollingTimer = null;
        }
        if (isSlave()) {
            slavePoll();
            pollingTimer = setInterval(slavePoll, SLAVE_POLL_MS);
            return;
        }
        if (isHost()) {
            refreshHostState();
            pollingTimer = setInterval(refreshHostState, STATUS_POLL_MS);
            return;
        }
        renderPanel();
    }

    async function refreshHostState() {
        if (!isHost() || !isConfigured() || pollingInFlight) {
            renderPanel();
            return;
        }
        pollingInFlight = true;
        try {
            const payload = await requestJson('GET', '/state');
            applyStatePayload(payload);
            if (isGalaxy) {
                refreshGalaxyIcons();
            }
            if (selectedTargetKey && !historyMetaCache.has(selectedTargetKey)) {
                loadHistoryForSelected(true).catch(() => {});
            }
            renderPanel();
        } catch (err) {
            setPanelStatus('Sync host error: ' + err.message);
        } finally {
            pollingInFlight = false;
        }
    }

    async function slavePoll() {
        if (!isSlave() || !isConfigured() || pollingInFlight) {
            renderPanel();
            return;
        }
        pollingInFlight = true;
        try {
            const payload = await requestJson('POST', '/slave/poll', buildSlavePollPayload());
            if (payload && payload.targets) {
                remoteState.targets = payload.targets;
            }
            if (payload && payload.runner) {
                remoteState.runner = payload.runner;
            }
            if (payload && payload.command) {
                handleSlaveCommand(payload.command);
            }
            renderPanel();
        } catch (err) {
            setPanelStatus('Sync slave error: ' + err.message);
        } finally {
            pollingInFlight = false;
        }
    }

    function applyStatePayload(payload) {
        remoteState.updatedAt = Number(payload && payload.updatedAt || 0);
        remoteState.targets = payload && payload.targets && typeof payload.targets === 'object'
            ? payload.targets
            : {};
        remoteState.runner = payload && payload.runner && typeof payload.runner === 'object'
            ? payload.runner
            : createEmptyRemoteState().runner;
    }

    function buildSlavePollPayload() {
        return {
            slaveId: slaveId,
            state: slaveRuntime.active
                ? (slaveRuntime.waiting ? 'waiting_galaxy' : 'running')
                : 'idle',
            currentCoord: slaveRuntime.currentCoord,
            progressIndex: slaveRuntime.index,
            progressTotal: slaveRuntime.queue.length,
            activeCommandId: slaveRuntime.commandId,
            lastError: slaveRuntime.lastError
        };
    }

    async function runSelectedTarget(mode) {
        if (!isHost()) {
            return;
        }
        if (!selectedTargetKey) {
            window.alert('Selecciona un objetivo.');
            return;
        }
        try {
            const intervalMs = Number(GM_getValue('ptreV2IntervalMs', DEFAULT_CONTINUOUS_INTERVAL_MS) || DEFAULT_CONTINUOUS_INTERVAL_MS);
            await requestJson('POST', '/runner/start', {
                playerKey: selectedTargetKey,
                mode: mode,
                intervalMs: intervalMs
            });
            await refreshHostState();
            setPanelStatus(mode === 'continuous' ? 'Continuo enviado al slave' : 'Recorrido enviado al slave');
        } catch (err) {
            setPanelStatus('Error lanzando orden: ' + err.message);
        }
    }

    async function stopSlaveFromMaster() {
        if (!isHost()) {
            return;
        }
        try {
            await requestJson('POST', '/runner/stop', {});
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
        const ok = window.confirm('¿Eliminar objetivo seleccionado?');
        if (!ok) {
            return;
        }
        try {
            await requestJson('POST', '/targets/delete', {
                playerKey: selectedTargetKey
            });
            historyMetaCache.delete(selectedTargetKey);
            selectedTargetKey = '';
            selectedDateKey = '';
            GM_setValue(KEY_SELECTED_TARGET, '');
            GM_setValue(KEY_SELECTED_DATE, '');
            historyHtml = '<div class="ptreV2Meta">Objetivo eliminado</div>';
            await refreshHostState();
        } catch (err) {
            setPanelStatus('Error eliminando objetivo: ' + err.message);
        }
    }

    async function loadHistoryForSelected(force) {
        if (!isHost()) {
            historyHtml = '<div class="ptreV2Meta">Historial disponible solo en master</div>';
            renderPanel();
            return;
        }
        if (!selectedTargetKey) {
            historyHtml = '<div class="ptreV2Meta">Selecciona un objetivo</div>';
            renderPanel();
            return;
        }
        historyLoading = true;
        renderPanel();
        try {
            let meta = historyMetaCache.get(selectedTargetKey);
            if (!meta || force) {
                meta = await requestJson('GET', '/history/meta', undefined, {
                    playerKey: selectedTargetKey
                });
                historyMetaCache.set(selectedTargetKey, meta);
            }
            if (!selectedDateKey || !(meta.dates || []).includes(selectedDateKey)) {
                selectedDateKey = meta.dates && meta.dates.length ? meta.dates[meta.dates.length - 1] : '';
                GM_setValue(KEY_SELECTED_DATE, selectedDateKey);
            }
            if (!selectedDateKey) {
                historyHtml = '<div class="ptreV2Meta">Sin datos todavía para este objetivo</div>';
                return;
            }
            const cacheKey = selectedTargetKey + '|' + selectedDateKey;
            let dayPayload = historyDayCache.get(cacheKey);
            if (!dayPayload || force) {
                dayPayload = await requestJson('GET', '/history/day', undefined, {
                    playerKey: selectedTargetKey,
                    date: selectedDateKey
                });
                historyDayCache.set(cacheKey, dayPayload);
            }
            historyHtml = renderHistoryDay(dayPayload);
        } catch (err) {
            historyHtml = '<div class="ptreV2Meta">Error cargando historial: ' + escapeHtml(err.message) + '</div>';
        } finally {
            historyLoading = false;
            renderPanel();
        }
    }

    function renderHistoryDay(payload) {
        if (!payload || !Array.isArray(payload.buckets) || payload.buckets.length === 0) {
            return '<div class="ptreV2Meta">Sin datos en la fecha seleccionada</div>';
        }
        const bucketTimes = [];
        const startTs = floorToBucket(new Date(payload.date + 'T00:00:00').getTime());
        const endTs = startTs + (24 * 60 * 60 * 1000) - BUCKET_MS;
        for (let ts = startTs; ts <= endTs; ts += BUCKET_MS) {
            bucketTimes.push(ts);
        }
        const mapByCoord = new Map();
        payload.buckets.forEach((rec) => {
            const coord = normalizeCoord(rec.coords) || 'unknown';
            if (!mapByCoord.has(coord)) {
                mapByCoord.set(coord, {});
            }
            mapByCoord.get(coord)[rec.bucketTs] = rec;
        });
        const coords = Array.from(mapByCoord.keys()).filter((coord) => coord !== 'unknown').sort(compareCoords);
        let html = '<div class="ptreV2Meta">Jugador: ' + escapeHtml(payload.player && payload.player.playerName ? payload.player.playerName : payload.player.playerKey) + '</div>';
        html += '<table><thead><tr><th class="ptreV2RowTitle">Coords</th>';
        bucketTimes.forEach((ts) => {
            html += '<th>' + formatTime(ts) + '</th>';
        });
        html += '</tr></thead><tbody>';
        coords.forEach((coord) => {
            const isPrimary = payload.player && payload.player.primaryCoord === coord;
            html += '<tr><td class="ptreV2RowTitle">' + escapeHtml(coord) + (isPrimary ? '<br>*Principal*' : '') + '</td>';
            bucketTimes.forEach((ts) => {
                const rec = mapByCoord.get(coord)[ts];
                html += '<td>' + formatHistoryCell(rec) + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
    }

    function formatTime(ts) {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function floorToBucket(ts) {
        return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    }

    function formatHistoryCell(rec) {
        if (!rec || !Array.isArray(rec.entries) || rec.entries.length === 0) {
            return '';
        }
        const entry = rec.entries[rec.entries.length - 1];
        return '<span class="' + activityClass(entry.planet) + '">P:' + escapeHtml(String(entry.planet || '-')) + '</span>' +
            '<span class="' + activityClass(entry.moon) + '">L:' + escapeHtml(String(entry.moon || '-')) + '</span>' +
            '<span class="' + (entry.debris === 'si' ? 'ptreV2DebrisYes' : 'ptreV2DebrisNo') + '">D:' + escapeHtml(String(entry.debris || 'no')) + '</span>';
    }

    function activityClass(value) {
        const raw = String(value || '-').trim();
        if (raw === '*') {
            return 'ptreV2Red';
        }
        if (raw !== '-') {
            return 'ptreV2Yellow';
        }
        return 'ptreV2Green';
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function installGalaxyWatcher() {
        if (galaxyObserverBound) {
            return;
        }
        galaxyObserverBound = true;
        const loading = document.getElementById('galaxyLoading');
        if (!loading) {
            return;
        }
        const onReady = () => {
            refreshGalaxyIcons();
            maybeProcessSlaveStep();
        };
        if (window.getComputedStyle(loading).display === 'none') {
            onReady();
        }
        const observer = new MutationObserver(() => {
            if (window.getComputedStyle(loading).display === 'none') {
                onReady();
            }
        });
        observer.observe(loading, { attributes: true, childList: true });
    }

    function refreshGalaxyIcons() {
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
            const targetKey = findTargetKey(targets, playerId, playerName);
            icon.classList.toggle(ICON_ACTIVE_CLASS, Boolean(targetKey));
            icon.title = isHost() ? (targetKey ? 'Quitar objetivo' : 'Añadir objetivo') : 'Solo editable en master';
            icon.onclick = async (event) => {
                event.stopPropagation();
                if (!isHost()) {
                    setPanelStatus('Solo el master puede editar objetivos');
                    return;
                }
                if (!isConfigured()) {
                    setPanelStatus('Configura sync antes de editar objetivos');
                    return;
                }
                const currentCoords = readCurrentSystem();
                const coord = currentCoords ? normalizeCoord(currentCoords.galaxy + ':' + currentCoords.system + ':' + pos) : '';
                const existingKey = findTargetKey(remoteState.targets, playerId, playerName);
                try {
                    if (existingKey) {
                        await requestJson('POST', '/targets/delete', {
                            playerKey: existingKey
                        });
                        if (selectedTargetKey === existingKey) {
                            selectedTargetKey = '';
                            selectedDateKey = '';
                            GM_setValue(KEY_SELECTED_TARGET, '');
                            GM_setValue(KEY_SELECTED_DATE, '');
                            historyHtml = '<div class="ptreV2Meta">Objetivo eliminado</div>';
                        }
                    } else {
                        const playerKey = buildTargetKey(playerId, playerName);
                        await requestJson('POST', '/targets/upsert', {
                            playerKey: playerKey,
                            playerName: playerName,
                            coord: coord
                        });
                        selectedTargetKey = playerKey;
                        GM_setValue(KEY_SELECTED_TARGET, selectedTargetKey);
                        const runNow = window.confirm('Objetivo añadido. ¿Lanzar recorrido del slave ahora?');
                        if (runNow) {
                            await requestJson('POST', '/runner/start', {
                                playerKey: playerKey,
                                mode: 'once',
                                intervalMs: Number(GM_getValue('ptreV2IntervalMs', DEFAULT_CONTINUOUS_INTERVAL_MS) || DEFAULT_CONTINUOUS_INTERVAL_MS)
                            });
                        }
                    }
                    historyMetaCache = new Map();
                    historyDayCache = new Map();
                    await refreshHostState();
                    if (selectedTargetKey) {
                        await loadHistoryForSelected(true);
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
            galaxy: String(galaxyInput.value || '').trim(),
            system: String(systemInput.value || '').trim()
        };
    }

    function getPlayerName(row, cellPlayerName) {
        let playerName = '';
        const nameNode = row.querySelector('.galaxyCell .playerName.tooltipRel');
        if (nameNode && nameNode.childNodes[0]) {
            playerName = String(nameNode.childNodes[0].textContent || '').trim();
        }
        if (!playerName) {
            const ownRow = cellPlayerName.querySelector('.ownPlayerRow');
            if (ownRow) {
                playerName = String(ownRow.textContent || '').trim();
            }
        }
        if (!playerName) {
            playerName = String(cellPlayerName.textContent || '').trim();
        }
        return playerName;
    }

    function getPlayerId(cellPlayerName) {
        const playerSpan = cellPlayerName.querySelector('span[rel^="player"]');
        if (!playerSpan) {
            return -1;
        }
        const rel = String(playerSpan.getAttribute('rel') || '');
        const id = Number(rel.replace(/\D/g, ''));
        return Number.isFinite(id) && id > 0 ? id : -1;
    }

    function readActivity(elem) {
        if (!elem) {
            return '-';
        }
        if (elem.classList.contains('minute15')) {
            return '*';
        }
        if (elem.classList.contains('showMinutes')) {
            return String(elem.textContent || '').trim() || '-';
        }
        return '-';
    }

    function readDebris(pos) {
        let debris = 0;
        document.querySelectorAll('#debris' + pos + ' .ListLinks .debris-content').forEach((node) => {
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

    function handleSlaveCommand(command) {
        if (!isSlave() || !command || typeof command !== 'object') {
            return;
        }
        if (command.action === 'stop') {
            stopSlaveRuntime('stopped', '', String(command.commandId || ''), true);
            return;
        }
        if (command.action !== 'scan' || !Array.isArray(command.queue) || command.queue.length === 0) {
            return;
        }
        if (slaveRuntime.active && slaveRuntime.commandId === command.commandId) {
            return;
        }
        startSlaveRuntime(command);
    }

    function clearSlaveTimers() {
        if (slaveRuntime.cycleTimer) {
            clearTimeout(slaveRuntime.cycleTimer);
            slaveRuntime.cycleTimer = null;
        }
        if (slaveRuntime.stepTimer) {
            clearTimeout(slaveRuntime.stepTimer);
            slaveRuntime.stepTimer = null;
        }
        if (slaveRuntime.timeoutTimer) {
            clearTimeout(slaveRuntime.timeoutTimer);
            slaveRuntime.timeoutTimer = null;
        }
    }

    function navigateToGalaxy() {
        const url = location.origin + '/game/index.php?page=ingame&component=galaxy';
        location.assign(url);
    }

    function startSlaveRuntime(command) {
        clearSlaveTimers();
        if (!isGalaxy) {
            setPanelStatus('Slave: abriendo galaxia para ejecutar orden');
            navigateToGalaxy();
            return;
        }
        slaveRuntime = createEmptySlaveRuntime();
        slaveRuntime.active = true;
        slaveRuntime.commandId = String(command.commandId || '');
        slaveRuntime.mode = String(command.mode || 'once') === 'continuous' ? 'continuous' : 'once';
        slaveRuntime.queue = (command.queue || []).map((coord) => normalizeCoord(coord)).filter(Boolean);
        slaveRuntime.intervalMs = Math.max(10000, Number(command.intervalMs || DEFAULT_CONTINUOUS_INTERVAL_MS));
        slaveRuntime.index = 0;
        slaveRuntime.lastError = '';
        runNextSlaveStep();
        renderPanel();
    }

    function stopSlaveRuntime(finalState, errorMessage, finishCommandId, clearCommand) {
        clearSlaveTimers();
        const activeCommandId = finishCommandId || slaveRuntime.commandId || '';
        slaveRuntime.active = false;
        slaveRuntime.waiting = false;
        slaveRuntime.processing = false;
        slaveRuntime.lastError = String(errorMessage || '').trim();
        slaveRuntime.currentCoord = '';
        slaveRuntime.queue = [];
        slaveRuntime.index = 0;
        slaveRuntime.commandId = '';
        sendSlaveFinish(finalState, errorMessage, activeCommandId, Boolean(clearCommand)).catch(() => {});
        renderPanel();
    }

    async function sendSlaveFinish(stateValue, errorMessage, activeCommandId, clearCommand) {
        if (!isConfigured()) {
            return;
        }
        await requestJson('POST', '/slave/finish', {
            slaveId: slaveId,
            state: stateValue,
            lastError: String(errorMessage || '').trim(),
            activeCommandId: activeCommandId,
            clearCommand: Boolean(clearCommand)
        });
    }

    function runNextSlaveStep() {
        clearSlaveTimers();
        if (!slaveRuntime.active) {
            return;
        }
        if (slaveRuntime.index >= slaveRuntime.queue.length) {
            if (slaveRuntime.mode === 'continuous') {
                slaveRuntime.cycleTimer = setTimeout(() => {
                    slaveRuntime.index = 0;
                    runNextSlaveStep();
                }, slaveRuntime.intervalMs);
                renderPanel();
                return;
            }
            stopSlaveRuntime('completed', '', slaveRuntime.commandId, true);
            return;
        }
        const coord = slaveRuntime.queue[slaveRuntime.index];
        slaveRuntime.currentCoord = coord;
        slaveRuntime.waiting = true;
        const moved = goToCoord(coord);
        if (!moved) {
            slaveRuntime.lastError = 'No se pudo navegar a ' + coord;
            slaveRuntime.index += 1;
            slaveRuntime.stepTimer = setTimeout(runNextSlaveStep, STEP_DELAY_MS);
            renderPanel();
            return;
        }
        slaveRuntime.timeoutTimer = setTimeout(() => {
            if (!slaveRuntime.active || !slaveRuntime.waiting) {
                return;
            }
            slaveRuntime.waiting = false;
            slaveRuntime.lastError = 'Timeout en ' + coord;
            slaveRuntime.index += 1;
            runNextSlaveStep();
        }, STEP_TIMEOUT_MS);
        renderPanel();
    }

    async function maybeProcessSlaveStep() {
        if (!isSlave() || !slaveRuntime.active || !slaveRuntime.waiting || slaveRuntime.processing) {
            return;
        }
        const currentSystem = readCurrentSystem();
        if (!currentSystem) {
            return;
        }
        const expectedParts = String(slaveRuntime.currentCoord || '').split(':');
        if (expectedParts.length !== 3) {
            return;
        }
        if (String(currentSystem.galaxy) !== expectedParts[0] || String(currentSystem.system) !== expectedParts[1]) {
            return;
        }
        slaveRuntime.processing = true;
        slaveRuntime.waiting = false;
        if (slaveRuntime.timeoutTimer) {
            clearTimeout(slaveRuntime.timeoutTimer);
            slaveRuntime.timeoutTimer = null;
        }
        try {
            const batch = collectVisibleTargetObservations();
            if (batch.length > 0) {
                await requestJson('POST', '/slave/observe', {
                    slaveId: slaveId,
                    activeCommandId: slaveRuntime.commandId,
                    batch: batch
                });
            }
        } catch (err) {
            slaveRuntime.lastError = err.message;
        } finally {
            slaveRuntime.processing = false;
            slaveRuntime.index += 1;
            slaveRuntime.stepTimer = setTimeout(runNextSlaveStep, STEP_DELAY_MS);
            renderPanel();
        }
    }

    function collectVisibleTargetObservations() {
        const system = readCurrentSystem();
        if (!system) {
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
            const targetKey = findTargetKey(targets, playerId, playerName);
            if (!targetKey) {
                continue;
            }
            batch.push({
                playerKey: targetKey,
                playerName: playerName || targetKey,
                coords: system.galaxy + ':' + system.system + ':' + pos,
                planet: readActivity(row.querySelector('[data-planet-id] .activity')),
                moon: readActivity(row.querySelector('[data-moon-id] .activity')),
                debris: readDebris(pos),
                seenAt: Date.now(),
                bucketTs: floorToBucket(Date.now())
            });
        }
        return batch;
    }

    function goToCoord(coord) {
        const parts = String(coord || '').split(':').map((part) => Number(part));
        if (parts.length !== 3 || parts.some((num) => !Number.isFinite(num))) {
            return false;
        }
        const [g, s, p] = parts;
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (pageWindow.galaxy && typeof pageWindow.galaxy.updateGalaxy === 'function') {
            try {
                pageWindow.galaxy.updateGalaxy(g, s, p);
                return true;
            } catch (err) {
                // fallback below
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
                return false;
            }
        }
        return false;
    }
})();
