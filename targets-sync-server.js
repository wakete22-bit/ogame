#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'targets-store.json');
const MAX_BODY_BYTES = 1024 * 1024;
const EDIT_LOCK_DEFAULT_TTL_MS = 2 * 60 * 1000;
const EDIT_LOCK_MIN_TTL_MS = 30 * 1000;
const EDIT_LOCK_MAX_TTL_MS = 15 * 60 * 1000;

function safeNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function normalizeTargets(input) {
    const normalized = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return normalized;
    }
    Object.keys(input).forEach((key) => {
        if (!key) {
            return;
        }
        const value = input[key];
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

function normalizeCoordList(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    const set = new Set();
    input.forEach((item) => {
        const coord = normalizeCoord(item);
        if (coord) {
            set.add(coord);
        }
    });
    return Array.from(set);
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

function sortCoordList(input) {
    return normalizeCoordList(input).sort(compareCoords);
}

function normalizeControl(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const action = String(input.action || '').toLowerCase();
    if (action !== 'start' && action !== 'stop') {
        return null;
    }
    const cmdId = String(input.cmdId || '').trim();
    if (!cmdId) {
        return null;
    }
    return {
        cmdId: cmdId,
        action: action,
        issuedAt: safeNumber(input.issuedAt, Date.now()),
        continuous: Boolean(input.continuous),
        queue: normalizeCoordList(input.queue),
        scanDelayMs: safeNumber(input.scanDelayMs, 1000),
        continuousIntervalMs: safeNumber(input.continuousIntervalMs, 60000)
    };
}

function clampLockTtl(value) {
    const ttl = safeNumber(value, EDIT_LOCK_DEFAULT_TTL_MS);
    return Math.min(EDIT_LOCK_MAX_TTL_MS, Math.max(EDIT_LOCK_MIN_TTL_MS, ttl));
}

function normalizeEditLockCommand(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const action = String(input.action || '').toLowerCase();
    if (action !== 'acquire' && action !== 'release' && action !== 'heartbeat') {
        return null;
    }
    const ownerId = String(input.ownerId || '').trim();
    if (!ownerId) {
        return null;
    }
    const token = String(input.token || '').trim();
    if (!token) {
        return null;
    }
    const ownerLabelRaw = String(input.ownerLabel || '').trim();
    const ownerLabel = ownerLabelRaw || ownerId;
    return {
        action: action,
        ownerId: ownerId,
        ownerLabel: ownerLabel,
        token: token,
        ttlMs: clampLockTtl(input.ttlMs),
        force: Boolean(input.force),
        now: safeNumber(input.now, Date.now())
    };
}

function normalizeEditLock(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const ownerId = String(input.ownerId || '').trim();
    const token = String(input.token || '').trim();
    const expiresAt = safeNumber(input.expiresAt, 0);
    if (!ownerId || !token || expiresAt <= 0) {
        return null;
    }
    const ownerLabelRaw = String(input.ownerLabel || '').trim();
    return {
        ownerId: ownerId,
        ownerLabel: ownerLabelRaw || ownerId,
        token: token,
        expiresAt: expiresAt,
        updatedAt: safeNumber(input.updatedAt, 0)
    };
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

function normalizeActivityObservation(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const playerKey = String(input.playerKey || '').trim();
    const coords = normalizeCoord(input.coords);
    const seenAt = safeNumber(input.seenAt, 0);
    const bucketTs = safeNumber(input.bucketTs, 0);
    if (!playerKey || !coords || seenAt <= 0 || bucketTs <= 0) {
        return null;
    }
    const playerName = String(input.playerName || '').trim() || playerKey;
    return {
        playerKey: playerKey,
        playerName: playerName,
        coords: coords,
        seenAt: seenAt,
        bucketTs: bucketTs,
        planet: normalizeActivityValue(input.planet),
        moon: normalizeActivityValue(input.moon),
        debris: normalizeDebrisValue(input.debris)
    };
}

function normalizeActivityBatch(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    const list = [];
    input.forEach((item) => {
        const obs = normalizeActivityObservation(item);
        if (obs) {
            list.push(obs);
        }
    });
    return list;
}

function normalizeSharedCoordObservation(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }
    const playerKey = String(input.playerKey || '').trim();
    const coords = normalizeCoord(input.coords);
    const seenAt = safeNumber(input.seenAt, 0);
    if (!playerKey || !coords || seenAt <= 0) {
        return null;
    }
    return {
        playerKey: playerKey,
        playerName: String(input.playerName || playerKey).trim() || playerKey,
        coords: coords,
        seenAt: seenAt
    };
}

function normalizeSharedCoordsBatch(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    const list = [];
    input.forEach((item) => {
        const obs = normalizeSharedCoordObservation(item);
        if (obs) {
            list.push(obs);
        }
    });
    return list;
}

function normalizeSharedCoordsState(input) {
    const normalized = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return normalized;
    }
    Object.keys(input).forEach((playerKeyRaw) => {
        const rec = input[playerKeyRaw];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
            return;
        }
        const playerKey = String(rec.playerKey || playerKeyRaw || '').trim();
        if (!playerKey) {
            return;
        }
        const coords = sortCoordList(rec.coords);
        if (!coords.length) {
            return;
        }
        normalized[playerKey] = {
            playerKey: playerKey,
            playerName: String(rec.playerName || playerKey).trim() || playerKey,
            lastSeen: safeNumber(rec.lastSeen, 0),
            coords: coords
        };
    });
    return normalized;
}

function mergeSharedCoordsBatch(sharedCoords, batch) {
    const merged = normalizeSharedCoordsState(sharedCoords);
    batch.forEach((obs) => {
        const existing = merged[obs.playerKey] || {
            playerKey: obs.playerKey,
            playerName: obs.playerName || obs.playerKey,
            lastSeen: 0,
            coords: []
        };
        existing.playerName = obs.playerName || existing.playerName || existing.playerKey;
        existing.lastSeen = Math.max(safeNumber(existing.lastSeen, 0), obs.seenAt);
        existing.coords = sortCoordList((existing.coords || []).concat([obs.coords]));
        merged[obs.playerKey] = existing;
    });
    return merged;
}

function normalizeActivityState(input) {
    const normalized = { players: {}, buckets: {} };
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return normalized;
    }

    const rawPlayers = input.players;
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
            normalized.players[playerKey] = {
                playerKey: playerKey,
                playerName: String(rec.playerName || playerKey).trim() || playerKey,
                lastSeen: safeNumber(rec.lastSeen, 0)
            };
        });
    }

    const rawBuckets = input.buckets;
    if (rawBuckets && typeof rawBuckets === 'object' && !Array.isArray(rawBuckets)) {
        Object.keys(rawBuckets).forEach((idKey) => {
            const rec = rawBuckets[idKey];
            if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
                return;
            }
            const playerKey = String(rec.playerKey || '').trim();
            const bucketTs = safeNumber(rec.bucketTs, 0);
            if (!playerKey || bucketTs <= 0) {
                return;
            }
            const coords = normalizeCoord(rec.coords) || 'unknown';
            const id = String(rec.id || idKey || (playerKey + '|' + coords + '|' + bucketTs)).trim();
            if (!id) {
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
                        planet: normalizeActivityValue(entry.planet),
                        moon: normalizeActivityValue(entry.moon),
                        debris: normalizeDebrisValue(entry.debris)
                    });
                });
            }
            let lastUpdated = safeNumber(rec.lastUpdated, 0);
            if (lastUpdated <= 0 && entries.length) {
                lastUpdated = entries[entries.length - 1].t;
            }
            if (lastUpdated <= 0) {
                lastUpdated = bucketTs;
            }
            const playerName = String(rec.playerName || playerKey).trim() || playerKey;
            normalized.buckets[id] = {
                id: id,
                playerKey: playerKey,
                playerName: playerName,
                coords: coords,
                bucketTs: bucketTs,
                entries: entries,
                lastUpdated: lastUpdated
            };
            const existing = normalized.players[playerKey];
            if (!existing || lastUpdated >= existing.lastSeen) {
                normalized.players[playerKey] = {
                    playerKey: playerKey,
                    playerName: playerName,
                    lastSeen: lastUpdated
                };
            }
        });
    }

    return normalized;
}

function mergeActivityBatch(activity, batch) {
    const merged = normalizeActivityState(activity);
    batch.forEach((obs) => {
        const player = merged.players[obs.playerKey];
        if (!player || obs.seenAt >= player.lastSeen) {
            merged.players[obs.playerKey] = {
                playerKey: obs.playerKey,
                playerName: obs.playerName || obs.playerKey,
                lastSeen: obs.seenAt
            };
        }

        const bucketId = obs.playerKey + '|' + obs.coords + '|' + obs.bucketTs;
        const newEntry = {
            t: obs.seenAt,
            planet: obs.planet,
            moon: obs.moon,
            debris: obs.debris
        };
        const rec = merged.buckets[bucketId] || {
            id: bucketId,
            playerKey: obs.playerKey,
            playerName: obs.playerName || obs.playerKey,
            coords: obs.coords,
            bucketTs: obs.bucketTs,
            entries: [],
            lastUpdated: obs.seenAt
        };

        rec.playerName = obs.playerName || rec.playerName;
        rec.coords = obs.coords || rec.coords;
        if (!Array.isArray(rec.entries) || rec.entries.length === 0 || obs.seenAt >= safeNumber(rec.lastUpdated, 0)) {
            rec.entries = [newEntry];
            rec.lastUpdated = obs.seenAt;
        }
        merged.buckets[bucketId] = rec;
    });
    return merged;
}

function buildSharedCoordsFromActivity(activity) {
    const shared = {};
    if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
        return shared;
    }
    const rawBuckets = activity.buckets;
    if (!rawBuckets || typeof rawBuckets !== 'object' || Array.isArray(rawBuckets)) {
        return shared;
    }
    Object.keys(rawBuckets).forEach((idKey) => {
        const rec = rawBuckets[idKey];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
            return;
        }
        const playerKey = String(rec.playerKey || '').trim();
        const coord = normalizeCoord(rec.coords);
        if (!playerKey || !coord) {
            return;
        }
        if (!shared[playerKey]) {
            shared[playerKey] = [];
        }
        shared[playerKey].push(coord);
    });
    Object.keys(shared).forEach((playerKey) => {
        shared[playerKey] = sortCoordList(shared[playerKey]);
        if (!shared[playerKey].length) {
            delete shared[playerKey];
        }
    });
    return shared;
}

function buildPublicSharedCoords() {
    const shared = {};
    const fromState = normalizeSharedCoordsState(state.sharedCoords);
    Object.keys(fromState).forEach((playerKey) => {
        shared[playerKey] = sortCoordList(fromState[playerKey].coords);
    });
    const fromActivity = buildSharedCoordsFromActivity(state.activity);
    Object.keys(fromActivity).forEach((playerKey) => {
        const merged = sortCoordList((shared[playerKey] || []).concat(fromActivity[playerKey] || []));
        if (merged.length) {
            shared[playerKey] = merged;
        }
    });
    return shared;
}

function createEmptyState() {
    return {
        targets: {},
        updatedAt: 0,
        control: null,
        controlUpdatedAt: 0,
        activity: { players: {}, buckets: {} },
        activityUpdatedAt: 0,
        sharedCoords: {},
        sharedCoordsUpdatedAt: 0,
        editLock: null
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
        const base = createEmptyState();
        base.targets = normalizeTargets(parsed.targets);
        base.updatedAt = safeNumber(parsed.updatedAt, 0);
        base.control = normalizeControl(parsed.control);
        base.controlUpdatedAt = safeNumber(parsed.controlUpdatedAt, 0);
        base.activity = normalizeActivityState(parsed.activity);
        base.activityUpdatedAt = safeNumber(parsed.activityUpdatedAt, 0);
        base.sharedCoords = normalizeSharedCoordsState(parsed.sharedCoords);
        base.sharedCoordsUpdatedAt = safeNumber(parsed.sharedCoordsUpdatedAt, 0);
        base.editLock = normalizeEditLock(parsed.editLock);
        return base;
    } catch (err) {
        console.warn('[targets-sync-server] failed to load state:', err.message);
        return createEmptyState();
    }
}

let state = loadState();

function persistState() {
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
}

function cleanupExpiredLock(now) {
    if (!state.editLock) {
        return false;
    }
    if (safeNumber(state.editLock.expiresAt, 0) > now) {
        return false;
    }
    state.editLock = null;
    return true;
}

function getPublicEditLock(now) {
    cleanupExpiredLock(now);
    if (!state.editLock) {
        return null;
    }
    return {
        ownerId: state.editLock.ownerId,
        ownerLabel: state.editLock.ownerLabel,
        expiresAt: state.editLock.expiresAt,
        updatedAt: state.editLock.updatedAt
    };
}

function applyEditLockCommand(command) {
    const now = safeNumber(command.now, Date.now());
    cleanupExpiredLock(now);
    const current = state.editLock;

    if (command.action === 'acquire') {
        if (current && current.ownerId !== command.ownerId && !command.force) {
            return {
                ok: false,
                reason: 'occupied',
                ownerId: current.ownerId,
                ownerLabel: current.ownerLabel,
                expiresAt: current.expiresAt
            };
        }
        const previousOwnerId = current ? current.ownerId : '';
        const isTakeover = Boolean(current && current.ownerId !== command.ownerId);
        state.editLock = {
            ownerId: command.ownerId,
            ownerLabel: command.ownerLabel || command.ownerId,
            token: command.token,
            expiresAt: now + clampLockTtl(command.ttlMs),
            updatedAt: now
        };
        return {
            ok: true,
            action: 'acquire',
            takeover: isTakeover,
            previousOwnerId: previousOwnerId,
            ownerId: state.editLock.ownerId,
            ownerLabel: state.editLock.ownerLabel,
            expiresAt: state.editLock.expiresAt
        };
    }

    if (command.action === 'heartbeat') {
        if (!current) {
            return { ok: false, reason: 'no_lock' };
        }
        if (current.ownerId !== command.ownerId || current.token !== command.token) {
            return {
                ok: false,
                reason: 'forbidden',
                ownerId: current.ownerId,
                ownerLabel: current.ownerLabel,
                expiresAt: current.expiresAt
            };
        }
        current.ownerLabel = command.ownerLabel || current.ownerLabel || current.ownerId;
        current.expiresAt = now + clampLockTtl(command.ttlMs);
        current.updatedAt = now;
        return {
            ok: true,
            action: 'heartbeat',
            ownerId: current.ownerId,
            ownerLabel: current.ownerLabel,
            expiresAt: current.expiresAt
        };
    }

    if (command.action === 'release') {
        if (!current) {
            return { ok: false, action: 'release', reason: 'no_lock' };
        }
        if (current.ownerId !== command.ownerId || current.token !== command.token) {
            return {
                ok: false,
                action: 'release',
                reason: 'forbidden',
                ownerId: current.ownerId,
                ownerLabel: current.ownerLabel,
                expiresAt: current.expiresAt
            };
        }
        state.editLock = null;
        return { ok: true, action: 'release' };
    }

    return { ok: false, reason: 'invalid_action' };
}

function buildPublicState(includeActivity) {
    const now = Date.now();
    const payload = {
        targets: state.targets,
        updatedAt: state.updatedAt,
        control: state.control,
        controlUpdatedAt: state.controlUpdatedAt,
        editLock: getPublicEditLock(now),
        sharedCoords: buildPublicSharedCoords(),
        sharedCoordsUpdatedAt: Math.max(safeNumber(state.sharedCoordsUpdatedAt, 0), safeNumber(state.activityUpdatedAt, 0))
    };
    if (includeActivity) {
        payload.activity = state.activity;
        payload.activityUpdatedAt = state.activityUpdatedAt;
    }
    return payload;
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PTRE-Token, x-ptre-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.end(body);
}

function isAuthorized(req) {
    if (!SYNC_TOKEN) {
        return true;
    }
    const sent = req.headers['x-ptre-token'];
    return sent === SYNC_TOKEN;
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

function parseRequestUrl(req) {
    try {
        return new URL(req.url || '/', 'http://localhost');
    } catch (err) {
        return new URL('/targets', 'http://localhost');
    }
}

function parseUpdatePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }
    const update = {};

    if (Object.prototype.hasOwnProperty.call(payload, 'targets') || looksLikeTargetMap(payload)) {
        const rawTargets = Object.prototype.hasOwnProperty.call(payload, 'targets') ? payload.targets : payload;
        update.targets = normalizeTargets(rawTargets);
        update.updatedAt = safeNumber(payload.updatedAt, Date.now());
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'control')) {
        const control = normalizeControl(payload.control);
        if (control) {
            update.control = control;
            update.controlUpdatedAt = safeNumber(payload.controlUpdatedAt, Date.now());
        }
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'activityBatch')) {
        const batch = normalizeActivityBatch(payload.activityBatch);
        if (batch.length > 0) {
            update.activityBatch = batch;
            update.activityUpdatedAt = safeNumber(payload.activityUpdatedAt, Date.now());
        }
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'coordsBatch')) {
        const batch = normalizeSharedCoordsBatch(payload.coordsBatch);
        if (batch.length > 0) {
            update.coordsBatch = batch;
            update.coordsUpdatedAt = safeNumber(payload.coordsUpdatedAt, Date.now());
        }
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'editLockCommand')) {
        const command = normalizeEditLockCommand(payload.editLockCommand);
        if (command) {
            update.editLockCommand = command;
        }
    }

    if (!Object.keys(update).length) {
        return null;
    }
    return update;
}

const server = http.createServer(async (req, res) => {
    cleanupExpiredLock(Date.now());

    if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
    }

    const reqUrl = parseRequestUrl(req);
    if (reqUrl.pathname !== '/targets') {
        sendJson(res, 404, { error: 'not found' });
        return;
    }

    if (!isAuthorized(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
    }

    if (req.method === 'GET') {
        const includeActivityRaw = String(reqUrl.searchParams.get('includeActivity') || '').toLowerCase();
        const includeActivity = includeActivityRaw === '1' || includeActivityRaw === 'true' || includeActivityRaw === 'yes';
        sendJson(res, 200, buildPublicState(includeActivity));
        return;
    }

    if (req.method !== 'PUT') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }

    try {
        const rawBody = await readBody(req);
        const parsed = rawBody ? JSON.parse(rawBody) : {};
        const update = parseUpdatePayload(parsed);
        if (!update) {
            sendJson(res, 400, { error: 'invalid payload' });
            return;
        }
        let stateChanged = false;
        let lockResult = null;
        if (Object.prototype.hasOwnProperty.call(update, 'targets')) {
            state.targets = update.targets;
            state.updatedAt = update.updatedAt;
            stateChanged = true;
        }
        if (Object.prototype.hasOwnProperty.call(update, 'control')) {
            state.control = update.control;
            state.controlUpdatedAt = update.controlUpdatedAt;
            stateChanged = true;
        }
        if (Object.prototype.hasOwnProperty.call(update, 'activityBatch')) {
            state.activity = mergeActivityBatch(state.activity, update.activityBatch);
            state.activityUpdatedAt = update.activityUpdatedAt;
            stateChanged = true;
        }
        if (Object.prototype.hasOwnProperty.call(update, 'coordsBatch')) {
            state.sharedCoords = mergeSharedCoordsBatch(state.sharedCoords, update.coordsBatch);
            state.sharedCoordsUpdatedAt = Math.max(safeNumber(state.sharedCoordsUpdatedAt, 0), update.coordsUpdatedAt);
            stateChanged = true;
        }
        if (Object.prototype.hasOwnProperty.call(update, 'editLockCommand')) {
            const beforeLock = state.editLock ? JSON.stringify(state.editLock) : '';
            lockResult = applyEditLockCommand(update.editLockCommand);
            const afterLock = state.editLock ? JSON.stringify(state.editLock) : '';
            if (beforeLock !== afterLock) {
                stateChanged = true;
            }
        }
        if (stateChanged) {
            persistState();
        }
        const response = buildPublicState(false);
        if (lockResult) {
            response.lockResult = lockResult;
        }
        sendJson(res, 200, response);
    } catch (err) {
        sendJson(res, 400, { error: err.message || 'bad request' });
    }
});

server.listen(PORT, HOST, () => {
    console.log('[targets-sync-server] listening on http://' + HOST + ':' + PORT + '/targets');
    if (!SYNC_TOKEN) {
        console.log('[targets-sync-server] warning: SYNC_TOKEN is empty');
    }
});
