/**
 * ooc-handler.js — OOC keyword dispatch for structural operations.
 *
 * When the player types an OOC command, SillyTavern fires the corresponding
 * lorebook entry (keyword-triggered). The extension also intercepts these
 * keywords to perform mechanical operations (snapshot, rollback, check, etc.)
 * and inject results into the next prompt context.
 */

import { createSnapshot, listSnapshots, rollback, computeCurrentState } from './snapshot-mgr.js';
import { fullCheck } from './consistency.js';
import { getAllTransactions, getTransactionsSince } from './ledger-store.js';
import { computeState, diffStates } from './state-compute.js';
import { renderAll } from './state-view.js';

/**
 * @typedef {Object} OOCResult
 * @property {boolean} handled - Whether the OOC command was recognized
 * @property {string|null} injection - Text to inject into next prompt context
 */

/**
 * OOC command patterns and their handlers.
 */
const OOC_PATTERNS = [
    { pattern: /ooc:\s*snapshot\b/i, handler: handleSnapshot },
    { pattern: /ooc:\s*rollback\b/i, handler: handleRollback },
    { pattern: /ooc:\s*check\b/i, handler: handleCheck },
    { pattern: /ooc:\s*eval\b/i, handler: handleEval },
    { pattern: /ooc:\s*history\s+(.+)/i, handler: handleHistory },
    { pattern: /ooc:\s*archive\b/i, handler: handleConsolidate },
    { pattern: /ooc:\s*consolidate\b/i, handler: handleConsolidate },
    { pattern: /ooc:\s*migrate\s+to\s+ledger\b/i, handler: handleMigrate },
];

/**
 * Process a player message for OOC commands.
 * @param {string} message - The player's message text
 * @param {string} bookName - The ledger lorebook name
 * @returns {Promise<OOCResult>}
 */
async function processOOC(message, bookName) {
    if (!message) return { handled: false, injection: null };

    for (const { pattern, handler } of OOC_PATTERNS) {
        const match = message.match(pattern);
        if (match) {
            try {
                const injection = await handler(bookName, match);
                return { handled: true, injection };
            } catch (err) {
                return {
                    handled: true,
                    injection: `[LEDGER ERROR: ${err.message}]`,
                };
            }
        }
    }

    return { handled: false, injection: null };
}

/**
 * OOC: snapshot — Create a manual snapshot.
 */
async function handleSnapshot(bookName) {
    const state = await computeCurrentState(bookName);
    const snap = await createSnapshot(bookName, state, 'Manual snapshot');
    return `[LEDGER: Snapshot #${snap.id} created at tx ${snap.lastTxId}. Label: "${snap.label}"]`;
}

/**
 * OOC: rollback — Present available snapshots for rollback.
 */
async function handleRollback(bookName) {
    const snapshots = await listSnapshots(bookName);
    if (snapshots.length === 0) {
        return `[LEDGER: No snapshots available for rollback.]`;
    }

    const lines = [`[LEDGER: Available snapshots for rollback:`];
    for (const snap of snapshots.slice(-5)) { // Last 5
        lines.push(`  #${snap.id}: "${snap.label}" (tx ${snap.lastTxId}, ${snap.createdAt})`);
    }
    lines.push(`Player: reply "OOC: rollback to #N" to confirm.]`);
    return lines.join('\n');
}

/**
 * OOC: check — Run consistency check, inject results.
 */
async function handleCheck(bookName) {
    const state = await computeCurrentState(bookName);
    const result = fullCheck(state);

    const lines = ['[LEDGER: Consistency Check'];

    if (result.blocking.length === 0 && result.advisory.length === 0) {
        lines.push('All checks passed. State is consistent.');
    } else {
        if (result.blocking.length) {
            lines.push(`BLOCKING (${result.blocking.length}):`);
            for (const v of result.blocking) {
                lines.push(`  #${v.check}: ${v.message} — Fix: ${v.fix}`);
            }
        }
        if (result.advisory.length) {
            lines.push(`ADVISORY (${result.advisory.length}):`);
            for (const v of result.advisory) {
                lines.push(`  #${v.check}: ${v.message} — ${v.fix}`);
            }
        }
    }

    lines.push(']');
    return lines.join('\n');
}

/**
 * OOC: eval — Run full system evaluation. Takes a safety snapshot first.
 */
async function handleEval(bookName) {
    const state = await computeCurrentState(bookName);

    // Safety snapshot before eval
    await createSnapshot(bookName, state, 'Pre-eval safety snapshot');

    const result = fullCheck(state);
    const allTxns = await getAllTransactions();

    const lines = ['[LEDGER: System Evaluation'];
    lines.push(`Total transactions: ${allTxns.length}`);
    lines.push(`Entities: ${Object.keys(state.characters).length} characters, ${Object.keys(state.constraints).length} constraints, ${Object.keys(state.collisions).length} collisions, ${Object.keys(state.chapters).length} chapters`);
    lines.push('');

    if (result.blocking.length === 0 && result.advisory.length === 0) {
        lines.push('All checks passed.');
    } else {
        if (result.blocking.length) {
            lines.push(`BLOCKING (${result.blocking.length}):`);
            for (const v of result.blocking) {
                lines.push(`  #${v.check} [${v.severity.toUpperCase()}] — ${v.message} — Fix: ${v.fix}`);
            }
        }
        if (result.advisory.length) {
            lines.push(`ADVISORY (${result.advisory.length}):`);
            for (const v of result.advisory) {
                lines.push(`  #${v.check} [${v.severity.toUpperCase()}] — ${v.message} — ${v.fix}`);
            }
        }
    }

    lines.push('');
    lines.push('Safety snapshot taken. Fix issues via ledger block transactions.]');
    return lines.join('\n');
}

/**
 * OOC: history [entity] — View change history for a specific entity.
 */
async function handleHistory(bookName, match) {
    const entityQuery = match[1].trim();
    const allTxns = await getAllTransactions();

    // Find transactions for this entity (by id or name)
    const relevant = allTxns.filter(tx =>
        tx.id === entityQuery ||
        tx.id?.toLowerCase() === entityQuery.toLowerCase() ||
        (tx.d?.name && tx.d.name.toLowerCase().includes(entityQuery.toLowerCase()))
    );

    if (relevant.length === 0) {
        return `[LEDGER: No history found for "${entityQuery}". Try the exact entity id.]`;
    }

    const lines = [`[LEDGER: History for "${entityQuery}" (${relevant.length} transactions):`];
    for (const tx of relevant.slice(-15)) { // Last 15
        lines.push(`  tx#${tx.tx} ${tx.t || ''} ${tx.op} ${tx.e}:${tx.id} — ${tx.r || JSON.stringify(tx.d).substring(0, 80)}`);
    }
    lines.push(']');
    return lines.join('\n');
}

/**
 * OOC: archive / consolidate — Snapshot and confirm.
 */
async function handleConsolidate(bookName) {
    const state = await computeCurrentState(bookName);
    const snap = await createSnapshot(bookName, state, 'Consolidation checkpoint');

    // Re-render state view to ensure it's fresh
    await renderAll(bookName, state);

    return `[LEDGER: Consolidated. Snapshot #${snap.id} at tx ${snap.lastTxId}. State view refreshed. Write your next delta block as: Δ this turn: ∅ (consolidated)]`;
}

/**
 * OOC: migrate to ledger — Migrate from TunnelVision lorebook entries.
 * This is a stub — the actual migration logic depends on the specific
 * TunnelVision entry format and would need to parse freeform text blobs.
 */
async function handleMigrate(bookName) {
    // TODO: Implement full migration logic
    // 1. Scan all lorebooks for TunnelVision-managed entries
    // 2. Parse Phonebook, Principal dossier, PC dossier, World State, Constants
    // 3. Generate CR transactions
    // 4. Commit to ledger
    // 5. Create initial snapshot
    // 6. Disable old entries

    return `[LEDGER: Migration not yet implemented. Use OOC: setup to initialize a fresh Gravity Ledger game.]`;
}

export {
    processOOC,
    OOC_PATTERNS,
};
