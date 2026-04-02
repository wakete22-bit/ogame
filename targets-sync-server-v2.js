#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8788);
const SYNC_TOKEN = String(process.env.SYNC_TOKEN || '').trim();
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'targets-store-v2.json');
const API_BASE = '/v2';
const MAX_BODY_BYTES = 1024 * 1024;
const BUCKET_MS = 5 * 60 * 1000;
const SLAVE_ONLINE_WINDOW_MS = 20 * 1000;

function safeNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
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

function uniqueCoords(coords) {
    const set = new Set();
    if (Array.isArray(coords)) {
        coords.forEach((coord) => {
            const normalized = normalizeCoord(coord);
            if (normalized) {
                set.add(normalized);
            }
        });
    }
    return Array.from(set).sort(compareCoords);
}

function systemKeyFromCoord(coord) {
    const normalized = normalizeCoord(coord);
    if (!normalized) {
        return '';
    }
    const parts = normalized.split(':');
    return parts[0] + ':' + parts[1];
}

function floorToBucket(ts) {
    return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

function dateKey(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
}

function createEmptyState() {
    return {
        updatedAt: 0,
        targets: {},
        history: {
            players: {},
            buckets: {}
        },
        runner: {
            currentCommand: null,
            slaveStatus: {
                slaveId: '',
                online: false,
                state: 'idle',
                currentCoord: '',
                progressIndex: 0,
                progressTotal: 0,
                activeCommandId: '',
                lastError: '',
                lastSeenAt: 0,
                updatedAt: 0
            }
        }
    };
}

function normalizeTarget(input, fallbackKey) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const playerKey = normalizeText(input.playerKey || fallbackKey);
    if (!playerKey) {
        return null;
    }
    const playerName = normalizeText(input.playerName || playerKey) || playerKey;
    const coords = uniqueCoords(input.coords);
    const primaryCoordRaw = normalizeCoord(input.primaryCoord);
    const primaryCoord = primaryCoordRaw && coords.includes(primaryCoordRaw) ? primaryCoordRaw : '';
    return {
        playerKey: playerKey,
        playerName: playerName,
        coords: coords,
        primaryCoord: primaryCoord,
        addedAt: safeNumber(input.addedAt, Date.now()),
        updatedAt: safeNumber(input.updatedAt, Date.now())
    };
}

function normalizeTargetsMap(input) {
    const result = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return result;
    }
    Object.keys(input).forEach((key) => {
        const normalized = normalizeTarget(input[key], key);
        if (normalized) {
            result[normalized.playerKey] = normalized;
        }
    });
    return result;
}

function normalizeHistoryPlayer(input, fallbackKey) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const playerKey = normalizeText(input.playerKey || fallbackKey);
    if (!playerKey) {
        return null;
    }
    return {
        playerKey: playerKey,
        playerName: normalizeText(input.playerName || playerKey) || playerKey,
        lastSeen: safeNumber(input.lastSeen, 0)
    };
}

function normalizeHistoryBucket(input, fallbackId) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const playerKey = normalizeText(input.playerKey);
    const coords = normalizeCoord(input.coords);
    const bucketTs = safeNumber(input.bucketTs, 0);
    if (!playerKey || !coords || bucketTs <= 0) {
        return null;
    }
    const entries = [];
    if (Array.isArray(input.entries)) {
        input.entries.forEach((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return;
            }
            const t = safeNumber(entry.t, 0);
            if (t <= 0) {
                return;
            }
            entries.push({
                t: t,
                planet: normalizeText(entry.planet || '-') || '-',
                moon: normalizeText(entry.moon || '-') || '-',
                debris: normalizeText(entry.debris || 'no') === 'si' ? 'si' : 'no'
            });
        });
    }
    const id = normalizeText(input.id || fallbackId || (playerKey + '|' + coords + '|' + bucketTs));
    if (!id) {
        return null;
    }
    const lastUpdated = safeNumber(input.lastUpdated, entries.length ? entries[entries.length - 1].t : bucketTs);
    return {
        id: id,
        playerKey: playerKey,
        playerName: normalizeText(input.playerName || playerKey) || playerKey,
        coords: coords,
        bucketTs: bucketTs,
        entries: entries,
        lastUpdated: lastUpdated
    };
}

function normalizeHistory(input) {
    const history = { players: {}, buckets: {} };
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return history;
    }
    const rawPlayers = input.players;
    if (rawPlayers && typeof rawPlayers === 'object' && !Array.isArray(rawPlayers)) {
        Object.keys(rawPlayers).forEach((key) => {
            const normalized = normalizeHistoryPlayer(rawPlayers[key], key);
            if (normalized) {
                history.players[normalized.playerKey] = normalized;
            }
        });
    }
    const rawBuckets = input.buckets;
    if (rawBuckets && typeof rawBuckets === 'object' && !Array.isArray(rawBuckets)) {
        Object.keys(rawBuckets).forEach((key) => {
            const normalized = normalizeHistoryBucket(rawBuckets[key], key);
            if (normalized) {
                history.buckets[normalized.id] = normalized;
            }
        });
    }
    return history;
}

function normalizeCommand(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const commandId = normalizeText(input.commandId);
    const action = normalizeText(input.action).toLowerCase();
    if (!commandId || !action) {
        return null;
    }
    if (action === 'stop') {
        return {
            commandId: commandId,
            action: 'stop',
            issuedAt: safeNumber(input.issuedAt, Date.now()),
            issuedBy: normalizeText(input.issuedBy || 'master') || 'master'
        };
    }
    if (action !== 'scan') {
        return null;
    }
    const mode = normalizeText(input.mode).toLowerCase() === 'continuous' ? 'continuous' : 'once';
    const queue = uniqueCoords(input.queue);
    return {
        commandId: commandId,
        action: 'scan',
        mode: mode,
        playerKey: normalizeText(input.playerKey),
        issuedAt: safeNumber(input.issuedAt, Date.now()),
        issuedBy: normalizeText(input.issuedBy || 'master') || 'master',
        intervalMs: Math.max(10000, safeNumber(input.intervalMs, 60000)),
        queue: queue
    };
}

function normalizeSlaveStatus(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return createEmptyState().runner.slaveStatus;
    }
    return {
        slaveId: normalizeText(input.slaveId),
        online: Boolean(input.online),
        state: normalizeText(input.state || 'idle') || 'idle',
        currentCoord: normalizeCoord(input.currentCoord) || '',
        progressIndex: Math.max(0, safeNumber(input.progressIndex, 0)),
        progressTotal: Math.max(0, safeNumber(input.progressTotal, 0)),
        activeCommandId: normalizeText(input.activeCommandId),
        lastError: normalizeText(input.lastError),
        lastSeenAt: Math.max(0, safeNumber(input.lastSeenAt, 0)),
        updatedAt: Math.max(0, safeNumber(input.updatedAt, 0))
    };
}

function loadState() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return createEmptyState();
        }
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        if (!raw.trim()) {
            return createEmptyState();
        }
        const parsed = JSON.parse(raw);
        const next = createEmptyState();
        next.updatedAt = safeNumber(parsed.updatedAt, 0);
        next.targets = normalizeTargetsMap(parsed.targets);
        next.history = normalizeHistory(parsed.history);
        if (parsed.runner && typeof parsed.runner === 'object' && !Array.isArray(parsed.runner)) {
            next.runner.currentCommand = normalizeCommand(parsed.runner.currentCommand);
            next.runner.slaveStatus = normalizeSlaveStatus(parsed.runner.slaveStatus);
        }
        return next;
    } catch (err) {
        console.warn('[ptre-v2] failed to load state:', err.message);
        return createEmptyState();
    }
}

let state = loadState();

function persistState() {
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
}

function isAuthorized(req) {
    if (!SYNC_TOKEN) {
        return true;
    }
    return req.headers['x-ptre-token'] === SYNC_TOKEN;
}

function parseRequestUrl(req) {
    try {
        return new URL(req.url || '/', 'http://localhost');
    } catch (err) {
        return new URL(API_BASE + '/health', 'http://localhost');
    }
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PTRE-Token, x-ptre-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let bytes = 0;
        let body = '';
        req.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) {
                reject(new Error('payload too large'));
                req.destroy();
                return;
            }
            body += chunk.toString('utf8');
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function nowTs() {
    return Date.now();
}

function markUpdated() {
    state.updatedAt = nowTs();
}

function buildRunnerStatus() {
    const status = Object.assign({}, state.runner.slaveStatus);
    status.online = Boolean(status.lastSeenAt > 0 && (nowTs() - status.lastSeenAt) <= SLAVE_ONLINE_WINDOW_MS);
    return {
        currentCommand: state.runner.currentCommand,
        slaveStatus: status
    };
}

function buildStatePayload() {
    return {
        updatedAt: state.updatedAt,
        targets: state.targets,
        runner: buildRunnerStatus()
    };
}

function buildHistoryPlayers() {
    const list = Object.keys(state.targets).map((playerKey) => {
        const target = state.targets[playerKey];
        const hist = state.history.players[playerKey] || null;
        return {
            playerKey: playerKey,
            playerName: hist && hist.playerName ? hist.playerName : target.playerName,
            lastSeen: hist ? hist.lastSeen : 0,
            coords: uniqueCoords((target && target.coords) || [])
        };
    });
    list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return list;
}

function buildHistoryMeta(playerKey) {
    const key = normalizeText(playerKey);
    const dates = new Set();
    const coords = new Set();
    Object.keys(state.history.buckets).forEach((bucketId) => {
        const rec = state.history.buckets[bucketId];
        if (!rec || rec.playerKey !== key) {
            return;
        }
        dates.add(dateKey(rec.bucketTs));
        coords.add(rec.coords);
    });
    const target = state.targets[key];
    if (target && Array.isArray(target.coords)) {
        target.coords.forEach((coord) => {
            const normalized = normalizeCoord(coord);
            if (normalized) {
                coords.add(normalized);
            }
        });
    }
    return {
        playerKey: key,
        dates: Array.from(dates).sort(),
        coords: Array.from(coords).sort(compareCoords),
        primaryCoord: target && target.primaryCoord ? target.primaryCoord : ''
    };
}

function buildHistoryDay(playerKey, dateValue) {
    const key = normalizeText(playerKey);
    const dateStr = normalizeText(dateValue);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return null;
    }
    const target = state.targets[key] || null;
    const histPlayer = state.history.players[key] || null;
    const buckets = [];
    Object.keys(state.history.buckets).forEach((bucketId) => {
        const rec = state.history.buckets[bucketId];
        if (!rec || rec.playerKey !== key) {
            return;
        }
        if (dateKey(rec.bucketTs) !== dateStr) {
            return;
        }
        buckets.push(rec);
    });
    buckets.sort((a, b) => (a.bucketTs || 0) - (b.bucketTs || 0));
    return {
        player: {
            playerKey: key,
            playerName: histPlayer && histPlayer.playerName ? histPlayer.playerName : (target ? target.playerName : key),
            primaryCoord: target && target.primaryCoord ? target.primaryCoord : ''
        },
        date: dateStr,
        bucketMs: BUCKET_MS,
        buckets: buckets
    };
}

function buildQueueForTarget(target) {
    if (!target) {
        return [];
    }
    const coords = uniqueCoords(target.coords);
    if (!coords.length) {
        return [];
    }
    const ordered = target.primaryCoord && coords.includes(target.primaryCoord)
        ? [target.primaryCoord].concat(coords.filter((coord) => coord !== target.primaryCoord))
        : coords.slice();
    const seenSystems = new Set();
    const queue = [];
    ordered.forEach((coord) => {
        const systemKey = systemKeyFromCoord(coord);
        if (!systemKey || seenSystems.has(systemKey)) {
            return;
        }
        seenSystems.add(systemKey);
        queue.push(coord);
    });
    return queue;
}

function upsertTarget(payload) {
    const playerKey = normalizeText(payload.playerKey);
    const playerName = normalizeText(payload.playerName || playerKey) || playerKey;
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    const coord = normalizeCoord(payload.coord);
    const primaryCoord = normalizeCoord(payload.primaryCoord);
    const now = nowTs();
    const existing = state.targets[playerKey];
    const mergedCoords = uniqueCoords((existing && existing.coords) || []).concat(coord ? [coord] : []);
    const target = {
        playerKey: playerKey,
        playerName: playerName,
        coords: uniqueCoords(mergedCoords),
        primaryCoord: '',
        addedAt: existing ? existing.addedAt : now,
        updatedAt: now
    };
    if (primaryCoord && target.coords.includes(primaryCoord)) {
        target.primaryCoord = primaryCoord;
    } else if (existing && existing.primaryCoord && target.coords.includes(existing.primaryCoord)) {
        target.primaryCoord = existing.primaryCoord;
    } else if (coord) {
        target.primaryCoord = coord;
    }
    state.targets[playerKey] = target;
    markUpdated();
    persistState();
    return target;
}

function deleteTarget(playerKeyRaw) {
    const playerKey = normalizeText(playerKeyRaw);
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    delete state.targets[playerKey];
    if (state.runner.currentCommand && state.runner.currentCommand.playerKey === playerKey) {
        state.runner.currentCommand = null;
    }
    markUpdated();
    persistState();
}

function setPrimaryCoord(playerKeyRaw, coordRaw) {
    const playerKey = normalizeText(playerKeyRaw);
    const coord = normalizeCoord(coordRaw);
    if (!playerKey || !coord) {
        throw new Error('playerKey y coord requeridos');
    }
    const target = state.targets[playerKey];
    if (!target) {
        throw new Error('objetivo no encontrado');
    }
    const coords = uniqueCoords((target.coords || []).concat([coord]));
    target.coords = coords;
    target.primaryCoord = coord;
    target.updatedAt = nowTs();
    markUpdated();
    persistState();
    return target;
}

function createScanCommand(playerKeyRaw, modeRaw, intervalMsRaw) {
    const playerKey = normalizeText(playerKeyRaw);
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    const target = state.targets[playerKey];
    if (!target) {
        throw new Error('objetivo no encontrado');
    }
    const queue = buildQueueForTarget(target);
    if (!queue.length) {
        throw new Error('objetivo sin coordenadas conocidas');
    }
    const mode = String(modeRaw || 'once').toLowerCase() === 'continuous' ? 'continuous' : 'once';
    state.runner.currentCommand = {
        commandId: 'cmd-' + nowTs().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        action: 'scan',
        mode: mode,
        playerKey: playerKey,
        issuedAt: nowTs(),
        issuedBy: 'master',
        intervalMs: Math.max(10000, safeNumber(intervalMsRaw, 60000)),
        queue: queue
    };
    markUpdated();
    persistState();
    return state.runner.currentCommand;
}

function createStopCommand() {
    state.runner.currentCommand = {
        commandId: 'cmd-' + nowTs().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        action: 'stop',
        issuedAt: nowTs(),
        issuedBy: 'master'
    };
    markUpdated();
    persistState();
    return state.runner.currentCommand;
}

function mergeObservation(obs) {
    const playerKey = normalizeText(obs.playerKey);
    const target = state.targets[playerKey];
    if (!target) {
        return;
    }
    const coords = normalizeCoord(obs.coords);
    const seenAt = safeNumber(obs.seenAt, 0);
    if (!coords || seenAt <= 0) {
        return;
    }
    const bucketTs = floorToBucket(safeNumber(obs.bucketTs, seenAt));
    const playerName = normalizeText(obs.playerName || target.playerName) || target.playerName;
    const bucketId = playerKey + '|' + coords + '|' + bucketTs;
    const newEntry = {
        t: seenAt,
        planet: normalizeText(obs.planet || '-') || '-',
        moon: normalizeText(obs.moon || '-') || '-',
        debris: normalizeText(obs.debris || 'no') === 'si' ? 'si' : 'no'
    };

    const histPlayer = state.history.players[playerKey];
    if (!histPlayer || seenAt >= histPlayer.lastSeen) {
        state.history.players[playerKey] = {
            playerKey: playerKey,
            playerName: playerName,
            lastSeen: seenAt
        };
    }

    const bucket = state.history.buckets[bucketId] || {
        id: bucketId,
        playerKey: playerKey,
        playerName: playerName,
        coords: coords,
        bucketTs: bucketTs,
        entries: [],
        lastUpdated: seenAt
    };
    bucket.playerName = playerName;
    bucket.coords = coords;
    if (!Array.isArray(bucket.entries) || bucket.entries.length === 0 || seenAt >= safeNumber(bucket.lastUpdated, 0)) {
        bucket.entries = [newEntry];
        bucket.lastUpdated = seenAt;
    }
    state.history.buckets[bucketId] = bucket;

    target.playerName = playerName;
    target.coords = uniqueCoords((target.coords || []).concat([coords]));
    if (!target.primaryCoord && coords) {
        target.primaryCoord = coords;
    }
    target.updatedAt = nowTs();
}

function updateSlaveStatus(payload) {
    const now = nowTs();
    const current = state.runner.slaveStatus || createEmptyState().runner.slaveStatus;
    current.slaveId = normalizeText(payload.slaveId || current.slaveId);
    current.state = normalizeText(payload.state || current.state || 'idle') || 'idle';
    current.currentCoord = normalizeCoord(payload.currentCoord) || '';
    current.progressIndex = Math.max(0, safeNumber(payload.progressIndex, current.progressIndex || 0));
    current.progressTotal = Math.max(0, safeNumber(payload.progressTotal, current.progressTotal || 0));
    current.activeCommandId = normalizeText(payload.activeCommandId || current.activeCommandId);
    current.lastError = normalizeText(payload.lastError || '');
    current.lastSeenAt = now;
    current.updatedAt = now;
    current.online = true;
    state.runner.slaveStatus = current;
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
    }

    const reqUrl = parseRequestUrl(req);
    if (reqUrl.pathname === API_BASE + '/health') {
        sendJson(res, 200, {
            ok: true,
            now: nowTs(),
            port: PORT,
            dataFile: DATA_FILE
        });
        return;
    }

    if (!reqUrl.pathname.startsWith(API_BASE + '/')) {
        sendJson(res, 404, { error: 'not found' });
        return;
    }

    if (!isAuthorized(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
    }

    try {
        if (req.method === 'GET' && reqUrl.pathname === API_BASE + '/state') {
            sendJson(res, 200, buildStatePayload());
            return;
        }

        if (req.method === 'GET' && reqUrl.pathname === API_BASE + '/history/players') {
            sendJson(res, 200, { players: buildHistoryPlayers() });
            return;
        }

        if (req.method === 'GET' && reqUrl.pathname === API_BASE + '/history/meta') {
            const playerKey = reqUrl.searchParams.get('playerKey') || '';
            sendJson(res, 200, buildHistoryMeta(playerKey));
            return;
        }

        if (req.method === 'GET' && reqUrl.pathname === API_BASE + '/history/day') {
            const playerKey = reqUrl.searchParams.get('playerKey') || '';
            const date = reqUrl.searchParams.get('date') || '';
            const payload = buildHistoryDay(playerKey, date);
            if (!payload) {
                sendJson(res, 400, { error: 'date invalida' });
                return;
            }
            sendJson(res, 200, payload);
            return;
        }

        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }

        const rawBody = await readBody(req);
        const body = rawBody ? JSON.parse(rawBody) : {};

        if (reqUrl.pathname === API_BASE + '/targets/upsert') {
            const target = upsertTarget(body || {});
            sendJson(res, 200, { ok: true, target: target, state: buildStatePayload() });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/targets/delete') {
            deleteTarget(body && body.playerKey);
            sendJson(res, 200, { ok: true, state: buildStatePayload() });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/targets/primary') {
            const target = setPrimaryCoord(body && body.playerKey, body && body.coord);
            sendJson(res, 200, { ok: true, target: target, state: buildStatePayload() });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/runner/start') {
            const command = createScanCommand(body && body.playerKey, body && body.mode, body && body.intervalMs);
            sendJson(res, 200, { ok: true, command: command, state: buildStatePayload() });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/runner/stop') {
            const command = createStopCommand();
            sendJson(res, 200, { ok: true, command: command, state: buildStatePayload() });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/slave/poll') {
            updateSlaveStatus(body || {});
            persistState();
            sendJson(res, 200, {
                ok: true,
                command: state.runner.currentCommand,
                targets: state.targets,
                runner: buildRunnerStatus(),
                serverTs: nowTs()
            });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/slave/observe') {
            updateSlaveStatus(body || {});
            const batch = Array.isArray(body && body.batch) ? body.batch : [];
            batch.forEach((item) => mergeObservation(item));
            markUpdated();
            persistState();
            sendJson(res, 200, {
                ok: true,
                accepted: batch.length,
                state: buildStatePayload()
            });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/slave/finish') {
            updateSlaveStatus(body || {});
            const activeCommandId = normalizeText(body && body.activeCommandId);
            const clearCommand = Boolean(body && body.clearCommand);
            if (clearCommand && state.runner.currentCommand && state.runner.currentCommand.commandId === activeCommandId) {
                state.runner.currentCommand = null;
            }
            markUpdated();
            persistState();
            sendJson(res, 200, {
                ok: true,
                runner: buildRunnerStatus()
            });
            return;
        }

        sendJson(res, 404, { error: 'not found' });
    } catch (err) {
        sendJson(res, 400, { error: err && err.message ? err.message : 'bad request' });
    }
});

server.listen(PORT, HOST, () => {
    console.log('[ptre-v2] listening on http://' + HOST + ':' + PORT + API_BASE);
    console.log('[ptre-v2] data file: ' + DATA_FILE);
    if (!SYNC_TOKEN) {
        console.log('[ptre-v2] warning: SYNC_TOKEN is empty');
    }
});
