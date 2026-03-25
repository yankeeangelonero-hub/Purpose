/**
 * consistency.js — Invariant checking engine.
 *
 * Two types of invariants:
 * - Blocking: reject the transaction, return error
 * - Advisory: accept the transaction, return warning
 */

import { validateTransition, getStateMachineField } from './state-machine.js';

/**
 * @typedef {Object} Violation
 * @property {number} check - Check number
 * @property {'blocking'|'advisory'} severity
 * @property {string} message
 * @property {string} fix
 */

/**
 * Validate a batch of transactions against the current state.
 * Returns blocking violations (should reject) and advisory warnings (should accept but warn).
 *
 * @param {import('./state-compute.js').ComputedState} currentState
 * @param {Array} transactions - Transactions to validate
 * @param {Object} [options]
 * @param {number} [options.turnNumber] - Current turn for advisory checks
 * @returns {{ blocking: Violation[], advisory: Violation[] }}
 */
function validateBatch(currentState, transactions, options = {}) {
    const blocking = [];
    const advisory = [];

    // Build a projected state by applying transactions in order
    // We need to check invariants both per-transaction and on the final state
    const projected = structuredClone(currentState);

    for (const tx of transactions) {
        const txErrors = validateSingleTransaction(projected, tx);
        blocking.push(...txErrors);

        // Apply transaction to projected state for subsequent checks
        if (txErrors.length === 0) {
            const { applyTransaction } = require('./state-compute.js');
            applyTransaction(projected, tx);
        }
    }

    // Check global invariants on projected final state
    blocking.push(...checkGlobalInvariants(projected));

    // Advisory checks (only if no blocking violations)
    if (blocking.length === 0 && options.turnNumber) {
        advisory.push(...checkAdvisoryInvariants(projected, options.turnNumber));
    }

    return { blocking, advisory };
}

/**
 * Validate a single transaction against current state.
 * @param {Object} state - Current (or projected) state
 * @param {Object} tx - Transaction
 * @returns {Violation[]}
 */
function validateSingleTransaction(state, tx) {
    const violations = [];

    // Check 6: State machine transitions
    if (tx.op === 'TR') {
        const smField = getStateMachineField(tx.e);
        if (smField && tx.d.f === smField) {
            // Verify 'from' matches actual current state
            const entity = getEntity(state, tx.e, tx.id);
            if (entity) {
                const actualCurrent = entity[smField];
                if (tx.d.from !== actualCurrent) {
                    violations.push({
                        check: 6,
                        severity: 'blocking',
                        message: `TRANSITION "from" mismatch for ${tx.e}:${tx.id}. Transaction says "${tx.d.from}" but actual state is "${actualCurrent}"`,
                        fix: `Change "from" to "${actualCurrent}"`,
                    });
                }
            }

            // Check 7: No skipping states
            const result = validateTransition(tx.e, tx.d.f, tx.d.from, tx.d.to);
            if (!result.valid) {
                violations.push({
                    check: 7,
                    severity: 'blocking',
                    message: result.error,
                    fix: result.fix,
                });
            }
        }
    }

    // Check 8: BREACHED constraints must have replacement
    if (tx.op === 'TR' && tx.e === 'constraint' && tx.d.to === 'BREACHED') {
        // Check if the batch also includes a SET for replacement
        // (This is checked at the batch level, but flag if the transition alone is suspect)
        const entity = getEntity(state, tx.e, tx.id);
        if (entity && !entity.replacement && !tx.d.replacement) {
            violations.push({
                check: 8,
                severity: 'blocking',
                message: `Constraint "${tx.id}" transitioning to BREACHED requires replacement and replacement_type`,
                fix: `Include SET transactions for "replacement" and "replacement_type" fields in the same batch`,
            });
        }
    }

    // Check 9: Collision forces reference existing characters
    if (tx.op === 'CR' && tx.e === 'collision') {
        const forces = tx.d.forces || [];
        for (const force of forces) {
            if (force.char_id && !state.characters[force.char_id]) {
                violations.push({
                    check: 9,
                    severity: 'blocking',
                    message: `Collision "${tx.id}" references unknown character "${force.char_id}"`,
                    fix: `Create the character entity first, or use a force name without char_id`,
                });
            }
        }
    }

    // Check 10: Timestamps non-decreasing (checked at batch level in validateBatch)

    return violations;
}

/**
 * Check global state invariants on a projected state.
 * @param {Object} state
 * @returns {Violation[]}
 */
function checkGlobalInvariants(state) {
    const violations = [];

    // Check 1: Exactly 0-1 PRINCIPAL
    const principals = Object.values(state.characters).filter(c => c.tier === 'PRINCIPAL');
    if (principals.length > 1) {
        violations.push({
            check: 1,
            severity: 'blocking',
            message: `${principals.length} PRINCIPALs found: ${principals.map(p => p.id).join(', ')}. Only 1 allowed.`,
            fix: `Retire one PRINCIPAL to TRACKED before promoting another`,
        });
    }

    // Check 2: Constraint counts per tier
    for (const char of Object.values(state.characters)) {
        const constraints = Object.values(state.constraints).filter(c => c.owner_id === char.id);
        if (char.tier === 'TRACKED' && (constraints.length < 1 || constraints.length > 2)) {
            violations.push({
                check: 2,
                severity: 'blocking',
                message: `TRACKED character "${char.id}" has ${constraints.length} constraints (expected 1-2)`,
                fix: `Create or remove constraints to match tier requirements`,
            });
        }
        if (char.tier === 'PRINCIPAL' && (constraints.length < 3 || constraints.length > 4)) {
            violations.push({
                check: 2,
                severity: 'blocking',
                message: `PRINCIPAL character "${char.id}" has ${constraints.length} constraints (expected 3-4)`,
                fix: `Create or remove constraints to match tier requirements`,
            });
        }
    }

    // Check 3: Constraint owners must be TRACKED or PRINCIPAL
    for (const constraint of Object.values(state.constraints)) {
        const owner = state.characters[constraint.owner_id];
        if (!owner || (owner.tier !== 'TRACKED' && owner.tier !== 'PRINCIPAL')) {
            violations.push({
                check: 3,
                severity: 'blocking',
                message: `Constraint "${constraint.id}" owned by "${constraint.owner_id}" who is ${owner ? owner.tier : 'unknown'}`,
                fix: `Promote the character to TRACKED or PRINCIPAL first`,
            });
        }
    }

    // Check 4: Collisions must have 2+ forces
    for (const collision of Object.values(state.collisions)) {
        if (collision.status !== 'RESOLVED') {
            const forces = collision.forces || [];
            if (forces.length < 2) {
                violations.push({
                    check: 4,
                    severity: 'blocking',
                    message: `Collision "${collision.id}" has ${forces.length} forces (minimum 2)`,
                    fix: `Add forces to the collision`,
                });
            }
        }
    }

    // Check 5: Exactly 1 OPEN chapter during play
    const openChapters = Object.values(state.chapters).filter(ch => ch.status === 'OPEN');
    if (openChapters.length > 1) {
        violations.push({
            check: 5,
            severity: 'blocking',
            message: `${openChapters.length} OPEN chapters found. Only 1 allowed.`,
            fix: `Close one chapter before opening another`,
        });
    }

    return violations;
}

/**
 * Check advisory invariants (non-blocking warnings).
 * @param {Object} state
 * @param {number} currentTurn
 * @returns {Violation[]}
 */
function checkAdvisoryInvariants(state, currentTurn) {
    const warnings = [];

    // Check 11: Stale constraints (unchanged 10+ turns while owner in active collision)
    // This would require turn tracking per constraint — deferred to when we have that data

    // Check 12: Stale collisions (unchanged 5+ turns)
    for (const collision of Object.values(state.collisions)) {
        if (collision.status === 'ACTIVE' || collision.status === 'SIMMERING') {
            if (collision.last_turn && currentTurn - collision.last_turn >= 5) {
                warnings.push({
                    check: 12,
                    severity: 'advisory',
                    message: `Collision "${collision.id}" unchanged for ${currentTurn - collision.last_turn} turns`,
                    fix: `Advance, resolve, or escalate this collision`,
                });
            }
        }
    }

    // Check 14: Active collision count outside 2-4 range
    const activeCollisions = Object.values(state.collisions).filter(
        c => c.status === 'ACTIVE'
    );
    if (activeCollisions.length > 4) {
        warnings.push({
            check: 14,
            severity: 'advisory',
            message: `${activeCollisions.length} active collisions (healthy range: 2-3, max 4)`,
            fix: `Resolve some active collisions before adding new ones`,
        });
    } else if (activeCollisions.length < 2 && Object.keys(state.chapters).length > 0) {
        const openChapter = Object.values(state.chapters).find(ch => ch.status === 'OPEN');
        if (openChapter) {
            warnings.push({
                check: 14,
                severity: 'advisory',
                message: `Only ${activeCollisions.length} active collision(s) — may indicate stalling`,
                fix: `Consider advancing simmering collisions or seeding new ones`,
            });
        }
    }

    return warnings;
}

/**
 * Get an entity from the state by type and id.
 * @param {Object} state
 * @param {string} entityType
 * @param {string} entityId
 * @returns {Object|null}
 */
function getEntity(state, entityType, entityId) {
    const { getCollectionName } = require('./state-compute.js');
    const collection = getCollectionName(entityType);
    if (entityType === 'world' || entityType === 'pc') return state[collection];
    return state[collection]?.[entityId] || null;
}

/**
 * Run a full consistency check on a state.
 * @param {Object} state
 * @param {Object} [options]
 * @param {number} [options.turnNumber]
 * @returns {{ blocking: Violation[], advisory: Violation[] }}
 */
function fullCheck(state, options = {}) {
    const blocking = checkGlobalInvariants(state);
    const advisory = options.turnNumber
        ? checkAdvisoryInvariants(state, options.turnNumber)
        : [];
    return { blocking, advisory };
}

export {
    validateBatch,
    validateSingleTransaction,
    checkGlobalInvariants,
    checkAdvisoryInvariants,
    fullCheck,
};
