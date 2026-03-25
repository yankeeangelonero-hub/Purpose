/**
 * snapshot-mgr.js — Snapshot creation, storage, and rollback.
 *
 * Snapshots are materialized views of full computed state at a point in time.
 * Stored as disabled lorebook entries. Used for rollback and as computation
 * checkpoints (compute from latest snapshot + subsequent txns, not from scratch).
 */

import { findEntryByComment, createEntry, updateEntry, getEntries } from './lorebook-api.js';
import { computeState, createEmptyState } from './state-compute.js';
import { getAllTransactions, getTransactionsSince, append } from './ledger-store.js';

const SNAPSHOT_PREFIX = 'Gravity_Snapshot_';
const MAX_ACTIVE_SNAPSHOTS = 3; // Keep 3 most recent as full entries; older ones archived

let _snapshotCounter = 0;

/**
 * Initialize snapshot manager — count existing snapshots.
 * @param {string} bookName
 */
async function init(bookName) {
    const entries = await getEntries(bookName);
    for (const entry of Object.values(entries)) {
        if (entry.comment && entry.comment.startsWith(SNAPSHOT_PREFIX)) {
            const num = parseInt(entry.comment.replace(SNAPSHOT_PREFIX, ''), 10);
            if (num >= _snapshotCounter) _snapshotCounter = num + 1;
        }
    }
}

/**
 * Create a new snapshot of the current computed state.
 * @param {string} bookName
 * @param {import('./state-compute.js').ComputedState} currentState
 * @param {string} [label] - Human-readable label
 * @returns {Promise<Object>} The snapshot metadata
 */
async function createSnapshot(bookName, currentState, label) {
    const snapshotId = _snapshotCounter++;
    const comment = `${SNAPSHOT_PREFIX}${snapshotId}`;

    const snapshot = {
        id: snapshotId,
        label: label || `Snapshot ${snapshotId}`,
        lastTxId: currentState.lastTxId,
        createdAt: new Date().toISOString(),
        state: currentState,
    };

    // Store as disabled lorebook entry (never injected into prompt)
    await createEntry(bookName, {
        comment,
        content: JSON.stringify(snapshot),
        constant: false,
        disable: true,
        key: [],
    });

    // Record snapshot in ledger
    await append([{
        op: 'SNAP',
        e: 'system',
        id: `snapshot-${snapshotId}`,
        d: { snapshot_id: snapshotId, label: label || '' },
        r: `Snapshot: ${label || 'auto'}`,
    }]);

    // Archive old snapshots beyond MAX_ACTIVE_SNAPSHOTS
    await archiveOldSnapshots(bookName);

    return { id: snapshotId, label: snapshot.label, lastTxId: currentState.lastTxId };
}

/**
 * Get the most recent snapshot.
 * @param {string} bookName
 * @returns {Promise<Object|null>} The snapshot data or null
 */
async function getLatestSnapshot(bookName) {
    const entries = await getEntries(bookName);
    let latest = null;
    let latestNum = -1;

    for (const entry of Object.values(entries)) {
        if (entry.comment && entry.comment.startsWith(SNAPSHOT_PREFIX) && !entry.disable) {
            // Active snapshots only
        }
        if (entry.comment && entry.comment.startsWith(SNAPSHOT_PREFIX)) {
            const num = parseInt(entry.comment.replace(SNAPSHOT_PREFIX, ''), 10);
            if (num > latestNum) {
                try {
                    latest = JSON.parse(entry.content);
                    latestNum = num;
                } catch {
                    console.warn(`[GravityLedger] Failed to parse snapshot ${num}`);
                }
            }
        }
    }

    return latest;
}

/**
 * Get a specific snapshot by ID.
 * @param {string} bookName
 * @param {number} snapshotId
 * @returns {Promise<Object|null>}
 */
async function getSnapshot(bookName, snapshotId) {
    const entry = await findEntryByComment(bookName, `${SNAPSHOT_PREFIX}${snapshotId}`);
    if (!entry) return null;
    try {
        return JSON.parse(entry.content);
    } catch {
        return null;
    }
}

/**
 * List all available snapshots.
 * @param {string} bookName
 * @returns {Promise<Array<{id: number, label: string, lastTxId: number}>>}
 */
async function listSnapshots(bookName) {
    const entries = await getEntries(bookName);
    const snapshots = [];

    for (const entry of Object.values(entries)) {
        if (entry.comment && entry.comment.startsWith(SNAPSHOT_PREFIX)) {
            try {
                const data = JSON.parse(entry.content);
                snapshots.push({
                    id: data.id,
                    label: data.label,
                    lastTxId: data.lastTxId,
                    createdAt: data.createdAt,
                });
            } catch {
                // Skip corrupt snapshots
            }
        }
    }

    return snapshots.sort((a, b) => a.id - b.id);
}

/**
 * Rollback to a specific snapshot.
 * The rollback itself is recorded in the ledger (append-only — we never delete transactions).
 * Returns the restored state.
 *
 * @param {string} bookName
 * @param {number} targetSnapshotId
 * @returns {Promise<import('./state-compute.js').ComputedState>}
 */
async function rollback(bookName, targetSnapshotId) {
    const snapshot = await getSnapshot(bookName, targetSnapshotId);
    if (!snapshot) {
        throw new Error(`Snapshot ${targetSnapshotId} not found`);
    }

    // Record the rollback in the ledger
    await append([{
        op: 'ROLL',
        e: 'system',
        id: `rollback-to-${targetSnapshotId}`,
        d: { target_snapshot_id: targetSnapshotId },
        r: `Rolled back to snapshot ${targetSnapshotId}: ${snapshot.label}`,
    }]);

    return snapshot.state;
}

/**
 * Compute current state efficiently: from latest snapshot + subsequent transactions.
 * @param {string} bookName
 * @returns {Promise<import('./state-compute.js').ComputedState>}
 */
async function computeCurrentState(bookName) {
    const latestSnapshot = await getLatestSnapshot(bookName);

    if (latestSnapshot) {
        // Compute from snapshot + subsequent transactions
        const txnsSinceSnapshot = await getTransactionsSince(latestSnapshot.lastTxId);
        return computeState(latestSnapshot.state, txnsSinceSnapshot);
    } else {
        // Compute from scratch
        const allTxns = await getAllTransactions();
        return computeState(null, allTxns);
    }
}

/**
 * Archive old snapshots beyond MAX_ACTIVE_SNAPSHOTS.
 * Keeps the N most recent, disables older ones.
 * @param {string} bookName
 */
async function archiveOldSnapshots(bookName) {
    const snapshots = await listSnapshots(bookName);
    if (snapshots.length <= MAX_ACTIVE_SNAPSHOTS) return;

    // Disable all but the most recent N
    const toArchive = snapshots.slice(0, snapshots.length - MAX_ACTIVE_SNAPSHOTS);
    for (const snap of toArchive) {
        const entry = await findEntryByComment(bookName, `${SNAPSHOT_PREFIX}${snap.id}`);
        if (entry && !entry.disable) {
            await updateEntry(bookName, entry.uid, { disable: true });
        }
    }
}

export {
    init as initSnapshots,
    createSnapshot,
    getLatestSnapshot,
    getSnapshot,
    listSnapshots,
    rollback,
    computeCurrentState,
};
