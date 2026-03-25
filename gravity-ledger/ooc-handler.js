/**
 * ooc-handler.js — OOC keyword dispatch for structural operations.
 *
 * When the player types an OOC command, SillyTavern fires the corresponding
 * lorebook entry (keyword-triggered). The extension also intercepts these
 * keywords to perform mechanical operations (snapshot, rollback, check, etc.)
 * and inject results into the next prompt context.
 *
 * For eval: the extension provides the LLM with the full transaction history
 * for the entities it needs to audit. The LLM can emit AMEND transactions
 * in its ledger block to correct continuity errors in the history.
 */

import { createSnapshot, listSnapshots, rollback, computeCurrentState } from './snapshot-mgr.js';
import {
    getAllTransactions,
    getTransactionsForEntity,
    getTransactionsInRange,
} from './ledger-store.js';
import { diffStates } from './state-compute.js';
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
    { pattern: /ooc:\s*rollback\s+to\s+#?(\d+)/i, handler: handleRollbackConfirm },
    { pattern: /ooc:\s*rollback\b/i, handler: handleRollback },
    { pattern: /ooc:\s*eval\b/i, handler: handleEval },
    { pattern: /ooc:\s*history\s+(.+)/i, handler: handleHistory },
    { pattern: /ooc:\s*timeline\s+(.+)\s+to\s+(.+)/i, handler: handleTimeline },
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

// ─── Handlers ──────────────────────────────────────────────────────────────────

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
    for (const snap of snapshots.slice(-5)) {
        lines.push(`  #${snap.id}: "${snap.label}" (tx ${snap.lastTxId}, ${snap.createdAt})`);
    }
    lines.push(`Player: reply "OOC: rollback to #N" to confirm.]`);
    return lines.join('\n');
}

/**
 * OOC: rollback to #N — Execute rollback to a specific snapshot.
 */
async function handleRollbackConfirm(bookName, match) {
    const targetId = parseInt(match[1], 10);
    const restoredState = await rollback(bookName, targetId);
    await renderAll(bookName, restoredState);
    return `[LEDGER: Rolled back to snapshot #${targetId}. State view updated. The rollback is recorded in the ledger — no data was lost.]`;
}

/**
 * OOC: eval — Full system evaluation.
 *
 * The extension provides the LLM with:
 * 1. The full transaction history (summarized by entity)
 * 2. The current computed state
 * 3. A safety snapshot
 *
 * The LLM audits gameplay rules (constraint counts, collision health,
 * state machine transitions, continuity) and can emit AMEND transactions
 * in its ledger block to correct errors.
 *
 * AMEND format: {"op":"AMEND","d":{"target_tx":42,"correction":{...replacement tx...},"reason":"..."}}
 */
async function handleEval(bookName) {
    const state = await computeCurrentState(bookName);
    const allTxns = await getAllTransactions();

    // Safety snapshot before eval
    await createSnapshot(bookName, state, 'Pre-eval safety snapshot');

    const lines = [];
    lines.push('═══ LEDGER: SYSTEM EVALUATION ═══');
    lines.push('');
    lines.push(`Ledger: ${allTxns.length} transactions total`);
    lines.push(`Characters: ${Object.keys(state.characters).length}`);
    lines.push(`Constraints: ${Object.keys(state.constraints).length}`);
    lines.push(`Collisions: ${Object.keys(state.collisions).length}`);
    lines.push(`Chapters: ${Object.keys(state.chapters).length}`);
    lines.push('');

    // Summarize recent transactions by entity for the LLM to audit
    lines.push('RECENT TRANSACTION HISTORY (last 30):');
    const recent = allTxns.slice(-30);
    for (const tx of recent) {
        const time = tx.t || '';
        const amended = allTxns.some(t => t.op === 'AMEND' && t.d?.target_tx === tx.tx);
        const flag = amended ? ' [AMENDED]' : '';
        lines.push(`  tx#${tx.tx} ${time} ${tx.op} ${tx.e}:${tx.id || '—'} — ${tx.r || summarizeTxData(tx)}${flag}`);
    }
    lines.push('');

    // Current state summary for cross-reference
    lines.push('CURRENT STATE SUMMARY:');
    for (const [id, char] of Object.entries(state.characters)) {
        const tier = char.tier || '?';
        const constraints = Object.values(state.constraints)
            .filter(c => c.owner_id === id)
            .map(c => `${c.name}[${c.integrity}]`)
            .join(', ');
        lines.push(`  ${char.name || id} [${tier}] — ${constraints || 'no constraints'}`);
    }
    for (const [id, col] of Object.entries(state.collisions)) {
        if (col.status === 'RESOLVED') continue;
        lines.push(`  ⊕ ${col.name || id} [${col.status}] distance:${col.distance || '?'}`);
    }
    lines.push('');

    lines.push('YOUR JOB: Audit the above for:');
    lines.push('  - Continuity errors (events that contradict each other)');
    lines.push('  - Missing state (events in chat not reflected in ledger)');
    lines.push('  - Ghost state (ledger records things that never happened)');
    lines.push('  - Gameplay rule violations (constraint counts, collision health, etc.)');
    lines.push('  - Stale data (entities unchanged despite active story pressure)');
    lines.push('');
    lines.push('TO FIX: Emit AMEND transactions in your ---LEDGER--- block:');
    lines.push('  {"op":"AMEND","d":{"target_tx":42,"correction":{...corrected tx...},"reason":"why"}}');
    lines.push('');
    lines.push('You can also use "OOC: history [entity-id]" to retrieve full history for a specific entity.');
    lines.push('');
    lines.push('Safety snapshot taken. State will be recomputed after your amendments.');
    lines.push('═══ END EVALUATION DATA ═══');

    return lines.join('\n');
}

/**
 * OOC: history [entity] — View full change history for a specific entity.
 * Provides the LLM with every transaction that touched this entity,
 * so it can identify continuity errors and emit AMEND corrections.
 */
async function handleHistory(bookName, match) {
    const entityQuery = match[1].trim();
    const txns = await getTransactionsForEntity(entityQuery);

    if (txns.length === 0) {
        // Try fuzzy matching — search all transactions for names containing the query
        const allTxns = await getAllTransactions();
        const fuzzy = allTxns.filter(tx =>
            (tx.id && tx.id.toLowerCase().includes(entityQuery.toLowerCase())) ||
            (tx.r && tx.r.toLowerCase().includes(entityQuery.toLowerCase()))
        );

        if (fuzzy.length === 0) {
            return `[LEDGER: No history found for "${entityQuery}". Use the exact entity id.]`;
        }

        const ids = [...new Set(fuzzy.map(tx => tx.id).filter(Boolean))];
        return `[LEDGER: No exact match for "${entityQuery}". Did you mean: ${ids.slice(0, 5).join(', ')}?]`;
    }

    const lines = [];
    lines.push(`═══ LEDGER HISTORY: ${entityQuery} (${txns.length} transactions) ═══`);
    for (const tx of txns) {
        const time = tx.t || '';
        const amended = tx._amended ? ' [AMENDED]' : '';
        lines.push(`  tx#${tx.tx} ${time} ${tx.op} — ${tx.r || summarizeTxData(tx)}${amended}`);
        // For transitions, show the actual state change
        if (tx.op === 'TR') {
            lines.push(`    ${tx.d.f}: ${tx.d.from} → ${tx.d.to}`);
        }
        // For sets/appends, show what changed
        if (tx.op === 'S') {
            lines.push(`    ${tx.d.f} = ${JSON.stringify(tx.d.v).substring(0, 80)}`);
        }
        if (tx.op === 'A') {
            lines.push(`    ${tx.d.f} += ${JSON.stringify(tx.d.v).substring(0, 80)}`);
        }
        if (tx.op === 'MS') {
            lines.push(`    ${tx.d.f}[${tx.d.k}] = ${JSON.stringify(tx.d.v).substring(0, 80)}`);
        }
    }
    lines.push('');
    lines.push('To fix errors, emit AMEND in your ---LEDGER--- block:');
    lines.push('  {"op":"AMEND","d":{"target_tx":N,"correction":{...},"reason":"..."}}');
    lines.push(`═══ END HISTORY ═══`);

    return lines.join('\n');
}

/**
 * OOC: timeline [from] to [to] — View transactions within a time range.
 */
async function handleTimeline(bookName, match) {
    const from = match[1].trim();
    const to = match[2].trim();
    const txns = await getTransactionsInRange(from, to);

    if (txns.length === 0) {
        return `[LEDGER: No transactions found between "${from}" and "${to}".]`;
    }

    const lines = [];
    lines.push(`═══ LEDGER TIMELINE: ${from} to ${to} (${txns.length} transactions) ═══`);
    for (const tx of txns) {
        lines.push(`  tx#${tx.tx} ${tx.t} ${tx.op} ${tx.e}:${tx.id || '—'} — ${tx.r || summarizeTxData(tx)}`);
    }
    lines.push(`═══ END TIMELINE ═══`);

    return lines.join('\n');
}

/**
 * OOC: archive / consolidate — Snapshot and confirm.
 */
async function handleConsolidate(bookName) {
    const state = await computeCurrentState(bookName);
    const snap = await createSnapshot(bookName, state, 'Consolidation checkpoint');
    await renderAll(bookName, state);

    return `[LEDGER: Consolidated. Snapshot #${snap.id} at tx ${snap.lastTxId}. State view refreshed. Write your next delta block as: Δ this turn: ∅ (consolidated)]`;
}

/**
 * OOC: migrate to ledger — Stub for TunnelVision migration.
 */
async function handleMigrate(bookName) {
    return `[LEDGER: Migration not yet implemented. Use OOC: setup to initialize a fresh Gravity Ledger game.]`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Summarize transaction data for display when no reason string is provided.
 * @param {Object} tx
 * @returns {string}
 */
function summarizeTxData(tx) {
    if (!tx.d) return '';
    switch (tx.op) {
        case 'CR': return `created ${tx.e}`;
        case 'TR': return `${tx.d.f}: ${tx.d.from}→${tx.d.to}`;
        case 'S':  return `${tx.d.f} = ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'A':  return `${tx.d.f} += ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'R':  return `${tx.d.f} -= ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'MS': return `${tx.d.f}[${tx.d.k}] = ${JSON.stringify(tx.d.v).substring(0, 50)}`;
        case 'MR': return `${tx.d.f}[${tx.d.k}] removed`;
        case 'D':  return `destroyed`;
        case 'AMEND': return `amends tx#${tx.d.target_tx}: ${tx.d.reason || ''}`;
        default: return JSON.stringify(tx.d).substring(0, 60);
    }
}

export {
    processOOC,
    OOC_PATTERNS,
};
