// ==UserScript==
// @name         OGame Seguimiento Jugador Remoto
// @namespace    https://openuserjs.org/users/GeGe_GM
// @version      0.1.3
// @description  Master/slave para capturar coords, escanear remoto y visualizar historial por jugador.
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

    const VERSION = '0.1.3';
    const PANEL_ID = 'otrRemotePanel';
    const MODAL_ID = 'otrRemoteHistoryModal';
    const TOKEN_HEADER = 'x-tracker-token';
    const BUCKET_MS = 5 * 60 * 1000;
    const MASTER_POLL_MS = 4000;
    const SLAVE_POLL_MS = 3000;
    const GALAXY_HEARTBEAT_MS = 400;
    const STEP_TIMEOUT_MS = 18000;
    const DEFAULT_MODE = 'off';
    const DEFAULT_ENDPOINT = '';
    const DEFAULT_TOKEN = '';
    const DEFAULT_CYCLE_INTERVAL_MS = 5 * 60 * 1000;
    const DEFAULT_HOP_DELAY_MS = 2000;
    const MASTER_TARGET_SYNC_DEBOUNCE_MS = 600;

    const KEY_MODE = 'otrRemoteMode';
    const KEY_ENDPOINT = 'otrRemoteEndpoint';
    const KEY_TOKEN = 'otrRemoteToken';
    const KEY_CLIENT_ID = 'otrRemoteClientId';
    const KEY_LOCAL_TARGETS = 'otrRemoteLocalTargets';
    const KEY_TARGETS_BOOTSTRAPPED = 'otrRemoteTargetsBootstrapped';
    const KEY_SELECTED_TARGET = 'otrRemoteSelectedTarget';
    const KEY_CAPTURE_TARGET = 'otrRemoteCaptureTarget';
    const KEY_CYCLE_INTERVAL = 'otrRemoteCycleInterval';
    const KEY_HOP_DELAY = 'otrRemoteHopDelay';
    const KEY_HISTORY_PLAYER = 'otrRemoteHistoryPlayer';
    const KEY_HISTORY_DATE = 'otrRemoteHistoryDate';

    if (!/\/game\//.test(location.pathname)) {
        return;
    }

    let syncMode = normalizeMode(GM_getValue(KEY_MODE, DEFAULT_MODE));
    let syncEndpoint = normalizeText(GM_getValue(KEY_ENDPOINT, DEFAULT_ENDPOINT));
    let syncToken = normalizeText(GM_getValue(KEY_TOKEN, DEFAULT_TOKEN));
    let clientId = normalizeText(GM_getValue(KEY_CLIENT_ID, ''));
    if (!clientId) {
        clientId = 'client-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        GM_setValue(KEY_CLIENT_ID, clientId);
    }

    let selectedTargetKey = normalizeText(GM_getValue(KEY_SELECTED_TARGET, ''));
    let captureTargetKey = normalizeText(GM_getValue(KEY_CAPTURE_TARGET, ''));
    let cycleIntervalMs = clampCycleInterval(Number(GM_getValue(KEY_CYCLE_INTERVAL, DEFAULT_CYCLE_INTERVAL_MS) || DEFAULT_CYCLE_INTERVAL_MS));
    let hopDelayMs = clampHopDelay(Number(GM_getValue(KEY_HOP_DELAY, DEFAULT_HOP_DELAY_MS) || DEFAULT_HOP_DELAY_MS));
    let panelStatus = '';
    let syncErrorStatus = '';
    let pollingTimer = null;
    let pollingBusy = false;
    let galaxyHeartbeatTimer = null;
    let galaxyLoadingObserver = null;
    let galaxyChangeObserver = null;
    let observedGalaxyLoading = null;
    let captureBusy = false;
    let slaveRuntime = createEmptySlaveRuntime();
    let remoteState = createEmptyRemoteState();
    let localTargets = loadLocalTargets();
    let localTargetsBootstrapped = Boolean(GM_getValue(KEY_TARGETS_BOOTSTRAPPED, false));
    let masterTargetsSyncTimer = null;
    let masterTargetsSyncPromise = null;
    let masterTargetsSyncDirty = false;

    let historyState = {
        open: false,
        loading: false,
        players: [],
        playerKey: normalizeText(GM_getValue(KEY_HISTORY_PLAYER, '')),
        dateKey: normalizeText(GM_getValue(KEY_HISTORY_DATE, '')),
        meta: null,
        day: null,
        message: 'Sin cargar'
    };

    GM_addStyle(buildStyles());
    ensurePanel();
    ensureHistoryModal();
    renderPanel();
    renderHistoryModal();
    restartPolling();
    startGalaxyHeartbeat();

    function normalizeText(value) {
        return String(value || '').trim();
    }

    function normalizeMode(value) {
        const raw = normalizeText(value).toLowerCase();
        if (raw === 'master') {
            return 'master';
        }
        if (raw === 'slave') {
            return 'slave';
        }
        return 'off';
    }

    function isConfigured() {
        return Boolean(syncEndpoint);
    }

    function isMaster() {
        return syncMode === 'master';
    }

    function isSlave() {
        return syncMode === 'slave';
    }

    function isGalaxyPage() {
        return /component=galaxy/.test(String(location.href || ''));
    }

    function positiveNumber(value, fallback) {
        const num = Number(value);
        return Number.isFinite(num) && num > 0 ? num : fallback;
    }

    function clampCycleInterval(value) {
        const allowed = [1, 2, 5, 15].map((minutes) => minutes * 60 * 1000);
        const current = positiveNumber(value, DEFAULT_CYCLE_INTERVAL_MS);
        const best = allowed.find((item) => item === current);
        return best || DEFAULT_CYCLE_INTERVAL_MS;
    }

    function clampHopDelay(value) {
        const allowed = [1000, 2000, 3000, 5000, 8000];
        const current = positiveNumber(value, DEFAULT_HOP_DELAY_MS);
        const best = allowed.find((item) => item === current);
        return best || DEFAULT_HOP_DELAY_MS;
    }

    function createEmptyRemoteState() {
        return {
            updatedAt: 0,
            targets: {},
            runner: {
                currentPlan: null,
                slaveStatus: {
                    slaveId: '',
                    state: 'idle',
                    playerKey: '',
                    currentCoord: '',
                    progressIndex: 0,
                    progressTotal: 0,
                    activePlanId: '',
                    lastError: '',
                    lastSeenAt: 0,
                    updatedAt: 0,
                    online: false
                }
            }
        };
    }

    function createEmptySlaveRuntime() {
        return {
            active: false,
            planId: '',
            planLabel: '',
            playerKey: '',
            playerName: '',
            steps: [],
            queue: [],
            coordSet: new Set(),
            cycleIntervalMs: DEFAULT_CYCLE_INTERVAL_MS,
            hopDelayMs: DEFAULT_HOP_DELAY_MS,
            index: 0,
            currentCoord: '',
            waitingLoad: false,
            reporting: false,
            cooldown: false,
            lastError: '',
            timeoutTimer: null,
            stepTimer: null,
            cycleTimer: null
        };
    }

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
    background: rgba(11, 17, 24, 0.97);
    color: #d5dee8;
    border: 1px solid #05080b;
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
    font: 12px/1.4 Arial, sans-serif;
}
#${PANEL_ID} .otrHead {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: #10171f;
    border-bottom: 1px solid #05080b;
}
#${PANEL_ID} .otrHeadActions {
    display: flex;
    gap: 6px;
}
#${PANEL_ID} .otrTitle {
    font-weight: bold;
    color: #89d85e;
}
#${PANEL_ID} .otrBody {
    padding: 8px 10px 12px;
}
#${PANEL_ID} .otrRow {
    margin-bottom: 8px;
}
#${PANEL_ID} .otrLabel {
    display: block;
    margin-bottom: 4px;
    color: #b8c4d0;
}
#${PANEL_ID} button,
#${PANEL_ID} select {
    font: 12px Arial, sans-serif;
}
#${PANEL_ID} button {
    cursor: pointer;
    padding: 4px 6px;
    color: #d5dee8;
    background: #27313c;
    border: 1px solid #06090c;
}
#${PANEL_ID} button:hover {
    background: #35414d;
}
#${PANEL_ID} button.danger {
    background: #642d2d;
}
#${PANEL_ID} select {
    width: 100%;
    box-sizing: border-box;
    padding: 4px;
    color: #d5dee8;
    background: #17202a;
    border: 1px solid #06090c;
}
#${PANEL_ID} .otrButtons2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
}
#${PANEL_ID} .otrButtons3 {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
}
#${PANEL_ID} .otrBox {
    padding: 6px;
    border: 1px solid #06090c;
    background: #141b23;
}
#${PANEL_ID} .otrMeta {
    color: #aeb8c2;
}
#${PANEL_ID} .otrStatus {
    color: #d9e3ed;
}
#${PANEL_ID} .otrCoords {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
#${PANEL_ID} .otrCoordItem {
    padding: 3px 5px;
    border: 1px solid #06090c;
    background: #213142;
}
.otrTargetFlag {
    display: inline-block;
    margin-left: 6px;
    cursor: pointer;
    font-weight: bold;
    color: #758391;
}
.otrTargetFlag.active {
    color: #89d85e;
}
.otrTargetFlag.capture {
    color: #ffd76a;
}
#${MODAL_ID} {
    position: fixed;
    inset: 0;
    z-index: 1000000;
    display: none;
    background: rgba(3, 6, 9, 0.72);
}
#${MODAL_ID}.open {
    display: block;
}
#${MODAL_ID} .otrModalPanel {
    position: absolute;
    inset: 24px;
    display: flex;
    flex-direction: column;
    border: 1px solid #05080b;
    background: rgba(11, 17, 24, 0.98);
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5);
    color: #d5dee8;
    font: 12px/1.4 Arial, sans-serif;
}
#${MODAL_ID} .otrModalHead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: #10171f;
    border-bottom: 1px solid #05080b;
}
#${MODAL_ID} .otrModalTitle {
    font-weight: bold;
    color: #89d85e;
}
#${MODAL_ID} .otrModalBody {
    flex: 1 1 auto;
    overflow: auto;
    padding: 10px 12px;
}
#${MODAL_ID} .otrModalRow {
    margin-bottom: 10px;
}
#${MODAL_ID} button,
#${MODAL_ID} select {
    font: 12px Arial, sans-serif;
}
#${MODAL_ID} button {
    cursor: pointer;
    padding: 4px 6px;
    color: #d5dee8;
    background: #27313c;
    border: 1px solid #06090c;
}
#${MODAL_ID} button:hover {
    background: #35414d;
}
#${MODAL_ID} button.danger {
    background: #642d2d;
}
#${MODAL_ID} select {
    min-width: 220px;
    padding: 4px;
    color: #d5dee8;
    background: #17202a;
    border: 1px solid #06090c;
}
#${MODAL_ID} .otrModalButtons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
#${MODAL_ID} .otrHistoryMeta {
    color: #aeb8c2;
}
#${MODAL_ID} .otrHistoryTableWrap {
    overflow: auto;
    border: 1px solid #06090c;
    background: #141b23;
}
#${MODAL_ID} table {
    border-collapse: collapse;
    font-size: 11px;
}
#${MODAL_ID} th,
#${MODAL_ID} td {
    border: 1px solid #06090c;
    min-width: 76px;
    padding: 3px 4px;
    vertical-align: top;
    text-align: center;
}
#${MODAL_ID} th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: #10171f;
}
#${MODAL_ID} th.otrStickyLeft,
#${MODAL_ID} td.otrStickyLeft {
    position: sticky;
    left: 0;
    z-index: 1;
    background: #10171f;
    min-width: 100px;
}
#${MODAL_ID} td.otrStickyLeft {
    z-index: 0;
}
#${MODAL_ID} .otrCellTime {
    color: #d5dee8;
}
#${MODAL_ID} .otrCellGreen {
    display: block;
    background: #214622;
}
#${MODAL_ID} .otrCellYellow {
    display: block;
    background: #6f5b18;
}
#${MODAL_ID} .otrCellRed {
    display: block;
    background: #722828;
}
#${MODAL_ID} .otrDebrisYes {
    color: #ffbe57;
}
#${MODAL_ID} .otrDebrisNo {
    color: #9eabb8;
}
        `;
    }

    function ensurePanel() {
        if (document.getElementById(PANEL_ID)) {
            return;
        }
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        document.body.appendChild(panel);
    }

    function ensureHistoryModal() {
        if (document.getElementById(MODAL_ID)) {
            return;
        }
        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        document.body.appendChild(modal);
    }

    function setPanelStatus(message) {
        panelStatus = normalizeText(message);
        renderPanel();
    }

    function setSyncErrorStatus(message) {
        syncErrorStatus = normalizeText(message);
        renderPanel();
    }

    function clearSyncErrorStatus() {
        if (!syncErrorStatus) {
            return;
        }
        syncErrorStatus = '';
    }

    function normalizeTargetRecord(input, fallbackKey) {
        if ((!input || typeof input !== 'object') && !fallbackKey) {
            return null;
        }
        const playerKey = normalizeText((input && input.playerKey) || fallbackKey);
        if (!playerKey) {
            return null;
        }
        const now = Date.now();
        const coords = Array.isArray(input && input.coords)
            ? Array.from(new Set(input.coords.map(normalizeCoord).filter(Boolean))).sort(compareCoords)
            : [];
        return {
            playerKey: playerKey,
            playerId: positiveNumber(input && input.playerId, 0),
            playerName: normalizeText((input && input.playerName) || playerKey) || playerKey,
            coords: coords,
            addedAt: positiveNumber(input && input.addedAt, now),
            updatedAt: positiveNumber(input && input.updatedAt, now)
        };
    }

    function normalizeTargetMap(input) {
        const normalized = {};
        if (!input || typeof input !== 'object') {
            return normalized;
        }
        Object.keys(input).forEach((playerKey) => {
            const target = normalizeTargetRecord(input[playerKey], playerKey);
            if (target) {
                normalized[target.playerKey] = target;
            }
        });
        return normalized;
    }

    function loadLocalTargets() {
        const raw = GM_getValue(KEY_LOCAL_TARGETS, '{}');
        try {
            if (typeof raw === 'string') {
                return normalizeTargetMap(raw ? JSON.parse(raw) : {});
            }
            return normalizeTargetMap(raw);
        } catch (error) {
            return {};
        }
    }

    function persistLocalTargets() {
        GM_setValue(KEY_LOCAL_TARGETS, JSON.stringify(localTargets));
        GM_setValue(KEY_TARGETS_BOOTSTRAPPED, true);
        localTargetsBootstrapped = true;
    }

    function getCurrentTargets() {
        return isMaster() ? localTargets : (remoteState.targets && typeof remoteState.targets === 'object' ? remoteState.targets : {});
    }

    function getTargetKeysFromMap(targets) {
        const map = targets && typeof targets === 'object' ? targets : {};
        return Object.keys(map).sort((left, right) => {
            const leftName = normalizeText(map[left] && map[left].playerName ? map[left].playerName : left).toLowerCase();
            const rightName = normalizeText(map[right] && map[right].playerName ? map[right].playerName : right).toLowerCase();
            return leftName.localeCompare(rightName, 'es', { sensitivity: 'base' });
        });
    }

    function sanitizeTargetSelection() {
        const targets = getCurrentTargets();
        const keys = getTargetKeysFromMap(targets);
        if (selectedTargetKey && !targets[selectedTargetKey]) {
            selectedTargetKey = '';
            GM_setValue(KEY_SELECTED_TARGET, '');
        }
        if (captureTargetKey && !targets[captureTargetKey]) {
            captureTargetKey = '';
            GM_setValue(KEY_CAPTURE_TARGET, '');
        }
        if (!selectedTargetKey && keys.length && isMaster()) {
            selectedTargetKey = keys[0];
            GM_setValue(KEY_SELECTED_TARGET, selectedTargetKey);
        }
    }

    function replaceLocalTargets(nextTargets) {
        localTargets = normalizeTargetMap(nextTargets);
        persistLocalTargets();
        sanitizeTargetSelection();
    }

    function serializeTargets(targets) {
        const map = normalizeTargetMap(targets);
        const payload = Object.keys(map).sort().map((playerKey) => {
            const target = map[playerKey];
            return {
                playerKey: playerKey,
                playerId: positiveNumber(target && target.playerId, 0),
                playerName: normalizeText(target && target.playerName ? target.playerName : playerKey) || playerKey,
                coords: Array.isArray(target && target.coords) ? target.coords.map(normalizeCoord).filter(Boolean).sort(compareCoords) : []
            };
        });
        return JSON.stringify(payload);
    }

    function markLocalTargetsDirty(immediateSync) {
        masterTargetsSyncDirty = true;
        if (!isMaster() || !isConfigured()) {
            return;
        }
        queueMasterTargetsSync(immediateSync);
    }

    function queueMasterTargetsSync(immediateSync) {
        if (!isMaster() || !isConfigured()) {
            return;
        }
        if (masterTargetsSyncTimer) {
            clearTimeout(masterTargetsSyncTimer);
            masterTargetsSyncTimer = null;
        }
        masterTargetsSyncTimer = setTimeout(() => {
            masterTargetsSyncTimer = null;
            syncMasterTargetsNow().catch(() => {});
        }, immediateSync ? 0 : MASTER_TARGET_SYNC_DEBOUNCE_MS);
    }

    async function syncMasterTargetsNow(options) {
        if (!isMaster() || !isConfigured()) {
            return;
        }
        const settings = options && typeof options === 'object' ? options : {};
        const localSerialized = serializeTargets(localTargets);
        const remoteSerialized = serializeTargets(remoteState.targets);
        if (!settings.force && !masterTargetsSyncDirty && localSerialized === remoteSerialized) {
            return;
        }
        if (masterTargetsSyncTimer) {
            clearTimeout(masterTargetsSyncTimer);
            masterTargetsSyncTimer = null;
        }
        if (masterTargetsSyncPromise) {
            return masterTargetsSyncPromise;
        }
        masterTargetsSyncPromise = (async () => {
            try {
                const payload = await requestJson('POST', '/targets/replace', {
                    targets: localTargets
                });
                if (payload && payload.state) {
                    applyStatePayload(payload.state);
                }
                masterTargetsSyncDirty = false;
                clearSyncErrorStatus();
            } catch (error) {
                masterTargetsSyncDirty = true;
                if (!settings.silent) {
                    setSyncErrorStatus('Error master push: ' + error.message);
                }
                throw error;
            } finally {
                masterTargetsSyncPromise = null;
            }
        })();
        return masterTargetsSyncPromise;
    }

    function maybeBootstrapLocalTargets(remoteTargets) {
        if (!isMaster() || localTargetsBootstrapped) {
            return false;
        }
        if (Object.keys(localTargets).length) {
            GM_setValue(KEY_TARGETS_BOOTSTRAPPED, true);
            localTargetsBootstrapped = true;
            return false;
        }
        const normalizedRemoteTargets = normalizeTargetMap(remoteTargets);
        if (!Object.keys(normalizedRemoteTargets).length) {
            return false;
        }
        replaceLocalTargets(normalizedRemoteTargets);
        setPanelStatus('Objetivos locales importados del servidor');
        return true;
    }

    function getTargetKeys() {
        return getTargetKeysFromMap(getCurrentTargets());
    }

    function getSelectedTarget() {
        const targets = getCurrentTargets();
        return selectedTargetKey && targets ? targets[selectedTargetKey] || null : null;
    }

    function formatSlaveStatus(status) {
        if (!status) {
            return 'sin datos';
        }
        if (!status.online) {
            return 'offline';
        }
        let text = normalizeText(status.state || 'idle') || 'idle';
        if (status.currentCoord) {
            text += ' | ' + status.currentCoord;
        }
        if (positiveNumber(status.progressTotal, 0) > 0) {
            text += ' | ' + String(positiveNumber(status.progressIndex, 0)) + '/' + String(positiveNumber(status.progressTotal, 0));
        }
        if (status.lastError) {
            text += ' | err: ' + status.lastError;
        }
        return text;
    }

    function buildTargetOptions() {
        const targets = getCurrentTargets();
        const keys = getTargetKeys();
        if (!selectedTargetKey && keys.length) {
            selectedTargetKey = keys[0];
            GM_setValue(KEY_SELECTED_TARGET, selectedTargetKey);
        }
        return ['<option value="">-- Selecciona --</option>'].concat(keys.map((playerKey) => {
            const target = targets[playerKey];
            const name = escapeHtml(target && target.playerName ? target.playerName : playerKey);
            const coordsCount = target && Array.isArray(target.coords) ? target.coords.length : 0;
            const selected = playerKey === selectedTargetKey ? ' selected' : '';
            return '<option value="' + escapeHtml(playerKey) + '"' + selected + '>' + name + ' (' + coordsCount + ')</option>';
        })).join('');
    }

    function buildTargetCoordsHtml(target) {
        const coords = target && Array.isArray(target.coords) ? target.coords.slice().sort(compareCoords) : [];
        if (!coords.length) {
            return '<div class="otrMeta">Sin coords registradas</div>';
        }
        return '<div class="otrCoords">' + coords.map((coord) => '<div class="otrCoordItem">' + escapeHtml(coord) + '</div>').join('') + '</div>';
    }

    function renderPanel() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) {
            return;
        }

        const target = getSelectedTarget();
        const currentPlan = remoteState.runner && remoteState.runner.currentPlan ? remoteState.runner.currentPlan : null;
        const slaveStatus = remoteState.runner && remoteState.runner.slaveStatus ? remoteState.runner.slaveStatus : createEmptyRemoteState().runner.slaveStatus;
        const statusLine = syncErrorStatus || panelStatus || (isMaster()
            ? 'Master listo'
            : isSlave()
                ? (slaveRuntime.active ? 'Slave ejecutando' : 'Slave listo')
                : 'Sync apagado');

        const hostSection = isMaster() ? `
            <div class="otrRow">
                <label class="otrLabel">Objetivo</label>
                <select id="otrTargetSelect">${buildTargetOptions()}</select>
            </div>
            <div class="otrRow">
                <div class="otrButtons3">
                    <button id="otrCaptureStart">Iniciar captura coords</button>
                    <button id="otrCaptureStop">Parar captura</button>
                    <button id="otrHistoryOpen">Abrir historial</button>
                </div>
            </div>
            <div class="otrRow">
                <div class="otrBox">
                    <div class="otrMeta">Captura: ${captureTargetKey ? escapeHtml(getTargetLabel(captureTargetKey)) : 'desactivada'}</div>
                    <div class="otrMeta">Coords del objetivo: ${(target && target.coords ? target.coords.length : 0)}</div>
                    ${buildTargetCoordsHtml(target)}
                </div>
            </div>
            <div class="otrRow">
                <label class="otrLabel">Frecuencia ciclo completo</label>
                <select id="otrCycleSelect">${buildCycleOptions()}</select>
            </div>
            <div class="otrRow">
                <label class="otrLabel">Velocidad entre cambios</label>
                <select id="otrHopSelect">${buildHopOptions()}</select>
            </div>
            <div class="otrRow">
                <div class="otrButtons2">
                    <button id="otrScanStart">Iniciar escaneo</button>
                    <button id="otrScanStop" class="danger">Parar</button>
                </div>
            </div>
            <div class="otrRow">
                <div class="otrBox">
                    <div class="otrMeta">Plan activo: ${currentPlan ? escapeHtml(currentPlan.playerName || currentPlan.playerKey) : 'ninguno'}</div>
                    <div class="otrMeta">Slave remoto: ${escapeHtml(formatSlaveStatus(slaveStatus))}</div>
                </div>
            </div>
        ` : '';

        const slaveSection = isSlave() ? `
            <div class="otrRow">
                <div class="otrBox">
                    <div class="otrMeta">Slave: ${escapeHtml(clientId)}</div>
                    <div class="otrMeta">Plan local: ${slaveRuntime.active ? escapeHtml(slaveRuntime.planLabel || slaveRuntime.playerName || slaveRuntime.playerKey) : 'ninguno'}</div>
                    <div class="otrMeta">Estado local: ${escapeHtml(formatLocalSlaveStatus())}</div>
                </div>
            </div>
        ` : '';

        panel.innerHTML = `
            <div class="otrHead">
                <div class="otrTitle">Seguimiento Remoto</div>
                <div class="otrHeadActions">
                    <button id="otrProbeBtn">Probar</button>
                    <button id="otrConfigBtn">Sync...</button>
                </div>
            </div>
            <div class="otrBody">
                <div class="otrRow otrStatus">v${VERSION} | ${escapeHtml(statusLine)}</div>
                <div class="otrRow otrMeta">Modo: ${escapeHtml(syncMode)}</div>
                <div class="otrRow otrMeta">Endpoint: ${escapeHtml(syncEndpoint || '(sin configurar)')}</div>
                ${hostSection}
                ${slaveSection}
            </div>
        `;

        bindPanelEvents();
    }

    function buildCycleOptions() {
        const options = [1, 2, 5, 15].map((minutes) => {
            const value = minutes * 60 * 1000;
            const selected = value === cycleIntervalMs ? ' selected' : '';
            return '<option value="' + String(value) + '"' + selected + '>' + String(minutes) + ' min</option>';
        });
        return options.join('');
    }

    function buildHopOptions() {
        const options = [
            { value: 1000, label: '1 s' },
            { value: 2000, label: '2 s' },
            { value: 3000, label: '3 s' },
            { value: 5000, label: '5 s' },
            { value: 8000, label: '8 s' }
        ];
        return options.map((option) => {
            const selected = option.value === hopDelayMs ? ' selected' : '';
            return '<option value="' + String(option.value) + '"' + selected + '>' + option.label + '</option>';
        }).join('');
    }

    function bindPanelEvents() {
        const probeBtn = document.getElementById('otrProbeBtn');
        if (probeBtn) {
            probeBtn.onclick = runSyncProbe;
        }

        const configBtn = document.getElementById('otrConfigBtn');
        if (configBtn) {
            configBtn.onclick = configureSync;
        }

        const targetSelect = document.getElementById('otrTargetSelect');
        if (targetSelect) {
            targetSelect.onchange = () => {
                selectedTargetKey = normalizeText(targetSelect.value);
                GM_setValue(KEY_SELECTED_TARGET, selectedTargetKey);
                renderPanel();
            };
        }

        const cycleSelect = document.getElementById('otrCycleSelect');
        if (cycleSelect) {
            cycleSelect.onchange = () => {
                cycleIntervalMs = clampCycleInterval(Number(cycleSelect.value || DEFAULT_CYCLE_INTERVAL_MS));
                GM_setValue(KEY_CYCLE_INTERVAL, cycleIntervalMs);
            };
        }

        const hopSelect = document.getElementById('otrHopSelect');
        if (hopSelect) {
            hopSelect.onchange = () => {
                hopDelayMs = clampHopDelay(Number(hopSelect.value || DEFAULT_HOP_DELAY_MS));
                GM_setValue(KEY_HOP_DELAY, hopDelayMs);
            };
        }

        const captureStartBtn = document.getElementById('otrCaptureStart');
        if (captureStartBtn) {
            captureStartBtn.onclick = startCaptureMode;
        }

        const captureStopBtn = document.getElementById('otrCaptureStop');
        if (captureStopBtn) {
            captureStopBtn.onclick = stopCaptureMode;
        }

        const scanStartBtn = document.getElementById('otrScanStart');
        if (scanStartBtn) {
            scanStartBtn.onclick = startRemoteScan;
        }

        const scanStopBtn = document.getElementById('otrScanStop');
        if (scanStopBtn) {
            scanStopBtn.onclick = stopRemoteScan;
        }

        const historyBtn = document.getElementById('otrHistoryOpen');
        if (historyBtn) {
            historyBtn.onclick = openHistoryModal;
        }
    }

    async function configureSync() {
        const nextModeRaw = window.prompt('Modo: off | master | slave', syncMode);
        if (nextModeRaw === null) {
            return;
        }
        const nextMode = normalizeMode(nextModeRaw);
        const nextEndpointRaw = window.prompt('Endpoint (ej: http://IP:8790/tracker)', syncEndpoint);
        if (nextEndpointRaw === null) {
            return;
        }
        const nextTokenRaw = window.prompt('Token opcional (vacio = sin token)', syncToken);
        if (nextTokenRaw === null) {
            return;
        }

        syncMode = nextMode;
        syncEndpoint = normalizeEndpoint(nextEndpointRaw);
        syncToken = normalizeText(nextTokenRaw);
        remoteState = createEmptyRemoteState();
        if (!isMaster()) {
            selectedTargetKey = '';
            GM_setValue(KEY_SELECTED_TARGET, '');
        }
        if (!isMaster()) {
            captureTargetKey = '';
            GM_setValue(KEY_CAPTURE_TARGET, '');
        }
        GM_setValue(KEY_MODE, syncMode);
        GM_setValue(KEY_ENDPOINT, syncEndpoint);
        GM_setValue(KEY_TOKEN, syncToken);
        setPanelStatus('Configuracion guardada');
        restartPolling();
    }

    async function runSyncProbe() {
        if (!isConfigured()) {
            setPanelStatus('Configura sync antes');
            return;
        }
        clearSyncErrorStatus();
        setPanelStatus('Probando sync...');
        try {
            const health = await requestJson('GET', '/health');
            try {
                await requestJson('GET', '/state');
                clearSyncErrorStatus();
                setPanelStatus(
                    'Probe OK | base ' + normalizeText(health && health.apiBase) +
                    ' | token servidor ' + ((health && health.tokenEnabled) ? 'on' : 'off')
                );
            } catch (error) {
                setPanelStatus('Health OK pero /state falla: ' + error.message);
            }
        } catch (error) {
            setPanelStatus('Probe sync: ' + error.message);
        }
    }

    function normalizeEndpoint(value) {
        return normalizeText(value).replace(/\/+$/, '');
    }

    function restartPolling() {
        if (pollingTimer) {
            clearInterval(pollingTimer);
            pollingTimer = null;
        }
        if (masterTargetsSyncTimer) {
            clearTimeout(masterTargetsSyncTimer);
            masterTargetsSyncTimer = null;
        }
        clearSyncErrorStatus();

        if (isMaster() && isConfigured()) {
            refreshMasterState().catch(() => {});
            pollingTimer = setInterval(() => {
                refreshMasterState().catch(() => {});
            }, MASTER_POLL_MS);
            return;
        }

        if (isSlave() && isConfigured()) {
            slavePoll().catch(() => {});
            pollingTimer = setInterval(() => {
                slavePoll().catch(() => {});
            }, SLAVE_POLL_MS);
            return;
        }

        renderPanel();
    }

    async function refreshMasterState() {
        if (!isMaster() || !isConfigured() || pollingBusy) {
            renderPanel();
            return;
        }
        pollingBusy = true;
        try {
            const payload = await requestJson('GET', '/state');
            applyStatePayload(payload);
            maybeBootstrapLocalTargets(payload && payload.targets);
            clearSyncErrorStatus();
            if (masterTargetsSyncDirty || serializeTargets(localTargets) !== serializeTargets(remoteState.targets)) {
                queueMasterTargetsSync(true);
            }
            if (isGalaxyPage()) {
                refreshGalaxyIcons();
            }
            renderPanel();
        } catch (error) {
            setSyncErrorStatus('Error master sync: ' + error.message);
        } finally {
            pollingBusy = false;
        }
    }

    async function slavePoll() {
        if (!isSlave() || !isConfigured() || pollingBusy) {
            renderPanel();
            return;
        }
        pollingBusy = true;
        try {
            const payload = await requestJson('POST', '/slave/poll', buildSlavePollPayload());
            applyStatePayload({
                updatedAt: payload.serverTs || Date.now(),
                targets: payload.targets || {},
                runner: payload.runner || {}
            });
            clearSyncErrorStatus();
            handleSlavePlan(payload.plan || null);
            renderPanel();
        } catch (error) {
            setSyncErrorStatus('Error slave sync: ' + error.message);
        } finally {
            pollingBusy = false;
        }
    }

    function buildSlavePollPayload() {
        return {
            slaveId: clientId,
            state: buildSlaveRuntimeState(),
            playerKey: slaveRuntime.playerKey,
            currentCoord: slaveRuntime.currentCoord,
            progressIndex: slaveRuntime.active ? slaveRuntime.index : 0,
            progressTotal: slaveRuntime.active ? slaveRuntime.steps.length : 0,
            activePlanId: slaveRuntime.planId,
            lastError: slaveRuntime.lastError
        };
    }

    function buildSlaveRuntimeState() {
        if (!slaveRuntime.active) {
            return 'idle';
        }
        if (slaveRuntime.cooldown) {
            return 'cooldown';
        }
        if (slaveRuntime.reporting) {
            return 'reporting';
        }
        if (slaveRuntime.waitingLoad) {
            return 'waiting_galaxy';
        }
        return 'running';
    }

    function normalizeSlavePlanSteps(values) {
        if (!Array.isArray(values)) {
            return [];
        }
        return values.map((item) => {
            if (!item || typeof item !== 'object') {
                return null;
            }
            const coord = normalizeCoord(item.coord);
            const playerKey = normalizeText(item.playerKey);
            if (!coord || !playerKey) {
                return null;
            }
            return {
                coord: coord,
                playerKey: playerKey,
                playerId: positiveNumber(item.playerId, 0),
                playerName: normalizeText(item.playerName || playerKey) || playerKey
            };
        }).filter(Boolean);
    }

    function applyStatePayload(payload) {
        remoteState.updatedAt = Number(payload && payload.updatedAt || 0);
        remoteState.targets = payload && payload.targets && typeof payload.targets === 'object'
            ? payload.targets
            : {};
        remoteState.runner = payload && payload.runner && typeof payload.runner === 'object'
            ? payload.runner
            : createEmptyRemoteState().runner;
        sanitizeTargetSelection();
    }

    async function requestJson(method, path, body, queryParams) {
        if (!isConfigured()) {
            throw new Error('endpoint no configurado');
        }
        const url = buildUrl(path, queryParams);
        return await new Promise((resolve, reject) => {
            const headers = {};
            if (body !== undefined) {
                headers['content-type'] = 'application/json';
            }
            if (syncToken) {
                headers[TOKEN_HEADER] = syncToken;
            }

            GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: headers,
                data: body !== undefined ? JSON.stringify(body) : undefined,
                timeout: 30000,
                onload: (response) => {
                    let parsed = null;
                    try {
                        parsed = response.responseText ? JSON.parse(response.responseText) : {};
                    } catch (error) {
                        reject(new Error('respuesta JSON invalida'));
                        return;
                    }
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(parsed && parsed.error ? parsed.error : ('http ' + response.status)));
                        return;
                    }
                    resolve(parsed);
                },
                onerror: (response) => reject(new Error(buildNetworkError('fallo de red', url, response))),
                ontimeout: (response) => reject(new Error(buildNetworkError('timeout', url, response)))
            });
        });
    }

    function buildUrl(path, queryParams) {
        const url = syncEndpoint + path;
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            throw new Error('endpoint invalido: ' + syncEndpoint);
        }
        if (queryParams && typeof queryParams === 'object') {
            Object.keys(queryParams).forEach((key) => {
                const value = queryParams[key];
                if (value === undefined || value === null || value === '') {
                    return;
                }
                parsed.searchParams.set(key, String(value));
            });
        }
        return parsed.toString();
    }

    function buildNetworkError(prefix, requestUrl, response) {
        const parts = [prefix + ' hacia ' + requestUrl];
        const details = [];
        const status = response && Number(response.status);
        const readyState = response && Number(response.readyState);
        const statusText = normalizeText(response && response.statusText);
        const finalUrl = normalizeText(response && response.finalUrl);

        if (Number.isFinite(status) && status > 0) {
            details.push('status ' + String(status));
        }
        if (statusText) {
            details.push(statusText);
        }
        if (Number.isFinite(readyState) && readyState >= 0) {
            details.push('readyState ' + String(readyState));
        }
        if (finalUrl && finalUrl !== requestUrl) {
            details.push('finalUrl ' + finalUrl);
        }
        if (details.length) {
            parts.push('(' + details.join(' | ') + ')');
        }

        const hints = buildNetworkHints(requestUrl);
        if (hints.length) {
            parts.push(hints.join(' | '));
        }
        return parts.join(' | ');
    }

    function buildNetworkHints(requestUrl) {
        let parsed;
        try {
            parsed = new URL(requestUrl);
        } catch (error) {
            return [];
        }

        const hints = [];
        const hostname = normalizeText(parsed.hostname).toLowerCase();
        const pathName = normalizeText(parsed.pathname);

        if (hostname === '0.0.0.0') {
            hints.push('0.0.0.0 no sirve como destino del navegador; usa la IP o dominio real de la VPS');
        }
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') {
            hints.push('localhost apunta a la maquina del navegador; solo vale si el tracker corre ahi');
        }
        if (location.protocol === 'https:' && parsed.protocol === 'http:') {
            hints.push('pagina https contra endpoint http; revisa bloqueo por mixed content o proxy');
        }
        if (!pathName || pathName === '/') {
            hints.push('revisa la base API; normalmente el endpoint acaba en /tracker');
        }

        return hints;
    }

    function startGalaxyHeartbeat() {
        if (galaxyHeartbeatTimer) {
            clearInterval(galaxyHeartbeatTimer);
            galaxyHeartbeatTimer = null;
        }
        disconnectGalaxyObservers();
        observedGalaxyLoading = null;
        ensureGalaxyWatchers();
        galaxyHeartbeatTimer = setInterval(() => {
            ensureGalaxyWatchers();
        }, GALAXY_HEARTBEAT_MS);
    }

    function disconnectGalaxyObservers() {
        if (galaxyLoadingObserver) {
            galaxyLoadingObserver.disconnect();
            galaxyLoadingObserver = null;
        }
        if (galaxyChangeObserver) {
            galaxyChangeObserver.disconnect();
            galaxyChangeObserver = null;
        }
    }

    function ensureGalaxyWatchers() {
        if (!isGalaxyPage()) {
            disconnectGalaxyObservers();
            observedGalaxyLoading = null;
            return;
        }

        const galaxyLoading = document.getElementById('galaxyLoading');
        if (!galaxyLoading) {
            return;
        }

        if (observedGalaxyLoading === galaxyLoading) {
            return;
        }

        disconnectGalaxyObservers();
        observedGalaxyLoading = galaxyLoading;
        waitForGalaxyToBeLoaded();
        watchGalaxyChanges();
    }

    function waitForGalaxyToBeLoaded() {
        const galaxyLoading = document.getElementById('galaxyLoading');
        if (!galaxyLoading) {
            return;
        }
        if (window.getComputedStyle(galaxyLoading).display === 'none') {
            onGalaxyReady();
            return;
        }
        galaxyLoadingObserver = new MutationObserver((mutations, observer) => {
            if (window.getComputedStyle(galaxyLoading).display === 'none') {
                observer.disconnect();
                galaxyLoadingObserver = null;
                onGalaxyReady();
            }
        });
        galaxyLoadingObserver.observe(galaxyLoading, { childList: true, attributes: true });
    }

    function watchGalaxyChanges() {
        const galaxyLoading = document.getElementById('galaxyLoading');
        if (!galaxyLoading) {
            return;
        }
        galaxyChangeObserver = new MutationObserver((mutations, observer) => {
            if (window.getComputedStyle(galaxyLoading).display !== 'none') {
                observer.disconnect();
                galaxyChangeObserver = null;
                waitForGalaxyToBeLoaded();
                watchGalaxyChanges();
            }
        });
        galaxyChangeObserver.observe(galaxyLoading, { childList: true, attributes: true });
    }

    function onGalaxyReady() {
        if (!isGalaxyPage()) {
            return;
        }
        if (isMaster()) {
            refreshGalaxyIcons();
            captureVisibleCoordsIfNeeded().catch(() => {});
        }
        if (isSlave()) {
            maybeProcessSlaveStep().catch(() => {});
        }
    }

    function refreshGalaxyIcons() {
        if (!isGalaxyPage()) {
            return;
        }
        const targets = getCurrentTargets();
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
            let icon = cellPlayerName.querySelector('.otrTargetFlag');
            if (!icon) {
                icon = document.createElement('span');
                icon.className = 'otrTargetFlag';
                icon.textContent = '◎';
                cellPlayerName.appendChild(icon);
            }
            const playerName = getPlayerName(row, cellPlayerName);
            const playerId = getPlayerId(cellPlayerName);
            const targetKey = findTargetKey(targets, playerId, playerName);
            icon.classList.toggle('active', Boolean(targetKey));
            icon.classList.toggle('capture', Boolean(targetKey && captureTargetKey === targetKey));
            icon.title = isMaster()
                ? (targetKey ? 'Quitar objetivo' : 'Añadir objetivo')
                : 'Solo el master puede editar objetivos';
            icon.onclick = (event) => {
                event.stopPropagation();
                toggleGalaxyTarget(playerId, playerName, targetKey).catch((error) => {
                    setPanelStatus('Error objetivo: ' + error.message);
                });
            };
        }
    }

    async function toggleGalaxyTarget(playerId, playerName, existingKey) {
        if (!isMaster()) {
            setPanelStatus('Solo el master puede editar objetivos');
            return;
        }

        if (existingKey) {
            const ok = window.confirm('¿Quitar objetivo "' + playerName + '"?');
            if (!ok) {
                return;
            }
            deleteLocalTarget(existingKey);
            if (selectedTargetKey === existingKey) {
                selectedTargetKey = '';
                GM_setValue(KEY_SELECTED_TARGET, '');
            }
            if (captureTargetKey === existingKey) {
                captureTargetKey = '';
                GM_setValue(KEY_CAPTURE_TARGET, '');
            }
            sanitizeTargetSelection();
            markLocalTargetsDirty(true);
            if (isGalaxyPage()) {
                refreshGalaxyIcons();
            }
            renderPanel();
            setPanelStatus('Objetivo quitado');
            return;
        }

        const playerKey = buildTargetKey(playerId, playerName);
        upsertLocalTarget({
            playerKey: playerKey,
            playerId: playerId,
            playerName: playerName
        });
        selectedTargetKey = playerKey;
        GM_setValue(KEY_SELECTED_TARGET, selectedTargetKey);
        markLocalTargetsDirty(true);
        if (isGalaxyPage()) {
            refreshGalaxyIcons();
        }
        renderPanel();
        setPanelStatus('Objetivo añadido');
    }

    function buildTargetKey(playerId, playerName) {
        const id = Number(playerId);
        if (Number.isFinite(id) && id > 0) {
            return 'id:' + String(id);
        }
        return 'name:' + normalizeNameForMatch(playerName || 'unknown');
    }

    function upsertLocalTarget(payload) {
        const normalized = normalizeTargetRecord(payload, payload && payload.playerKey);
        if (!normalized) {
            return null;
        }
        const existing = localTargets[normalized.playerKey];
        const mergedCoords = Array.from(new Set([
            ...((existing && Array.isArray(existing.coords)) ? existing.coords.map(normalizeCoord).filter(Boolean) : []),
            ...normalized.coords
        ])).sort(compareCoords);
        const now = Date.now();
        localTargets[normalized.playerKey] = {
            playerKey: normalized.playerKey,
            playerId: positiveNumber(normalized.playerId, positiveNumber(existing && existing.playerId, 0)),
            playerName: normalized.playerName || normalizeText(existing && existing.playerName) || normalized.playerKey,
            coords: mergedCoords,
            addedAt: positiveNumber(existing && existing.addedAt, now),
            updatedAt: now
        };
        persistLocalTargets();
        sanitizeTargetSelection();
        return localTargets[normalized.playerKey];
    }

    function deleteLocalTarget(playerKey) {
        const key = normalizeText(playerKey);
        if (!key || !localTargets[key]) {
            return;
        }
        delete localTargets[key];
        persistLocalTargets();
        sanitizeTargetSelection();
    }

    function buildTargetCandidateKeys(playerId, playerName) {
        const keys = [buildTargetKey(playerId, playerName)];
        const normalizedName = normalizeNameForMatch(playerName);
        if (normalizedName) {
            keys.push('name:' + normalizedName);
        }
        return Array.from(new Set(keys.filter(Boolean)));
    }

    function normalizeNameForMatch(value) {
        return normalizeText(value).toLowerCase().replace(/\s+/g, ' ');
    }

    function findTargetKey(targets, playerId, playerName) {
        const map = targets && typeof targets === 'object' ? targets : {};
        const candidates = buildTargetCandidateKeys(playerId, playerName);
        for (const key of candidates) {
            if (key && map[key]) {
                return key;
            }
        }
        const normalizedName = normalizeNameForMatch(playerName);
        if (!normalizedName) {
            return '';
        }
        const keys = Object.keys(map);
        for (const key of keys) {
            const target = map[key];
            if (normalizeNameForMatch(target && target.playerName ? target.playerName : '') === normalizedName) {
                return key;
            }
        }
        return '';
    }

    function normalizeCoord(value) {
        const raw = normalizeText(value);
        if (!raw) {
            return '';
        }
        const parts = raw.split(':').map((part) => Number(part));
        if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part <= 0)) {
            return '';
        }
        return parts.join(':');
    }

    function compareCoords(a, b) {
        const left = String(a || '').split(':').map((part) => Number(part));
        const right = String(b || '').split(':').map((part) => Number(part));
        for (let index = 0; index < 3; index += 1) {
            const leftPart = Number.isFinite(left[index]) ? left[index] : 0;
            const rightPart = Number.isFinite(right[index]) ? right[index] : 0;
            if (leftPart !== rightPart) {
                return leftPart - rightPart;
            }
        }
        return 0;
    }

    function readCurrentSystem() {
        const galaxyInput = document.querySelector('#galaxy_input');
        const systemInput = document.querySelector('#system_input');
        if (!galaxyInput || !systemInput) {
            return null;
        }
        const galaxy = normalizeText(galaxyInput.value);
        const system = normalizeText(systemInput.value);
        if (!galaxy || !system) {
            return null;
        }
        return { galaxy: galaxy, system: system };
    }

    function getPlayerName(row, cellPlayerName) {
        let playerName = '';
        const nameNode = row.querySelector('.galaxyCell .playerName.tooltipRel');
        if (nameNode && nameNode.childNodes[0]) {
            playerName = normalizeText(nameNode.childNodes[0].textContent);
        }
        if (!playerName) {
            const ownRow = cellPlayerName.querySelector('.ownPlayerRow');
            if (ownRow) {
                playerName = normalizeText(ownRow.textContent);
            }
        }
        if (!playerName) {
            playerName = normalizeText(cellPlayerName.textContent);
        }
        return playerName;
    }

    function getPlayerId(cellPlayerName) {
        const playerSpan = cellPlayerName.querySelector('span[rel^="player"]');
        if (!playerSpan) {
            return -1;
        }
        const rel = normalizeText(playerSpan.getAttribute('rel'));
        const id = Number(rel.replace(/[^\d]/g, ''));
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
            return normalizeText(elem.textContent) || '-';
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

    function getTargetLabel(playerKey) {
        const targets = getCurrentTargets();
        const target = targets && targets[playerKey] ? targets[playerKey] : null;
        return target && target.playerName ? target.playerName : playerKey;
    }

    function startCaptureMode() {
        if (!isMaster()) {
            return;
        }
        if (!selectedTargetKey) {
            window.alert('Selecciona un objetivo.');
            return;
        }
        captureTargetKey = selectedTargetKey;
        GM_setValue(KEY_CAPTURE_TARGET, captureTargetKey);
        setPanelStatus('Captura activa para ' + getTargetLabel(captureTargetKey));
        if (isGalaxyPage()) {
            refreshGalaxyIcons();
            captureVisibleCoordsIfNeeded().catch(() => {});
        }
    }

    function stopCaptureMode() {
        captureTargetKey = '';
        GM_setValue(KEY_CAPTURE_TARGET, '');
        setPanelStatus('Captura parada');
        if (isGalaxyPage()) {
            refreshGalaxyIcons();
        }
    }

    async function captureVisibleCoordsIfNeeded() {
        if (!isMaster() || !captureTargetKey || !isGalaxyPage() || captureBusy) {
            return;
        }
        const target = localTargets && localTargets[captureTargetKey] ? localTargets[captureTargetKey] : null;
        if (!target) {
            return;
        }
        const currentSystem = readCurrentSystem();
        if (!currentSystem) {
            return;
        }
        const knownCoords = new Set(Array.isArray(target.coords) ? target.coords : []);
        const coordsToAdd = [];
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
            const rowTargetKey = findTargetKey(localTargets, playerId, playerName);
            if (rowTargetKey !== captureTargetKey) {
                continue;
            }
            const coord = normalizeCoord(currentSystem.galaxy + ':' + currentSystem.system + ':' + pos);
            if (!coord || knownCoords.has(coord)) {
                continue;
            }
            knownCoords.add(coord);
            coordsToAdd.push(coord);
        }
        if (!coordsToAdd.length) {
            return;
        }
        captureBusy = true;
        try {
            let changed = false;
            for (const coord of coordsToAdd) {
                const updatedTarget = upsertLocalTarget({
                    playerKey: captureTargetKey,
                    playerId: positiveNumber(target.playerId, 0),
                    playerName: target.playerName,
                    coords: [coord]
                });
                if (updatedTarget) {
                    changed = true;
                }
                setPanelStatus('Coord registrada: ' + coord);
            }
            if (changed) {
                markLocalTargetsDirty(true);
            }
            if (isGalaxyPage()) {
                refreshGalaxyIcons();
            }
            renderPanel();
        } catch (error) {
            setPanelStatus('Error guardando coords: ' + error.message);
        } finally {
            captureBusy = false;
        }
    }

    async function startRemoteScan() {
        if (!isMaster()) {
            return;
        }
        if (!getTargetKeys().length) {
            window.alert('No hay objetivos.');
            return;
        }
        if (!isConfigured()) {
            setPanelStatus('Configura sync antes');
            return;
        }
        try {
            await syncMasterTargetsNow({ force: true });
            await requestJson('POST', '/runner/start', {
                playerKey: selectedTargetKey,
                cycleIntervalMs: cycleIntervalMs,
                hopDelayMs: hopDelayMs
            });
            await refreshMasterState();
            setPanelStatus('Escaneo de todos los objetivos enviado al slave');
        } catch (error) {
            setPanelStatus('Error iniciando escaneo: ' + error.message);
        }
    }

    async function stopRemoteScan() {
        if (!isMaster()) {
            return;
        }
        try {
            await requestJson('POST', '/runner/stop', {});
            await refreshMasterState();
            setPanelStatus('Parada enviada al slave');
        } catch (error) {
            setPanelStatus('Error parando escaneo: ' + error.message);
        }
    }

    function handleSlavePlan(plan) {
        if (!isSlave()) {
            return;
        }
        if (!plan) {
            if (slaveRuntime.active) {
                stopSlaveRuntime('Sin plan activo');
            }
            return;
        }
        const nextPlanId = normalizeText(plan.planId);
        if (!nextPlanId) {
            return;
        }
        if (slaveRuntime.active && slaveRuntime.planId === nextPlanId) {
            return;
        }
        startSlaveRuntime(plan);
    }

    function startSlaveRuntime(plan) {
        clearSlaveTimers();
        slaveRuntime = createEmptySlaveRuntime();
        slaveRuntime.active = true;
        slaveRuntime.planId = normalizeText(plan.planId);
        slaveRuntime.planLabel = normalizeText(plan.playerName || plan.playerKey) || normalizeText(plan.planId);
        slaveRuntime.steps = normalizeSlavePlanSteps(plan.steps || []);
        slaveRuntime.queue = slaveRuntime.steps.map((step) => step.coord);
        slaveRuntime.coordSet = new Set(Array.isArray(plan.coords) ? plan.coords.map(normalizeCoord).filter(Boolean) : []);
        slaveRuntime.cycleIntervalMs = clampCycleInterval(Number(plan.cycleIntervalMs || DEFAULT_CYCLE_INTERVAL_MS));
        slaveRuntime.hopDelayMs = clampHopDelay(Number(plan.hopDelayMs || DEFAULT_HOP_DELAY_MS));
        slaveRuntime.index = 0;
        slaveRuntime.currentCoord = '';
        slaveRuntime.playerKey = '';
        slaveRuntime.playerName = '';
        slaveRuntime.waitingLoad = false;
        slaveRuntime.reporting = false;
        slaveRuntime.cooldown = false;
        slaveRuntime.lastError = '';
        if (!slaveRuntime.steps.length) {
            stopSlaveRuntime('Plan vacio');
            return;
        }
        setPanelStatus('Slave: nuevo plan recibido');
        runNextSlaveStep();
    }

    function clearSlaveTimers() {
        if (slaveRuntime.timeoutTimer) {
            clearTimeout(slaveRuntime.timeoutTimer);
            slaveRuntime.timeoutTimer = null;
        }
        if (slaveRuntime.stepTimer) {
            clearTimeout(slaveRuntime.stepTimer);
            slaveRuntime.stepTimer = null;
        }
        if (slaveRuntime.cycleTimer) {
            clearTimeout(slaveRuntime.cycleTimer);
            slaveRuntime.cycleTimer = null;
        }
    }

    function stopSlaveRuntime(reason) {
        clearSlaveTimers();
        slaveRuntime.active = false;
        slaveRuntime.waitingLoad = false;
        slaveRuntime.reporting = false;
        slaveRuntime.cooldown = false;
        slaveRuntime.currentCoord = '';
        slaveRuntime.index = 0;
        slaveRuntime.planId = '';
        if (reason) {
            slaveRuntime.lastError = reason;
            setPanelStatus(reason);
        }
        renderPanel();
    }

    function navigateToGalaxy() {
        const url = location.origin + '/game/index.php?page=ingame&component=galaxy';
        location.assign(url);
    }

    function runNextSlaveStep() {
        clearSlaveTimers();
        if (!slaveRuntime.active) {
            return;
        }
        if (!isGalaxyPage()) {
            setPanelStatus('Slave: abriendo galaxia');
            navigateToGalaxy();
            return;
        }
        if (slaveRuntime.index >= slaveRuntime.steps.length) {
            slaveRuntime.cooldown = true;
            slaveRuntime.currentCoord = '';
            slaveRuntime.playerKey = '';
            slaveRuntime.playerName = '';
            slaveRuntime.cycleTimer = setTimeout(() => {
                slaveRuntime.cooldown = false;
                slaveRuntime.index = 0;
                runNextSlaveStep();
            }, slaveRuntime.cycleIntervalMs);
            renderPanel();
            return;
        }
        const step = slaveRuntime.steps[slaveRuntime.index];
        if (!step) {
            slaveRuntime.index += 1;
            slaveRuntime.stepTimer = setTimeout(runNextSlaveStep, slaveRuntime.hopDelayMs);
            return;
        }
        const coord = step.coord;
        const coordParts = coord.split(':');
        slaveRuntime.playerKey = step.playerKey;
        slaveRuntime.playerName = step.playerName;
        slaveRuntime.currentCoord = coord;
        slaveRuntime.waitingLoad = true;
        slaveRuntime.reporting = false;
        slaveRuntime.cooldown = false;
        const currentSystem = readCurrentSystem();
        if (currentSystem && coordParts.length === 3 && currentSystem.galaxy === coordParts[0] && currentSystem.system === coordParts[1]) {
            maybeProcessSlaveStep().catch(() => {});
            renderPanel();
            return;
        }
        const moved = goToCoord(coord);
        if (!moved) {
            slaveRuntime.lastError = 'No se pudo navegar a ' + coord;
            slaveRuntime.index += 1;
            slaveRuntime.stepTimer = setTimeout(runNextSlaveStep, slaveRuntime.hopDelayMs);
            renderPanel();
            return;
        }
        slaveRuntime.timeoutTimer = setTimeout(() => {
            if (!slaveRuntime.active || !slaveRuntime.waitingLoad) {
                return;
            }
            slaveRuntime.waitingLoad = false;
            slaveRuntime.lastError = 'Timeout cargando ' + coord;
            slaveRuntime.index += 1;
            runNextSlaveStep();
        }, STEP_TIMEOUT_MS);
        renderPanel();
    }

    async function maybeProcessSlaveStep() {
        if (!isSlave() || !slaveRuntime.active || !slaveRuntime.waitingLoad || slaveRuntime.reporting) {
            return;
        }
        const currentSystem = readCurrentSystem();
        if (!currentSystem) {
            return;
        }
        const expected = normalizeCoord(slaveRuntime.currentCoord);
        if (!expected) {
            return;
        }
        const expectedParts = expected.split(':');
        if (expectedParts.length !== 3) {
            return;
        }
        if (currentSystem.galaxy !== expectedParts[0] || currentSystem.system !== expectedParts[1]) {
            return;
        }
        slaveRuntime.waitingLoad = false;
        slaveRuntime.reporting = true;
        if (slaveRuntime.timeoutTimer) {
            clearTimeout(slaveRuntime.timeoutTimer);
            slaveRuntime.timeoutTimer = null;
        }
        try {
            const observations = collectSlaveObservations();
            await requestJson('POST', '/slave/report', {
                slaveId: clientId,
                state: buildSlaveRuntimeState(),
                playerKey: slaveRuntime.playerKey,
                currentCoord: slaveRuntime.currentCoord,
                progressIndex: slaveRuntime.index + 1,
                progressTotal: slaveRuntime.steps.length,
                activePlanId: slaveRuntime.planId,
                lastError: slaveRuntime.lastError,
                observations: observations
            });
        } catch (error) {
            slaveRuntime.lastError = error.message;
        } finally {
            slaveRuntime.reporting = false;
            slaveRuntime.index += 1;
            slaveRuntime.stepTimer = setTimeout(runNextSlaveStep, slaveRuntime.hopDelayMs);
            renderPanel();
        }
    }

    function collectSlaveObservations() {
        const currentSystem = readCurrentSystem();
        if (!currentSystem) {
            return [];
        }
        const targets = remoteState.targets && typeof remoteState.targets === 'object' ? remoteState.targets : {};
        const observations = [];
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
            const rowTargetKey = findTargetKey(targets, playerId, playerName);
            if (!rowTargetKey) {
                continue;
            }
            const target = targets[rowTargetKey] || null;
            const coord = normalizeCoord(currentSystem.galaxy + ':' + currentSystem.system + ':' + pos);
            const scannedAt = Date.now();
            observations.push({
                playerKey: rowTargetKey,
                playerId: positiveNumber(playerId, positiveNumber(target && target.playerId, 0)),
                playerName: normalizeText((target && target.playerName) || playerName || rowTargetKey) || rowTargetKey,
                coord: coord,
                scannedAt: scannedAt,
                bucketTs: floorToBucket(scannedAt),
                dayKey: buildLocalDateKey(scannedAt),
                planetActivity: readActivity(row.querySelector('[data-planet-id] .activity')),
                moonActivity: readActivity(row.querySelector('[data-moon-id] .activity')),
                debris: readDebris(pos)
            });
        }
        return observations;
    }

    function floorToBucket(ts) {
        return Math.floor(Number(ts || Date.now()) / BUCKET_MS) * BUCKET_MS;
    }

    function buildLocalDateKey(ts) {
        const date = new Date(ts);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return year + '-' + month + '-' + day;
    }

    function goToCoord(coord) {
        const parts = String(coord || '').split(':').map((part) => Number(part));
        if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part <= 0)) {
            return false;
        }
        const [galaxy, system, position] = parts;
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (pageWindow.galaxy && typeof pageWindow.galaxy.updateGalaxy === 'function') {
            try {
                pageWindow.galaxy.updateGalaxy(galaxy, system, position);
                return true;
            } catch (error) {
                // fallback below
            }
        }
        const galaxyInput = document.querySelector('#galaxy_input');
        const systemInput = document.querySelector('#system_input');
        const positionInput = document.querySelector('#position_input');
        if (galaxyInput) {
            galaxyInput.value = galaxy;
            galaxyInput.dispatchEvent(new Event('input', { bubbles: true }));
            galaxyInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (systemInput) {
            systemInput.value = system;
            systemInput.dispatchEvent(new Event('input', { bubbles: true }));
            systemInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (positionInput) {
            positionInput.value = position;
            positionInput.dispatchEvent(new Event('input', { bubbles: true }));
            positionInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (pageWindow.galaxy && typeof pageWindow.galaxy.submitGalaxy === 'function') {
            try {
                pageWindow.galaxy.submitGalaxy();
                return true;
            } catch (error) {
                // fallback below
            }
        }
        if (typeof pageWindow.submitForm === 'function') {
            try {
                pageWindow.submitForm();
                return true;
            } catch (error) {
                return false;
            }
        }
        return false;
    }

    function formatLocalSlaveStatus() {
        if (!slaveRuntime.active) {
            return 'idle';
        }
        let text = buildSlaveRuntimeState();
        if (slaveRuntime.currentCoord) {
            text += ' | ' + slaveRuntime.currentCoord;
        }
        if (slaveRuntime.queue.length) {
            text += ' | ' + String(slaveRuntime.index) + '/' + String(slaveRuntime.queue.length);
        }
        if (slaveRuntime.lastError) {
            text += ' | err: ' + slaveRuntime.lastError;
        }
        return text;
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function openHistoryModal() {
        if (!isMaster()) {
            setPanelStatus('El historial solo se abre en master');
            return;
        }
        historyState.open = true;
        renderHistoryModal();
        await reloadHistory(true);
    }

    function closeHistoryModal() {
        historyState.open = false;
        renderHistoryModal();
    }

    async function reloadHistory(refreshPlayers) {
        if (!isMaster() || !isConfigured()) {
            historyState.message = 'Configura sync primero';
            renderHistoryModal();
            return;
        }
        historyState.loading = true;
        renderHistoryModal();
        try {
            if (refreshPlayers) {
                const playersPayload = await requestJson('GET', '/history/players');
                historyState.players = Array.isArray(playersPayload && playersPayload.players) ? playersPayload.players : [];
                const validKeys = new Set(historyState.players.map((player) => player.playerKey));
                if (!historyState.playerKey || !validKeys.has(historyState.playerKey)) {
                    historyState.playerKey = validKeys.has(selectedTargetKey)
                        ? selectedTargetKey
                        : (historyState.players[0] ? historyState.players[0].playerKey : '');
                    GM_setValue(KEY_HISTORY_PLAYER, historyState.playerKey);
                }
            }

            if (!historyState.playerKey) {
                historyState.meta = null;
                historyState.day = null;
                historyState.message = 'No hay jugadores todavía';
                return;
            }

            historyState.meta = await requestJson('GET', '/history/meta', undefined, {
                playerKey: historyState.playerKey
            });

            const dates = Array.isArray(historyState.meta && historyState.meta.dates) ? historyState.meta.dates : [];
            if (!historyState.dateKey || !dates.includes(historyState.dateKey)) {
                historyState.dateKey = dates.length ? dates[dates.length - 1] : '';
                GM_setValue(KEY_HISTORY_DATE, historyState.dateKey);
            }

            if (!historyState.dateKey) {
                historyState.day = null;
                historyState.message = 'Sin historial para ese jugador';
                return;
            }

            historyState.day = await requestJson('GET', '/history/day', undefined, {
                playerKey: historyState.playerKey,
                date: historyState.dateKey
            });
            historyState.message = '';
        } catch (error) {
            historyState.message = 'Error cargando historial: ' + error.message;
        } finally {
            historyState.loading = false;
            renderHistoryModal();
        }
    }

    function renderHistoryModal() {
        const root = document.getElementById(MODAL_ID);
        if (!root) {
            return;
        }
        if (!historyState.open) {
            root.className = '';
            root.innerHTML = '';
            return;
        }

        const playerOptions = ['<option value="">-- Jugador --</option>'].concat(historyState.players.map((player) => {
            const selected = player.playerKey === historyState.playerKey ? ' selected' : '';
            const label = player.playerName + (player.hasHistory ? '' : ' (sin datos)');
            return '<option value="' + escapeHtml(player.playerKey) + '"' + selected + '>' + escapeHtml(label) + '</option>';
        })).join('');

        const dateOptions = ['<option value="">-- Fecha --</option>'].concat(((historyState.meta && historyState.meta.dates) || []).map((dateKey) => {
            const selected = dateKey === historyState.dateKey ? ' selected' : '';
            return '<option value="' + escapeHtml(dateKey) + '"' + selected + '>' + escapeHtml(dateKey) + '</option>';
        })).join('');

        root.className = 'open';
        root.innerHTML = `
            <div class="otrModalPanel">
                <div class="otrModalHead">
                    <div class="otrModalTitle">Historial remoto</div>
                    <button id="otrHistoryClose">Cerrar</button>
                </div>
                <div class="otrModalBody">
                    <div class="otrModalRow otrModalButtons">
                        <select id="otrHistoryPlayerSelect">${playerOptions}</select>
                        <select id="otrHistoryDateSelect">${dateOptions}</select>
                        <button id="otrHistoryPrev">&lt; Día</button>
                        <button id="otrHistoryNext">Día &gt;</button>
                        <button id="otrHistoryRefresh">${historyState.loading ? 'Cargando...' : 'Actualizar'}</button>
                        <button id="otrHistoryDelete" class="danger">Borrar historial</button>
                    </div>
                    <div class="otrModalRow otrHistoryMeta">${escapeHtml(historyMetaLine())}</div>
                    <div class="otrModalRow">${renderHistoryContent()}</div>
                </div>
            </div>
        `;

        bindHistoryModalEvents();
    }

    function historyMetaLine() {
        if (historyState.loading) {
            return 'Cargando...';
        }
        if (historyState.message) {
            return historyState.message;
        }
        if (!historyState.meta || !historyState.meta.player) {
            return 'Sin datos';
        }
        const player = historyState.meta.player;
        const coordsCount = Array.isArray(historyState.meta.coords) ? historyState.meta.coords.length : 0;
        return 'Jugador: ' + (player.playerName || player.playerKey) + ' | coords: ' + String(coordsCount);
    }

    function renderHistoryContent() {
        if (historyState.loading) {
            return '<div class="otrHistoryMeta">Cargando historial...</div>';
        }
        if (historyState.message) {
            return '<div class="otrHistoryMeta">' + escapeHtml(historyState.message) + '</div>';
        }
        if (!historyState.day || !Array.isArray(historyState.day.coords) || !historyState.day.coords.length) {
            return '<div class="otrHistoryMeta">Sin datos para ese día</div>';
        }
        return renderHistoryDay(historyState.day);
    }

    function renderHistoryDay(payload) {
        const bucketTimes = [];
        const start = new Date(payload.date + 'T00:00:00').getTime();
        const end = start + (24 * 60 * 60 * 1000) - BUCKET_MS;
        for (let ts = start; ts <= end; ts += BUCKET_MS) {
            bucketTimes.push(ts);
        }

        const recordMap = new Map();
        const records = Array.isArray(payload.records) ? payload.records : [];
        records.forEach((record) => {
            recordMap.set((record.coord || '') + '|' + String(record.bucketTs || 0), record);
        });

        let html = '<div class="otrHistoryTableWrap"><table><thead><tr><th class="otrStickyLeft">Coords</th>';
        bucketTimes.forEach((bucketTs) => {
            html += '<th>' + escapeHtml(formatTime(bucketTs)) + '</th>';
        });
        html += '</tr></thead><tbody>';

        payload.coords.slice().sort(compareCoords).forEach((coord) => {
            html += '<tr><td class="otrStickyLeft">' + escapeHtml(coord) + '</td>';
            bucketTimes.forEach((bucketTs) => {
                const record = recordMap.get(coord + '|' + String(bucketTs));
                html += '<td>' + formatHistoryCell(record) + '</td>';
            });
            html += '</tr>';
        });

        html += '</tbody></table></div>';
        return html;
    }

    function formatTime(ts) {
        return new Date(ts).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function formatHistoryCell(record) {
        if (!record) {
            return '';
        }
        return '<div class="otrCellTime">' + escapeHtml(formatTime(record.scannedAt)) + '</div>' +
            '<span class="' + activityCellClass(record.planetActivity) + '">P:' + escapeHtml(record.planetActivity || '-') + '</span>' +
            '<span class="' + activityCellClass(record.moonActivity) + '">L:' + escapeHtml(record.moonActivity || '-') + '</span>' +
            '<span class="' + (record.debris === 'si' ? 'otrDebrisYes' : 'otrDebrisNo') + '">D:' + escapeHtml(record.debris || 'no') + '</span>';
    }

    function activityCellClass(value) {
        const raw = normalizeText(value || '-');
        if (raw === '*') {
            return 'otrCellRed';
        }
        if (raw !== '-' && raw !== '') {
            return 'otrCellYellow';
        }
        return 'otrCellGreen';
    }

    function bindHistoryModalEvents() {
        const closeBtn = document.getElementById('otrHistoryClose');
        if (closeBtn) {
            closeBtn.onclick = closeHistoryModal;
        }

        const playerSelect = document.getElementById('otrHistoryPlayerSelect');
        if (playerSelect) {
            playerSelect.onchange = async () => {
                historyState.playerKey = normalizeText(playerSelect.value);
                historyState.dateKey = '';
                GM_setValue(KEY_HISTORY_PLAYER, historyState.playerKey);
                GM_setValue(KEY_HISTORY_DATE, '');
                await reloadHistory(false);
            };
        }

        const dateSelect = document.getElementById('otrHistoryDateSelect');
        if (dateSelect) {
            dateSelect.onchange = async () => {
                historyState.dateKey = normalizeText(dateSelect.value);
                GM_setValue(KEY_HISTORY_DATE, historyState.dateKey);
                await reloadHistory(false);
            };
        }

        const refreshBtn = document.getElementById('otrHistoryRefresh');
        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                await reloadHistory(true);
            };
        }

        const prevBtn = document.getElementById('otrHistoryPrev');
        if (prevBtn) {
            prevBtn.onclick = async () => {
                await moveHistoryDate(-1);
            };
        }

        const nextBtn = document.getElementById('otrHistoryNext');
        if (nextBtn) {
            nextBtn.onclick = async () => {
                await moveHistoryDate(1);
            };
        }

        const deleteBtn = document.getElementById('otrHistoryDelete');
        if (deleteBtn) {
            deleteBtn.onclick = async () => {
                await deleteCurrentHistory();
            };
        }
    }

    async function moveHistoryDate(direction) {
        const dates = Array.isArray(historyState.meta && historyState.meta.dates) ? historyState.meta.dates : [];
        if (!dates.length || !historyState.dateKey) {
            return;
        }
        const index = dates.indexOf(historyState.dateKey);
        if (index < 0) {
            return;
        }
        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= dates.length) {
            return;
        }
        historyState.dateKey = dates[nextIndex];
        GM_setValue(KEY_HISTORY_DATE, historyState.dateKey);
        await reloadHistory(false);
    }

    async function deleteCurrentHistory() {
        if (!historyState.playerKey) {
            return;
        }
        const playerName = historyState.meta && historyState.meta.player
            ? (historyState.meta.player.playerName || historyState.meta.player.playerKey)
            : historyState.playerKey;
        const ok = window.confirm('¿Borrar todo el historial de "' + playerName + '"?');
        if (!ok) {
            return;
        }
        try {
            await requestJson('POST', '/history/delete-player', {
                playerKey: historyState.playerKey
            });
            historyState.dateKey = '';
            GM_setValue(KEY_HISTORY_DATE, '');
            await reloadHistory(true);
        } catch (error) {
            historyState.message = 'Error borrando historial: ' + error.message;
            renderHistoryModal();
        }
    }
})();
