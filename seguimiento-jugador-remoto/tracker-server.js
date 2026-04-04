#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = positiveNumber(process.env.PORT, 8790);
const API_BASE = normalizeBasePath(process.env.API_BASE || '/tracker');
const SYNC_TOKEN = normalizeText(process.env.SYNC_TOKEN || '');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'tracker-store.json');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BUCKET_MS = 5 * 60 * 1000;
const SLAVE_STALE_MS = 20 * 1000;
const MIN_CYCLE_INTERVAL_MS = 60 * 1000;
const MAX_CYCLE_INTERVAL_MS = 15 * 60 * 1000;
const MIN_HOP_DELAY_MS = 800;
const MAX_HOP_DELAY_MS = 15 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let state = loadState();

function nowTs() {
    return Date.now();
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
    return String(value || '').trim();
}

function positiveNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

function nonNegativeNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function clampNumber(value, min, max, fallback) {
    const num = positiveNumber(value, fallback);
    return Math.max(min, Math.min(max, num));
}

function normalizeBasePath(value) {
    const raw = normalizeText(value || '/tracker');
    if (!raw) {
        return '/tracker';
    }
    const withSlash = raw.startsWith('/') ? raw : ('/' + raw);
    return withSlash.replace(/\/+$/, '') || '/tracker';
}

function randomId(prefix) {
    return prefix + '-' + crypto.randomBytes(6).toString('hex');
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

function normalizeCoords(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    const seen = new Set();
    values.forEach((item) => {
        const coord = normalizeCoord(item);
        if (coord) {
            seen.add(coord);
        }
    });
    return Array.from(seen).sort(compareCoords);
}

function compareCoords(a, b) {
    const pa = String(a || '').split(':').map((part) => Number(part));
    const pb = String(b || '').split(':').map((part) => Number(part));
    for (let index = 0; index < 3; index += 1) {
        const left = Number.isFinite(pa[index]) ? pa[index] : 0;
        const right = Number.isFinite(pb[index]) ? pb[index] : 0;
        if (left !== right) {
            return left - right;
        }
    }
    return 0;
}

function normalizeActivity(value) {
    const raw = normalizeText(value || '-');
    if (raw === '*') {
        return '*';
    }
    if (/^\d+$/.test(raw)) {
        return raw;
    }
    return '-';
}

function normalizeDebris(value) {
    return normalizeText(value).toLowerCase() === 'si' ? 'si' : 'no';
}

function floorToBucket(ts) {
    return Math.floor(positiveNumber(ts, nowTs()) / BUCKET_MS) * BUCKET_MS;
}

function formatIsoDate(ts) {
    return new Date(ts).toISOString().slice(0, 10);
}

function uniqueCoords(values) {
    return normalizeCoords(values);
}

function createEmptySlaveStatus() {
    return {
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
    };
}

function createEmptyState() {
    return {
        version: 1,
        updatedAt: nowTs(),
        targets: {},
        runner: {
            currentPlan: null,
            slaveStatus: createEmptySlaveStatus()
        },
        history: {
            players: {}
        }
    };
}

function normalizeTarget(input, fallbackKey) {
    if (!isPlainObject(input) && !fallbackKey) {
        return null;
    }
    const playerKey = normalizeText((input && input.playerKey) || fallbackKey);
    if (!playerKey) {
        return null;
    }
    const now = nowTs();
    return {
        playerKey: playerKey,
        playerId: positiveNumber(input && input.playerId, 0),
        playerName: normalizeText((input && input.playerName) || playerKey) || playerKey,
        coords: uniqueCoords((input && input.coords) || []),
        addedAt: positiveNumber(input && input.addedAt, now),
        updatedAt: positiveNumber(input && input.updatedAt, now)
    };
}

function normalizeRecord(input, fallbackKey) {
    if (!isPlainObject(input)) {
        return null;
    }
    const recordKey = normalizeText((input && input.recordKey) || fallbackKey);
    const coord = normalizeCoord(input.coord);
    const bucketTs = positiveNumber(input.bucketTs, 0);
    const scannedAt = positiveNumber(input.scannedAt, 0);
    if (!recordKey || !coord || bucketTs <= 0 || scannedAt <= 0) {
        return null;
    }
    return {
        recordKey: recordKey,
        coord: coord,
        bucketTs: bucketTs,
        scannedAt: scannedAt,
        planetActivity: normalizeActivity(input.planetActivity),
        moonActivity: normalizeActivity(input.moonActivity),
        debris: normalizeDebris(input.debris)
    };
}

function normalizeHistoryPlayer(input, fallbackKey) {
    if (!isPlainObject(input) && !fallbackKey) {
        return null;
    }
    const playerKey = normalizeText((input && input.playerKey) || fallbackKey);
    if (!playerKey) {
        return null;
    }
    const player = {
        playerKey: playerKey,
        playerId: positiveNumber(input && input.playerId, 0),
        playerName: normalizeText((input && input.playerName) || playerKey) || playerKey,
        coords: uniqueCoords((input && input.coords) || []),
        firstSeenAt: positiveNumber(input && input.firstSeenAt, 0),
        lastSeenAt: positiveNumber(input && input.lastSeenAt, 0),
        days: {}
    };
    const rawDays = input && input.days;
    if (isPlainObject(rawDays)) {
        Object.keys(rawDays).forEach((dayKey) => {
            if (!DATE_RE.test(dayKey)) {
                return;
            }
            const day = rawDays[dayKey];
            if (!isPlainObject(day)) {
                return;
            }
            const normalizedDay = {
                date: dayKey,
                updatedAt: positiveNumber(day.updatedAt, 0),
                records: {}
            };
            if (isPlainObject(day.records)) {
                Object.keys(day.records).forEach((recordKey) => {
                    const normalized = normalizeRecord(day.records[recordKey], recordKey);
                    if (normalized) {
                        normalizedDay.records[normalized.recordKey] = normalized;
                    }
                });
            }
            player.days[dayKey] = normalizedDay;
        });
    }
    return player;
}

function normalizePlan(input) {
    if (!isPlainObject(input)) {
        return null;
    }
    const planId = normalizeText(input.planId);
    const playerKey = normalizeText(input.playerKey);
    if (!planId || !playerKey) {
        return null;
    }
    const coords = uniqueCoords(input.coords || []);
    const queue = uniqueCoords(input.queue || []);
    return {
        planId: planId,
        playerKey: playerKey,
        playerId: positiveNumber(input.playerId, 0),
        playerName: normalizeText(input.playerName || playerKey) || playerKey,
        coords: coords,
        queue: queue,
        cycleIntervalMs: clampNumber(input.cycleIntervalMs, MIN_CYCLE_INTERVAL_MS, MAX_CYCLE_INTERVAL_MS, MIN_CYCLE_INTERVAL_MS),
        hopDelayMs: clampNumber(input.hopDelayMs, MIN_HOP_DELAY_MS, MAX_HOP_DELAY_MS, 1500),
        issuedAt: positiveNumber(input.issuedAt, nowTs())
    };
}

function normalizeState(input) {
    const normalized = createEmptyState();
    if (!isPlainObject(input)) {
        return normalized;
    }
    normalized.version = positiveNumber(input.version, 1);
    normalized.updatedAt = positiveNumber(input.updatedAt, nowTs());
    if (isPlainObject(input.targets)) {
        Object.keys(input.targets).forEach((playerKey) => {
            const target = normalizeTarget(input.targets[playerKey], playerKey);
            if (target) {
                normalized.targets[target.playerKey] = target;
            }
        });
    }
    if (isPlainObject(input.history) && isPlainObject(input.history.players)) {
        Object.keys(input.history.players).forEach((playerKey) => {
            const player = normalizeHistoryPlayer(input.history.players[playerKey], playerKey);
            if (player) {
                normalized.history.players[player.playerKey] = player;
            }
        });
    }
    if (isPlainObject(input.runner)) {
        normalized.runner.currentPlan = normalizePlan(input.runner.currentPlan);
        if (isPlainObject(input.runner.slaveStatus)) {
            const slaveStatus = createEmptySlaveStatus();
            slaveStatus.slaveId = normalizeText(input.runner.slaveStatus.slaveId);
            slaveStatus.state = normalizeText(input.runner.slaveStatus.state || 'idle') || 'idle';
            slaveStatus.playerKey = normalizeText(input.runner.slaveStatus.playerKey);
            slaveStatus.currentCoord = normalizeCoord(input.runner.slaveStatus.currentCoord);
            slaveStatus.progressIndex = Math.max(0, positiveNumber(input.runner.slaveStatus.progressIndex, 0));
            slaveStatus.progressTotal = Math.max(0, positiveNumber(input.runner.slaveStatus.progressTotal, 0));
            slaveStatus.activePlanId = normalizeText(input.runner.slaveStatus.activePlanId);
            slaveStatus.lastError = normalizeText(input.runner.slaveStatus.lastError);
            slaveStatus.lastSeenAt = positiveNumber(input.runner.slaveStatus.lastSeenAt, 0);
            slaveStatus.updatedAt = positiveNumber(input.runner.slaveStatus.updatedAt, 0);
            normalized.runner.slaveStatus = slaveStatus;
        }
    }
    return normalized;
}

function ensureDirForFile(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
        return normalizeState(JSON.parse(raw));
    } catch (error) {
        console.warn('[tracker] no se pudo cargar el estado, se crea uno nuevo:', error.message);
        return createEmptyState();
    }
}

function persistState() {
    ensureDirForFile(DATA_FILE);
    const tmpFile = DATA_FILE + '.tmp';
    const payload = JSON.stringify(state, null, 2);
    fs.writeFileSync(tmpFile, payload, 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
}

function markUpdated() {
    state.updatedAt = nowTs();
}

function parseUrl(req) {
    return new URL(req.url, 'http://localhost');
}

function isAuthorized(req) {
    if (!SYNC_TOKEN) {
        return true;
    }
    const token = normalizeText(req.headers['x-tracker-token']);
    return token === SYNC_TOKEN;
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,x-tracker-token'
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body demasiado grande'));
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function buildPlayerKey(playerId, playerName) {
    const normalizedName = normalizeText(playerName).toLowerCase();
    if (positiveNumber(playerId, 0) > 0) {
        return 'id:' + String(playerId);
    }
    return 'name:' + (normalizedName || 'unknown');
}

function buildQueueFromCoords(coords) {
    const systems = new Map();
    uniqueCoords(coords).forEach((coord) => {
        const parts = coord.split(':');
        const systemKey = parts[0] + ':' + parts[1];
        if (!systems.has(systemKey)) {
            systems.set(systemKey, coord);
        }
    });
    return Array.from(systems.values()).sort(compareCoords);
}

function buildPlanFromTarget(target, cycleIntervalMs, hopDelayMs) {
    const queue = buildQueueFromCoords(target.coords);
    if (!queue.length) {
        throw new Error('objetivo sin coordenadas');
    }
    return {
        planId: randomId('plan'),
        playerKey: target.playerKey,
        playerId: positiveNumber(target.playerId, 0),
        playerName: normalizeText(target.playerName || target.playerKey) || target.playerKey,
        coords: uniqueCoords(target.coords),
        queue: queue,
        cycleIntervalMs: clampNumber(cycleIntervalMs, MIN_CYCLE_INTERVAL_MS, MAX_CYCLE_INTERVAL_MS, MIN_CYCLE_INTERVAL_MS),
        hopDelayMs: clampNumber(hopDelayMs, MIN_HOP_DELAY_MS, MAX_HOP_DELAY_MS, 1500),
        issuedAt: nowTs()
    };
}

function getTargetOrThrow(playerKeyRaw) {
    const playerKey = normalizeText(playerKeyRaw);
    const target = state.targets[playerKey];
    if (!target) {
        throw new Error('objetivo no encontrado');
    }
    return target;
}

function rebuildPlanIfNeeded(playerKey) {
    const currentPlan = state.runner.currentPlan;
    if (!currentPlan || currentPlan.playerKey !== playerKey) {
        return;
    }
    const target = state.targets[playerKey];
    if (!target || !target.coords.length) {
        state.runner.currentPlan = null;
        return;
    }
    state.runner.currentPlan = buildPlanFromTarget(target, currentPlan.cycleIntervalMs, currentPlan.hopDelayMs);
}

function upsertTarget(payload) {
    const incomingKey = normalizeText(payload.playerKey);
    const playerId = positiveNumber(payload.playerId, 0);
    const playerName = normalizeText(payload.playerName || '');
    const playerKey = incomingKey || buildPlayerKey(playerId, playerName);
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    const now = nowTs();
    const existing = state.targets[playerKey];
    const target = existing ? Object.assign({}, existing) : {
        playerKey: playerKey,
        playerId: playerId,
        playerName: playerName || playerKey,
        coords: [],
        addedAt: now,
        updatedAt: now
    };
    if (playerId > 0) {
        target.playerId = playerId;
    }
    if (playerName) {
        target.playerName = playerName;
    }
    if (payload.coord) {
        target.coords = uniqueCoords((target.coords || []).concat([payload.coord]));
    }
    target.updatedAt = now;
    state.targets[playerKey] = normalizeTarget(target, playerKey);
    rebuildPlanIfNeeded(playerKey);
    markUpdated();
    persistState();
    return state.targets[playerKey];
}

function replaceTargets(payload) {
    const rawTargets = isPlainObject(payload) && isPlainObject(payload.targets)
        ? payload.targets
        : payload;
    if (!isPlainObject(rawTargets)) {
        throw new Error('targets requeridos');
    }

    const previousTargets = state.targets || {};
    const now = nowTs();
    const nextTargets = {};

    Object.keys(rawTargets).forEach((playerKey) => {
        const normalized = normalizeTarget(rawTargets[playerKey], playerKey);
        if (!normalized) {
            return;
        }
        const previous = previousTargets[normalized.playerKey] || null;
        normalized.addedAt = positiveNumber(previous && previous.addedAt, positiveNumber(normalized.addedAt, now));
        normalized.updatedAt = now;
        nextTargets[normalized.playerKey] = normalized;
    });

    state.targets = nextTargets;
    if (state.runner.currentPlan) {
        const currentPlan = state.runner.currentPlan;
        const target = state.targets[currentPlan.playerKey];
        if (!target || !target.coords.length) {
            state.runner.currentPlan = null;
        } else {
            state.runner.currentPlan = buildPlanFromTarget(target, currentPlan.cycleIntervalMs, currentPlan.hopDelayMs);
        }
    }

    markUpdated();
    persistState();
    return state.targets;
}

function deleteTarget(playerKeyRaw) {
    const playerKey = normalizeText(playerKeyRaw);
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    delete state.targets[playerKey];
    if (state.runner.currentPlan && state.runner.currentPlan.playerKey === playerKey) {
        state.runner.currentPlan = null;
    }
    markUpdated();
    persistState();
}

function addTargetCoord(playerKeyRaw, coordRaw) {
    const playerKey = normalizeText(playerKeyRaw);
    const coord = normalizeCoord(coordRaw);
    if (!playerKey || !coord) {
        throw new Error('playerKey y coord requeridos');
    }
    const target = getTargetOrThrow(playerKey);
    target.coords = uniqueCoords((target.coords || []).concat([coord]));
    target.updatedAt = nowTs();
    state.targets[playerKey] = target;
    rebuildPlanIfNeeded(playerKey);
    markUpdated();
    persistState();
    return target;
}

function startRunner(payload) {
    const playerKey = normalizeText(payload.playerKey);
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    const target = getTargetOrThrow(playerKey);
    const plan = buildPlanFromTarget(target, payload.cycleIntervalMs, payload.hopDelayMs);
    state.runner.currentPlan = plan;
    markUpdated();
    persistState();
    return plan;
}

function stopRunner() {
    state.runner.currentPlan = null;
    markUpdated();
    persistState();
}

function updateSlaveStatus(payload) {
    const current = state.runner.slaveStatus || createEmptySlaveStatus();
    current.slaveId = normalizeText(Object.prototype.hasOwnProperty.call(payload || {}, 'slaveId') ? payload.slaveId : current.slaveId);
    current.state = normalizeText(Object.prototype.hasOwnProperty.call(payload || {}, 'state') ? payload.state : (current.state || 'idle')) || 'idle';
    current.playerKey = normalizeText(Object.prototype.hasOwnProperty.call(payload || {}, 'playerKey') ? payload.playerKey : current.playerKey);
    current.currentCoord = Object.prototype.hasOwnProperty.call(payload || {}, 'currentCoord')
        ? (normalizeCoord(payload.currentCoord) || '')
        : current.currentCoord;
    current.progressIndex = Math.max(0, nonNegativeNumber(
        Object.prototype.hasOwnProperty.call(payload || {}, 'progressIndex') ? payload.progressIndex : current.progressIndex,
        current.progressIndex || 0
    ));
    current.progressTotal = Math.max(0, nonNegativeNumber(
        Object.prototype.hasOwnProperty.call(payload || {}, 'progressTotal') ? payload.progressTotal : current.progressTotal,
        current.progressTotal || 0
    ));
    current.activePlanId = normalizeText(Object.prototype.hasOwnProperty.call(payload || {}, 'activePlanId') ? payload.activePlanId : current.activePlanId);
    current.lastError = normalizeText(Object.prototype.hasOwnProperty.call(payload || {}, 'lastError') ? payload.lastError : '');
    current.lastSeenAt = nowTs();
    current.updatedAt = current.lastSeenAt;
    state.runner.slaveStatus = current;
}

function buildRunnerPayload() {
    const status = Object.assign({}, state.runner.slaveStatus || createEmptySlaveStatus());
    status.online = Boolean(status.lastSeenAt) && (nowTs() - status.lastSeenAt) <= SLAVE_STALE_MS;
    return {
        currentPlan: state.runner.currentPlan,
        slaveStatus: status
    };
}

function buildStatePayload() {
    return {
        updatedAt: state.updatedAt,
        targets: state.targets,
        runner: buildRunnerPayload()
    };
}

function getHistoryPlayer(playerKey) {
    const key = normalizeText(playerKey);
    if (!key) {
        return null;
    }
    return state.history.players[key] || null;
}

function saveObservation(rawObservation) {
    if (!isPlainObject(rawObservation)) {
        return;
    }
    const playerKey = normalizeText(rawObservation.playerKey);
    const coord = normalizeCoord(rawObservation.coord);
    const scannedAt = positiveNumber(rawObservation.scannedAt, 0);
    if (!playerKey || !coord || scannedAt <= 0) {
        return;
    }
    const playerId = positiveNumber(rawObservation.playerId, 0);
    const playerName = normalizeText(rawObservation.playerName || playerKey) || playerKey;
    const dayKey = DATE_RE.test(normalizeText(rawObservation.dayKey))
        ? normalizeText(rawObservation.dayKey)
        : formatIsoDate(scannedAt);
    const bucketTs = positiveNumber(rawObservation.bucketTs, floorToBucket(scannedAt));
    const recordKey = coord + '|' + String(bucketTs);

    const historyPlayer = getHistoryPlayer(playerKey) || {
        playerKey: playerKey,
        playerId: playerId,
        playerName: playerName,
        coords: [],
        firstSeenAt: scannedAt,
        lastSeenAt: scannedAt,
        days: {}
    };

    historyPlayer.playerName = playerName;
    if (playerId > 0) {
        historyPlayer.playerId = playerId;
    }
    historyPlayer.coords = uniqueCoords((historyPlayer.coords || []).concat([coord]));
    historyPlayer.firstSeenAt = historyPlayer.firstSeenAt && historyPlayer.firstSeenAt < scannedAt
        ? historyPlayer.firstSeenAt
        : scannedAt;
    historyPlayer.lastSeenAt = Math.max(positiveNumber(historyPlayer.lastSeenAt, 0), scannedAt);

    const day = historyPlayer.days[dayKey] || {
        date: dayKey,
        updatedAt: scannedAt,
        records: {}
    };

    const nextRecord = {
        recordKey: recordKey,
        coord: coord,
        bucketTs: bucketTs,
        scannedAt: scannedAt,
        planetActivity: normalizeActivity(rawObservation.planetActivity),
        moonActivity: normalizeActivity(rawObservation.moonActivity),
        debris: normalizeDebris(rawObservation.debris)
    };

    const existingRecord = day.records[recordKey];
    if (!existingRecord || nextRecord.scannedAt >= positiveNumber(existingRecord.scannedAt, 0)) {
        day.records[recordKey] = nextRecord;
        day.updatedAt = Math.max(positiveNumber(day.updatedAt, 0), nextRecord.scannedAt);
    }

    historyPlayer.days[dayKey] = day;
    state.history.players[playerKey] = historyPlayer;
}

function buildHistoryPlayers() {
    const keys = new Set([
        ...Object.keys(state.targets || {}),
        ...Object.keys(state.history.players || {})
    ]);
    const list = Array.from(keys).map((playerKey) => {
        const target = state.targets[playerKey] || null;
        const historyPlayer = state.history.players[playerKey] || null;
        return {
            playerKey: playerKey,
            playerId: positiveNumber((target && target.playerId) || (historyPlayer && historyPlayer.playerId), 0),
            playerName: normalizeText((target && target.playerName) || (historyPlayer && historyPlayer.playerName) || playerKey) || playerKey,
            hasTarget: Boolean(target),
            hasHistory: Boolean(historyPlayer),
            coordCount: uniqueCoords([
                ...((target && target.coords) || []),
                ...((historyPlayer && historyPlayer.coords) || [])
            ]).length,
            lastSeenAt: positiveNumber(historyPlayer && historyPlayer.lastSeenAt, 0)
        };
    });
    list.sort((left, right) => left.playerName.localeCompare(right.playerName, 'es', { sensitivity: 'base' }));
    return list;
}

function buildHistoryMeta(playerKeyRaw) {
    const playerKey = normalizeText(playerKeyRaw);
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    const target = state.targets[playerKey] || null;
    const historyPlayer = state.history.players[playerKey] || null;
    const coords = uniqueCoords([
        ...((target && target.coords) || []),
        ...((historyPlayer && historyPlayer.coords) || [])
    ]);
    const dates = historyPlayer ? Object.keys(historyPlayer.days || {}).sort() : [];
    return {
        player: {
            playerKey: playerKey,
            playerId: positiveNumber((target && target.playerId) || (historyPlayer && historyPlayer.playerId), 0),
            playerName: normalizeText((target && target.playerName) || (historyPlayer && historyPlayer.playerName) || playerKey) || playerKey
        },
        coords: coords,
        dates: dates,
        hasTarget: Boolean(target),
        hasHistory: Boolean(historyPlayer)
    };
}

function buildHistoryDay(playerKeyRaw, dateRaw) {
    const playerKey = normalizeText(playerKeyRaw);
    const dateValue = normalizeText(dateRaw);
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    if (!DATE_RE.test(dateValue)) {
        throw new Error('date invalida');
    }
    const meta = buildHistoryMeta(playerKey);
    const historyPlayer = state.history.players[playerKey] || null;
    const day = historyPlayer && historyPlayer.days ? historyPlayer.days[dateValue] : null;
    const records = day && isPlainObject(day.records)
        ? Object.keys(day.records).map((recordKey) => day.records[recordKey]).filter(Boolean)
        : [];
    records.sort((left, right) => {
        const coordCompare = compareCoords(left.coord, right.coord);
        if (coordCompare !== 0) {
            return coordCompare;
        }
        return left.bucketTs - right.bucketTs;
    });
    return {
        player: meta.player,
        date: dateValue,
        coords: meta.coords,
        bucketMs: BUCKET_MS,
        records: records
    };
}

function deletePlayerHistory(playerKeyRaw) {
    const playerKey = normalizeText(playerKeyRaw);
    if (!playerKey) {
        throw new Error('playerKey requerido');
    }
    delete state.history.players[playerKey];
    markUpdated();
    persistState();
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
    }

    const reqUrl = parseUrl(req);
    if (reqUrl.pathname === API_BASE + '/health') {
        sendJson(res, 200, {
            ok: true,
            now: nowTs(),
            apiBase: API_BASE,
            dataFile: DATA_FILE,
            tokenEnabled: Boolean(SYNC_TOKEN)
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
            sendJson(res, 200, buildHistoryMeta(reqUrl.searchParams.get('playerKey') || ''));
            return;
        }

        if (req.method === 'GET' && reqUrl.pathname === API_BASE + '/history/day') {
            sendJson(res, 200, buildHistoryDay(
                reqUrl.searchParams.get('playerKey') || '',
                reqUrl.searchParams.get('date') || ''
            ));
            return;
        }

        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }

        const rawBody = await readBody(req);
        const body = rawBody ? JSON.parse(rawBody) : {};

        if (reqUrl.pathname === API_BASE + '/targets/replace') {
            replaceTargets(body || {});
            sendJson(res, 200, { ok: true, state: buildStatePayload() });
            return;
        }

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

        if (reqUrl.pathname === API_BASE + '/targets/coords/add') {
            const target = addTargetCoord(body && body.playerKey, body && body.coord);
            sendJson(res, 200, { ok: true, target: target, state: buildStatePayload() });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/runner/start') {
            const plan = startRunner(body || {});
            sendJson(res, 200, { ok: true, plan: plan, state: buildStatePayload() });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/runner/stop') {
            stopRunner();
            sendJson(res, 200, { ok: true, state: buildStatePayload() });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/slave/poll') {
            updateSlaveStatus(body || {});
            markUpdated();
            persistState();
            sendJson(res, 200, {
                ok: true,
                plan: state.runner.currentPlan,
                runner: buildRunnerPayload(),
                targets: state.targets,
                serverTs: nowTs()
            });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/slave/report') {
            updateSlaveStatus(body || {});
            const observations = Array.isArray(body && body.observations) ? body.observations : [];
            observations.forEach(saveObservation);
            markUpdated();
            persistState();
            sendJson(res, 200, {
                ok: true,
                accepted: observations.length,
                runner: buildRunnerPayload()
            });
            return;
        }

        if (reqUrl.pathname === API_BASE + '/history/delete-player') {
            deletePlayerHistory(body && body.playerKey);
            sendJson(res, 200, {
                ok: true,
                players: buildHistoryPlayers()
            });
            return;
        }

        sendJson(res, 404, { error: 'not found' });
    } catch (error) {
        sendJson(res, 400, { error: error && error.message ? error.message : 'bad request' });
    }
});

server.listen(PORT, HOST, () => {
    console.log('[tracker] listening on http://' + HOST + ':' + PORT + API_BASE);
    console.log('[tracker] data file:', DATA_FILE);
    console.log('[tracker] token:', SYNC_TOKEN ? 'enabled' : 'disabled');
});
