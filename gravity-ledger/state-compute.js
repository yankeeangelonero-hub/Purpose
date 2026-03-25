/**
 * state-compute.js — Derive current state from snapshot + transactions.
 *
 * The computed state is the single source of truth. It's rebuilt from the most
 * recent snapshot plus all subsequent transactions. No mutable blobs — state is
 * always derived, never stored-and-mutated.
 */

/**
 * @typedef {Object} ComputedState
 * @property {Object<string, Object>} characters - Map of id → character state
 * @property {Object<string, Object>} constraints - Map of id → constraint state
 * @property {Object<string, Object>} collisions - Map of id → collision state
 * @property {Object<string, Object>} chapters - Map of id → chapter state
 * @property {Object} world - World singleton state
 * @property {Object} pc - PC singleton state
 * @property {number} lastTxId - Last applied transaction id
 */

/**
 * Create an empty computed state.
 * @returns {ComputedState}
 */
function createEmptyState() {
    return {
        characters: {},
        constraints: {},
        collisions: {},
        chapters: {},
        world: {
            factions: [],
            world_state: '',
            pressure_points: [],
            story_arcs_completed: [],
            world_events: [],
            constants: {},
        },
        pc: {
            name: '',
            demonstrated_traits: [],
            reputation: {},
            timeline: [],
        },
        lastTxId: -1,
    };
}

/**
 * Get the entity collection name for an entity type code.
 * @param {string} entityType - 'char', 'constraint', 'collision', 'chapter', 'world', 'pc'
 * @returns {string}
 */
function getCollectionName(entityType) {
    const map = {
        char: 'characters',
        constraint: 'constraints',
        collision: 'collisions',
        chapter: 'chapters',
        world: 'world',
        pc: 'pc',
    };
    return map[entityType] || entityType;
}

/**
 * Apply a single transaction to the state.
 * @param {ComputedState} state - Mutable state object
 * @param {Object} tx - Transaction to apply
 * @returns {ComputedState} The mutated state (same reference)
 */
function applyTransaction(state, tx) {
    const collection = getCollectionName(tx.e);
    const isSingleton = tx.e === 'world' || tx.e === 'pc';

    switch (tx.op) {
        case 'CR': { // Create
            if (isSingleton) {
                Object.assign(state[collection], tx.d);
            } else {
                state[collection][tx.id] = { id: tx.id, ...tx.d };
            }
            break;
        }

        case 'TR': { // Transition
            const target = isSingleton ? state[collection] : state[collection][tx.id];
            if (target && tx.d.f) {
                target[tx.d.f] = tx.d.to;
            }
            break;
        }

        case 'S': { // Set
            const target = isSingleton ? state[collection] : state[collection][tx.id];
            if (target && tx.d.f) {
                target[tx.d.f] = tx.d.v;
            }
            break;
        }

        case 'A': { // Append
            const target = isSingleton ? state[collection] : state[collection][tx.id];
            if (target && tx.d.f) {
                if (!Array.isArray(target[tx.d.f])) target[tx.d.f] = [];
                target[tx.d.f].push(tx.d.v);
            }
            break;
        }

        case 'R': { // Remove
            const target = isSingleton ? state[collection] : state[collection][tx.id];
            if (target && tx.d.f && Array.isArray(target[tx.d.f])) {
                target[tx.d.f] = target[tx.d.f].filter(item =>
                    typeof item === 'string' ? item !== tx.d.v : JSON.stringify(item) !== JSON.stringify(tx.d.v)
                );
            }
            break;
        }

        case 'MS': { // Map Set
            const target = isSingleton ? state[collection] : state[collection][tx.id];
            if (target && tx.d.f) {
                if (typeof target[tx.d.f] !== 'object' || Array.isArray(target[tx.d.f])) {
                    target[tx.d.f] = {};
                }
                target[tx.d.f][tx.d.k] = tx.d.v;
            }
            break;
        }

        case 'MR': { // Map Remove
            const target = isSingleton ? state[collection] : state[collection][tx.id];
            if (target && tx.d.f && typeof target[tx.d.f] === 'object') {
                delete target[tx.d.f][tx.d.k];
            }
            break;
        }

        case 'D': { // Destroy
            if (!isSingleton) {
                delete state[collection][tx.id];
            }
            break;
        }

        case 'AMEND': {
            // Amend rewrites history. The correction contains a replacement transaction
            // that supersedes the original. During state computation, we track amendments
            // and skip the original tx when rebuilding. The AMEND itself carries the
            // corrected data that gets applied instead.
            //
            // d.target_tx: the tx id being corrected
            // d.correction: the replacement transaction (same shape as a normal tx)
            // d.reason: why the amendment was needed
            //
            // The correction is applied in place of the original during computeState().
            // This is handled in computeState(), not here — AMEND is a meta-operation.
            break;
        }

        // SNAPSHOT and ROLLBACK are handled by snapshot-mgr, not here
        default:
            break;
    }

    state.lastTxId = tx.tx;
    return state;
}

/**
 * Compute full state from a snapshot (or empty state) plus transactions.
 * Handles AMEND operations by collecting amendments first, then applying
 * corrected versions in place of originals during replay.
 *
 * @param {ComputedState|null} snapshot - Starting state (null = empty)
 * @param {Array} transactions - Transactions to apply in order
 * @returns {ComputedState}
 */
function computeState(snapshot, transactions) {
    const state = snapshot ? structuredClone(snapshot) : createEmptyState();

    // First pass: collect all amendments (maps target_tx → correction)
    const amendments = new Map();
    for (const tx of transactions) {
        if (tx.op === 'AMEND' && tx.d?.target_tx != null && tx.d?.correction) {
            amendments.set(tx.d.target_tx, tx.d.correction);
        }
    }

    // Second pass: apply transactions, substituting amendments
    for (const tx of transactions) {
        // Skip meta transactions
        if (tx.op === 'SNAP' || tx.op === 'ROLL' || tx.op === 'AMEND') continue;

        // If this transaction was amended, apply the correction instead
        if (amendments.has(tx.tx)) {
            const corrected = amendments.get(tx.tx);
            applyTransaction(state, { ...corrected, tx: tx.tx });
        } else {
            applyTransaction(state, tx);
        }
    }

    return state;
}

/**
 * Compute a diff between two states.
 * @param {ComputedState} before
 * @param {ComputedState} after
 * @returns {Array<Object>} Array of changes: { entity, id, field, from, to }
 */
function diffStates(before, after) {
    const changes = [];

    // Diff entity collections
    for (const collectionName of ['characters', 'constraints', 'collisions', 'chapters']) {
        const beforeCol = before[collectionName] || {};
        const afterCol = after[collectionName] || {};

        // New entities
        for (const id of Object.keys(afterCol)) {
            if (!beforeCol[id]) {
                changes.push({ entity: collectionName, id, type: 'created', data: afterCol[id] });
                continue;
            }
            // Changed fields
            for (const field of new Set([...Object.keys(beforeCol[id]), ...Object.keys(afterCol[id])])) {
                const bv = JSON.stringify(beforeCol[id][field]);
                const av = JSON.stringify(afterCol[id][field]);
                if (bv !== av) {
                    changes.push({
                        entity: collectionName, id, type: 'changed', field,
                        from: beforeCol[id][field], to: afterCol[id][field],
                    });
                }
            }
        }

        // Deleted entities
        for (const id of Object.keys(beforeCol)) {
            if (!afterCol[id]) {
                changes.push({ entity: collectionName, id, type: 'deleted' });
            }
        }
    }

    // Diff singletons (world, pc)
    for (const singleton of ['world', 'pc']) {
        for (const field of new Set([...Object.keys(before[singleton] || {}), ...Object.keys(after[singleton] || {})])) {
            const bv = JSON.stringify((before[singleton] || {})[field]);
            const av = JSON.stringify((after[singleton] || {})[field]);
            if (bv !== av) {
                changes.push({
                    entity: singleton, id: singleton, type: 'changed', field,
                    from: (before[singleton] || {})[field],
                    to: (after[singleton] || {})[field],
                });
            }
        }
    }

    return changes;
}

/**
 * Get derived phonebook from character states.
 * @param {ComputedState} state
 * @returns {Object} { principal: string|null, tracked: string[], known: string[] }
 */
function getPhonebook(state) {
    const result = { principal: null, tracked: [], known: [] };
    for (const char of Object.values(state.characters)) {
        switch (char.tier) {
            case 'PRINCIPAL': result.principal = char.name || char.id; break;
            case 'TRACKED': result.tracked.push(char.name || char.id); break;
            case 'KNOWN': result.known.push(char.name || char.id); break;
        }
    }
    return result;
}

export {
    createEmptyState,
    applyTransaction,
    computeState,
    diffStates,
    getPhonebook,
    getCollectionName,
};
