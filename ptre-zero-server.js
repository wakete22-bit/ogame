#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8790);
const API_BASE = '/zero';
const TOKEN = String(process.env.SYNC_TOKEN || '').trim();
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'ptre-zero-state.json');
const MAX_BODY_BYTES = 1024 * 1024;
const BUCKET_MS = 5 * 60 * 1000;
const SLAVE_ONLINE_MS = 20 * 1000;

function safeNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function text(value) {
    return String(value || '').trim();
}

function coord(value) {
    const raw = text(value);
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

function coordSystem(value) {
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

function uniqueCoords(input) {
    const set = new Set();
    if (Array.isArray(input)) {
        input.forEach((item) => {
            const normalized = coord(item);
            if (normalized) {
                set.add(normalized);
            }
        });
    }
    return Array.from(set).sort(compareCoords);
}

function now() {
    return Date.now();
}

function floorBucket(ts) {
    return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

function dateKey(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
}

function emptyState() {
    return {
        updatedAt: 0,
        targets: {},
        command: null,
        slave: {
            slaveId: '',
            online: false,
            state: 'idle',
            currentSystem: '',
            progressIndex: 0,
            progressTotal: 0,
            activeCommandId: '',
            lastError: '',
            lastSeenAt: 0,
            updatedAt: 0
        },
        history: {
            players: {},
            buckets: {}
        }
    };
}

function normalizeTarget(input, fallbackKey) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const playerKey = text(input.playerKey || fallbackKey);
    if (!playerKey) {
        return null;
    }
    const playerName = text(input.playerName || playerKey) || playerKey;
    const coords = uniqueCoords(input.coords);
    const primaryCoord = coord(input.primaryCoord);
    return {
        playerKey: playerKey,
        playerName: playerName,
        coords: coords,
        primaryCoord: primaryCoord && coords.includes(primaryCoord) ? primaryCoord : (coords[0] || ''),
        createdAt: safeNumber(input.createdAt, now()),
        updatedAt: safeNumber(input.updatedAt, now())
    };
}

function normalizeTargetsMap(input) {
    const out = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return out;
    }
    Object.keys(input).forEach((key) => {
        const target = normalizeTarget(input[key], key);
        if (target) {
            out[target.playerKey] = target;
        }
    });
    return out;
}

function normalizeCommand(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const commandId = text(input.commandId);
    const type = text(input.type).toLowerCase();
    if (!commandId || !type) {
        return null;
    }
    if (type === 'stop') {
        return {
            commandId: commandId,
            type: 'stop',
            issuedAt: safeNumber(input.issuedAt, now()),
            issuedBy: text(input.issuedBy || 'master') || 'master'
        };
    }
    if (type !== 'scan') {
        return null;
    }
    return {
        commandId: commandId,
        type: 'scan',
        playerKey: text(input.playerKey),
        mode: text(input.mode).toLowerCase() === 'continuous' ? 'continuous' : 'once',
        queue: uniqueCoords(input.queue),
        intervalMs: Math.max(10000, safeNumber(input.intervalMs, 60000)),
        issuedAt: safeNumber(input.issuedAt, now()),
        issuedBy: text(input.issuedBy || 'master') || 'master'
    };
}

function normalizeSlave(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return emptyState().slave;
    }
    return {
        slaveId: text(input.slaveId),
        online: Boolean(input.online),
        state: text(input.state || 'idle') || 'idle',
        currentSystem: coordSystem(input.currentSystem) || '',
        progressIndex: Math.max(0, safeNumber(input.progressIndex, 0)),
        progressTotal: Math.max(0, safeNumber(input.progressTotal, 0)),
        activeCommandId: text(input.activeCommandId),
        lastError: text(input.lastError),
        lastSeenAt: Math.max(0, safeNumber(input.lastSeenAt, 0)),
        updatedAt: Math.max(0, safeNumber(input.updatedAt, 0))
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
            const rec = rawPlayers[key];
            if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
                return;
            }
            const playerKey = text(rec.playerKey || key);
            if (!playerKey) {
                return;
            }
            history.players[playerKey] = {
                playerKey: playerKey,
                playerName: text(rec.playerName || playerKey) || playerKey,
                lastSeen: safeNumber(rec.lastSeen, 0)
            };
        });
    }
    const rawBuckets = input.buckets;
    if (rawBuckets && typeof rawBuckets === 'object' && !Array.isArray(rawBuckets)) {
        Object.keys(rawBuckets).forEach((key) => {
            const rec = rawBuckets[key];
            if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
                return;
            }
            const playerKey = text(rec.playerKey);
            const coords = coord(rec.coords);
            const bucketTs = safeNumber(rec.bucketTs, 0);
            if (!playerKey || !coords || bucketTs <= 0) {
                return;
            }
            const entries = [];
            if (Array.isArray(rec.entries)) {
                rec.entries.forEach((entry) => {
                    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                        return;
                    }
                    const t = safeNumber(entry.t, 0);
                    if (t <= 0) {
                        return;
                    }
                    entries.push({
                        t: t,
                        planet: text(entry.planet || '-') || '-',
                        moon: text(entry.moon || '-') || '-',
                        debris: text(entry.debris || 'no') === 'si' ? 'si' : 'no'
                    });
                });
            }
            const bucketId = text(rec.id || key || (playerKey + '|' + coords + '|' + bucketTs));
            if (!bucketId) {
                return;
            }
            history.buckets[bucketId] = {
                id: bucketId,
                playerKey: playerKey,
                playerName: text(rec.playerName || playerKey) || playerKey,
                coords: coords,
                bucketTs: bucketTs,
                entries: entries,
                lastUpdated: safeNumber(rec.lastUpdated, entries.length ? entries[entries.length - 1].t : bucketTs)
            };
        });
    }
    return history;
}

function loadState() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return emptyState();
        }
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        if (!raw.trim()) {
            return emptyState();
        }
        const parsed = JSON.parse(raw);
        return {
            updatedAt: safeNumber(parsed.updatedAt, 0),
            targets: normalizeTargetsMap(parsed.targets),
            command: normalizeCommand(parsed.command),
            slave: normalizeSlave(parsed.slave),
            history: normalizeHistory(parsed.history)
        };
    } catch (err) {
        console.warn('[ptre-zero] failed to load state:', err.message);
        return emptyState();
    }
}

let state = loadState();

function persistState() {
    const temp = DATA_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temp, DATA_FILE);
}

function touchState() {
    state.updatedAt = now();
}

function requestUrl(req) {
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

function authorized(req) {
    if (!TOKEN) {
        return true;
    }
    return req.headers['x-ptre-token'] === TOKEN;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let body = '';
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
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

function publicSlaveState() {
    const slave = Object.assign({}, state.slave);
    slave.online = Boolean(slave.lastSeenAt > 0 && (now() - slave.lastSeenAt) <= SLAVE_ONLINE_MS);
    return slave;
}

function statePayload() {
    return {
        updatedAt: state.updatedAt,
        targets: state.targets,
        command: state.command,
        slave: publicSlaveState()
    };
}

function historyPlayers() {
    return Object.keys(state.targets).map((playerKey) => {
        const target = state.targets[playerKey];
        const hist = state.history.players[playerKey] || null;
        return {
            playerKey: playerKey,
            playerName: hist && hist.playerName ? hist.playerName : target.playerName,
            lastSeen: hist ? hist.lastSeen : 0,
            coords: uniqueCoords(target.coords || []),
            primaryCoord: target.primaryCoord || ''
        };
    }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

function historyDatesForPlayer(playerKeyRaw) {
    const playerKey = text(playerKeyRaw);
    const dates = new Set();
    Object.keys(state.history.buckets).forEach((bucketId) => {
        const rec = state.history.buckets[bucketId];
        if (!rec || rec.playerKey !== playerKey) {
            return;
        }
        dates.add(dateKey(rec.bucketTs));
    });
    return Array.from(dates).sort();
}

function historyDay(playerKeyRaw, dateRaw) {
    const playerKey = text(playerKeyRaw);
    const date = text(dateRaw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error('date invalida');
    }
    const target = state.targets[playerKey];
    const player = state.history.players[playerKey];
    const buckets = Object.keys(state.history.buckets)
        .map((bucketId) => state.history.buckets[bucketId])
        .filter((rec) => rec && rec.playerKey === playerKey && dateKey(rec.bucketTs) === date)
        .sort((a, b) => (a.bucketTs || 0) - (b.bucketTs || 0));
    return {
        player: {
            playerKey: playerKey,
            playerName: player && player.playerName ? player.playerName : (target ? target.playerName : playerKey),
            primaryCoord: target && target.primaryCoord ? target.primaryCoord : ''
        },
        date: date,
        bucketMs: BUCKET_MS,
        buckets: buckets
    };
}

function mergeCoords(existing, extra) {
    return uniqueCoords((existing || []).concat(extra || []));
}

function buildQueue(target) {
    if (!target) {
        return [];
    }
    const ordered = target.primaryCoord
        ? [target.primaryCoord].concat((target.coords || []).filter((value) => value !== target.primaryCoord))
        : (target.coords || []).slice();
    const seenSystems = new Set();
    const queue = [];
    ordered.forEach((value) => {
        const system = coordSystem(value);
        if (!system || seenSystems.has(system)) {
            return;
        }
        seenSystems.add(system);
        queue.push(coord(value));
    });
    return queue;
}

function upsertTarget(body) {
    const playerKey = text(body.playerKey);
    const playerName = text(body.playerName || playerKey) || playerKey;
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    const currentCoord = coord(body.coord);
    const requestedPrimary = coord(body.primaryCoord);
    const existing = state.targets[playerKey];
    const createdAt = existing ? existing.createdAt : now();
    const coords = mergeCoords(existing ? existing.coords : [], currentCoord ? [currentCoord] : []);
    const primaryCoord = requestedPrimary && coords.includes(requestedPrimary)
        ? requestedPrimary
        : (existing && existing.primaryCoord && coords.includes(existing.primaryCoord)
            ? existing.primaryCoord
            : (currentCoord || (coords[0] || '')));
    state.targets[playerKey] = {
        playerKey: playerKey,
        playerName: playerName,
        coords: coords,
        primaryCoord: primaryCoord,
        createdAt: createdAt,
        updatedAt: now()
    };
    touchState();
    persistState();
    return state.targets[playerKey];
}

function deleteTarget(playerKeyRaw) {
    const playerKey = text(playerKeyRaw);
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    delete state.targets[playerKey];
    if (state.command && state.command.playerKey === playerKey) {
        state.command = null;
    }
    touchState();
    persistState();
}

function setPrimary(body) {
    const playerKey = text(body.playerKey);
    const primaryCoord = coord(body.coord);
    if (!playerKey || !primaryCoord) {
        throw new Error('playerKey y coord requeridos');
    }
    const target = state.targets[playerKey];
    if (!target) {
        throw new Error('objetivo no encontrado');
    }
    target.coords = mergeCoords(target.coords, [primaryCoord]);
    target.primaryCoord = primaryCoord;
    target.updatedAt = now();
    touchState();
    persistState();
    return target;
}

function startCommand(body) {
    const playerKey = text(body.playerKey);
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    const target = state.targets[playerKey];
    if (!target) {
        throw new Error('objetivo no encontrado');
    }
    const queue = buildQueue(target);
    if (!queue.length) {
        throw new Error('objetivo sin coordenadas');
    }
    state.command = {
        commandId: 'cmd-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        type: 'scan',
        playerKey: playerKey,
        mode: text(body.mode).toLowerCase() === 'continuous' ? 'continuous' : 'once',
        queue: queue,
        intervalMs: Math.max(10000, safeNumber(body.intervalMs, 60000)),
        issuedAt: now(),
        issuedBy: 'master'
    };
    touchState();
    persistState();
    return state.command;
}

function stopCommand() {
    state.command = {
        commandId: 'cmd-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        type: 'stop',
        issuedAt: now(),
        issuedBy: 'master'
    };
    touchState();
    persistState();
    return state.command;
}

function updateSlaveStatus(body) {
    state.slave.slaveId = text(body.slaveId || state.slave.slaveId);
    state.slave.state = text(body.state || state.slave.state || 'idle') || 'idle';
    state.slave.currentSystem = coordSystem(body.currentSystem) || '';
    state.slave.progressIndex = Math.max(0, safeNumber(body.progressIndex, state.slave.progressIndex || 0));
    state.slave.progressTotal = Math.max(0, safeNumber(body.progressTotal, state.slave.progressTotal || 0));
    state.slave.activeCommandId = text(body.activeCommandId || state.slave.activeCommandId);
    state.slave.lastError = text(body.lastError || '');
    state.slave.lastSeenAt = now();
    state.slave.updatedAt = now();
    state.slave.online = true;
}

function mergeObservation(obs) {
    const playerKey = text(obs.playerKey);
    if (!playerKey || !state.targets[playerKey]) {
        return;
    }
    const coords = coord(obs.coords);
    const seenAt = safeNumber(obs.seenAt, 0);
    if (!coords || seenAt <= 0) {
        return;
    }
    const bucketTs = floorBucket(safeNumber(obs.bucketTs, seenAt));
    const playerName = text(obs.playerName || state.targets[playerKey].playerName) || state.targets[playerKey].playerName;
    const bucketId = playerKey + '|' + coords + '|' + bucketTs;
    const entry = {
        t: seenAt,
        planet: text(obs.planet || '-') || '-',
        moon: text(obs.moon || '-') || '-',
        debris: text(obs.debris || 'no') === 'si' ? 'si' : 'no'
    };
    const current = state.history.buckets[bucketId] || {
        id: bucketId,
        playerKey: playerKey,
        playerName: playerName,
        coords: coords,
        bucketTs: bucketTs,
        entries: [],
        lastUpdated: 0
    };
    current.playerName = playerName;
    current.coords = coords;
    if (!Array.isArray(current.entries) || current.entries.length === 0 || seenAt >= current.lastUpdated) {
        current.entries = [entry];
        current.lastUpdated = seenAt;
    }
    state.history.buckets[bucketId] = current;
    const histPlayer = state.history.players[playerKey];
    if (!histPlayer || seenAt >= histPlayer.lastSeen) {
        state.history.players[playerKey] = {
            playerKey: playerKey,
            playerName: playerName,
            lastSeen: seenAt
        };
    }
    state.targets[playerKey].playerName = playerName;
    state.targets[playerKey].coords = mergeCoords(state.targets[playerKey].coords, [coords]);
    if (!state.targets[playerKey].primaryCoord) {
        state.targets[playerKey].primaryCoord = coords;
    }
    state.targets[playerKey].updatedAt = now();
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
    }

    const url = requestUrl(req);
    if (url.pathname === API_BASE + '/health') {
        sendJson(res, 200, {
            ok: true,
            base: API_BASE,
            port: PORT,
            dataFile: DATA_FILE,
            now: now()
        });
        return;
    }

    if (!url.pathname.startsWith(API_BASE + '/')) {
        sendJson(res, 404, { error: 'not found' });
        return;
    }

    if (!authorized(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
    }

    try {
        if (req.method === 'GET' && url.pathname === API_BASE + '/state') {
            sendJson(res, 200, statePayload());
            return;
        }

        if (req.method === 'GET' && url.pathname === API_BASE + '/history/players') {
            sendJson(res, 200, { players: historyPlayers() });
            return;
        }

        if (req.method === 'GET' && url.pathname === API_BASE + '/history/dates') {
            sendJson(res, 200, { dates: historyDatesForPlayer(url.searchParams.get('playerKey') || '') });
            return;
        }

        if (req.method === 'GET' && url.pathname === API_BASE + '/history/day') {
            sendJson(res, 200, historyDay(url.searchParams.get('playerKey') || '', url.searchParams.get('date') || ''));
            return;
        }

        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }

        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};

        if (url.pathname === API_BASE + '/master/target/upsert') {
            sendJson(res, 200, { ok: true, target: upsertTarget(body), state: statePayload() });
            return;
        }

        if (url.pathname === API_BASE + '/master/target/delete') {
            deleteTarget(body.playerKey);
            sendJson(res, 200, { ok: true, state: statePayload() });
            return;
        }

        if (url.pathname === API_BASE + '/master/target/primary') {
            sendJson(res, 200, { ok: true, target: setPrimary(body), state: statePayload() });
            return;
        }

        if (url.pathname === API_BASE + '/master/command/start') {
            sendJson(res, 200, { ok: true, command: startCommand(body), state: statePayload() });
            return;
        }

        if (url.pathname === API_BASE + '/master/command/stop') {
            sendJson(res, 200, { ok: true, command: stopCommand(), state: statePayload() });
            return;
        }

        if (url.pathname === API_BASE + '/slave/poll') {
            updateSlaveStatus(body || {});
            touchState();
            persistState();
            sendJson(res, 200, {
                ok: true,
                command: state.command,
                targets: state.targets,
                slave: publicSlaveState(),
                serverTs: now()
            });
            return;
        }

        if (url.pathname === API_BASE + '/slave/report') {
            updateSlaveStatus(body || {});
            const batch = Array.isArray(body.batch) ? body.batch : [];
            batch.forEach(mergeObservation);
            if (body.complete && state.command && text(body.activeCommandId) === state.command.commandId) {
                if (state.command.type === 'scan' && state.command.mode === 'once') {
                    state.command = null;
                }
                if (state.command && state.command.type === 'stop') {
                    state.command = null;
                }
            }
            if (body.ackStop && state.command && state.command.type === 'stop' && text(body.activeCommandId) === state.command.commandId) {
                state.command = null;
            }
            touchState();
            persistState();
            sendJson(res, 200, { ok: true, state: statePayload() });
            return;
        }

        sendJson(res, 404, { error: 'not found' });
    } catch (err) {
        sendJson(res, 400, { error: err && err.message ? err.message : 'bad request' });
    }
});

server.listen(PORT, HOST, () => {
    console.log('[ptre-zero] listening on http://' + HOST + ':' + PORT + API_BASE);
    console.log('[ptre-zero] data file: ' + DATA_FILE);
    if (!TOKEN) {
        console.log('[ptre-zero] warning: empty SYNC_TOKEN');
    }
});
