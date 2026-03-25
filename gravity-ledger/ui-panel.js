/**
 * ui-panel.js — Minimalist front-end panel for Gravity Ledger.
 *
 * Renders the current computed state as collapsible folders in SillyTavern's
 * extension panel. Each entity type (characters, constraints, collisions,
 * chapters, world, PC) gets its own folder. Updated after every ledger commit.
 */

const PANEL_ID = 'gravity-ledger-panel';

// ─── Panel Scaffold ─────────────────────────────────────────────────────────────

/**
 * Create the panel HTML and inject it into SillyTavern's extensions drawer.
 * Safe to call multiple times — only creates once.
 */
function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
        <div class="gl-header">
            <h3>Gravity Ledger</h3>
            <span class="gl-status" id="gl-status">not initialized</span>
        </div>
        <div id="gl-folders"></div>
        <div class="gl-footer">
            <span id="gl-turn">Turn 0</span>
            <span id="gl-tx">TX 0</span>
        </div>
    `;

    // Inject into SillyTavern's extension panel area
    const container =
        document.getElementById('extensions_settings2') ||  // Newer ST
        document.getElementById('extensions_settings') ||   // Older ST
        document.querySelector('#top-settings-holder');      // Fallback

    if (container) {
        const wrapper = document.createElement('div');
        wrapper.classList.add('extension_container');
        wrapper.appendChild(panel);
        container.appendChild(wrapper);
    } else {
        // Absolute fallback — attach to body
        document.body.appendChild(panel);
    }
}

// ─── Rendering ──────────────────────────────────────────────────────────────────

/**
 * Update the panel with current state. Called after every commit.
 * @param {import('./state-compute.js').ComputedState} state
 * @param {number} turn - Current turn counter
 */
function updatePanel(state, turn) {
    if (!document.getElementById(PANEL_ID)) createPanel();

    const foldersEl = document.getElementById('gl-folders');
    if (!foldersEl) return;

    // Preserve open/closed state of folders
    const openFolders = new Set();
    foldersEl.querySelectorAll('.gl-folder.open').forEach(el => {
        openFolders.add(el.dataset.folder);
    });

    // Build folders
    const folders = [];

    // Characters
    const chars = Object.values(state.characters).filter(c => c.tier !== 'UNKNOWN');
    folders.push(buildFolder('characters', 'Characters', chars.length, () =>
        chars.length === 0
            ? empty('No characters')
            : chars.map(c => charItem(c, state)).join('')
    ));

    // Constraints
    const constraints = Object.values(state.constraints);
    folders.push(buildFolder('constraints', 'Constraints', constraints.length, () =>
        constraints.length === 0
            ? empty('No constraints')
            : constraints.map(c => constraintItem(c, state)).join('')
    ));

    // Collisions
    const collisions = Object.values(state.collisions).filter(c => c.status !== 'RESOLVED');
    folders.push(buildFolder('collisions', 'Collisions', collisions.length, () =>
        collisions.length === 0
            ? empty('No active collisions')
            : collisions.map(c => collisionItem(c)).join('')
    ));

    // Chapters
    const chapters = Object.values(state.chapters);
    const openCh = chapters.filter(ch => ch.status !== 'CLOSED');
    folders.push(buildFolder('chapters', 'Chapters', openCh.length, () =>
        chapters.length === 0
            ? empty('No chapters')
            : chapters.map(ch => chapterItem(ch)).join('')
    ));

    // World
    const worldKeys = countWorldKeys(state.world);
    folders.push(buildFolder('world', 'World', worldKeys, () =>
        worldContent(state.world)
    ));

    // PC
    folders.push(buildFolder('pc', 'PC', state.pc.name ? 1 : 0, () =>
        pcContent(state.pc)
    ));

    foldersEl.innerHTML = folders.join('');

    // Restore open state
    foldersEl.querySelectorAll('.gl-folder').forEach(el => {
        if (openFolders.has(el.dataset.folder)) {
            el.classList.add('open');
        }
    });

    // Bind toggle handlers
    foldersEl.querySelectorAll('.gl-folder-head').forEach(head => {
        head.addEventListener('click', () => {
            head.parentElement.classList.toggle('open');
        });
    });

    // Update footer
    const statusEl = document.getElementById('gl-status');
    const turnEl = document.getElementById('gl-turn');
    const txEl = document.getElementById('gl-tx');
    if (statusEl) statusEl.textContent = 'active';
    if (turnEl) turnEl.textContent = `Turn ${turn}`;
    if (txEl) txEl.textContent = `TX ${state.lastTxId ?? 0}`;
}

// ─── Folder Builder ─────────────────────────────────────────────────────────────

function buildFolder(key, label, count, contentFn) {
    return `
        <div class="gl-folder" data-folder="${key}">
            <div class="gl-folder-head">
                <span class="gl-folder-arrow">▶</span>
                <span class="gl-folder-label">${label}</span>
                <span class="gl-folder-badge">${count}</span>
            </div>
            <div class="gl-folder-body">${contentFn()}</div>
        </div>`;
}

function empty(text) {
    return `<div class="gl-empty">${text}</div>`;
}

function badge(value) {
    return `<span class="gl-badge gl-badge-${esc(value)}">${esc(value)}</span>`;
}

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Item Renderers ─────────────────────────────────────────────────────────────

function charItem(char, state) {
    const constraints = Object.values(state.constraints)
        .filter(c => c.owner_id === char.id)
        .map(c => `${esc(c.name)} [${esc(c.integrity)}]`)
        .join(', ');
    const doing = char.doing ? `<div class="gl-item-detail">DO: ${esc(char.doing)}</div>` : '';
    const conStr = constraints ? `<div class="gl-item-detail">${constraints}</div>` : '';
    return `
        <div class="gl-item">
            <span class="gl-item-name">${esc(char.name || char.id)}</span>
            ${badge(char.tier)}
            <span class="gl-item-id">${esc(char.id)}</span>
            ${doing}${conStr}
        </div>`;
}

function constraintItem(c, state) {
    const owner = state.characters[c.owner_id];
    const ownerName = owner?.name || c.owner_id || '?';
    const prevents = c.prevents ? `<div class="gl-item-detail">Prevents: ${esc(c.prevents)}</div>` : '';
    const breach = c.integrity === 'BREACHED' && c.replacement
        ? `<div class="gl-item-detail">→ ${esc(c.replacement)} (${esc(c.replacement_type)})</div>`
        : '';
    return `
        <div class="gl-item">
            <span class="gl-item-name">${esc(c.name || c.id)}</span>
            ${badge(c.integrity)}
            <span class="gl-item-id">${esc(ownerName)} · ${esc(c.id)}</span>
            ${prevents}${breach}
        </div>`;
}

function collisionItem(col) {
    const forces = (col.forces || []).map(f => esc(f.name || f)).join(' → ');
    const dist = col.distance != null ? `dist: ${col.distance}` : '';
    const cost = col.cost ? `<div class="gl-item-detail">Cost: ${esc(col.cost)}</div>` : '';
    return `
        <div class="gl-item">
            <span class="gl-item-name">⊕ ${esc(col.name || col.id)}</span>
            ${badge(col.status)}
            <span class="gl-item-id">${esc(col.id)}</span>
            <div class="gl-item-detail">${forces}${forces && dist ? ' · ' : ''}${dist}</div>
            ${cost}
        </div>`;
}

function chapterItem(ch) {
    const title = ch.title || ch.focus || '?';
    const arc = ch.arc ? `<div class="gl-item-detail">Arc: ${esc(ch.arc)}</div>` : '';
    const tension = ch.central_tension ? `<div class="gl-item-detail">Tension: ${esc(ch.central_tension)}</div>` : '';
    return `
        <div class="gl-item">
            <span class="gl-item-name">Ch${ch.number || '?'} "${esc(title)}"</span>
            ${badge(ch.status)}
            <span class="gl-item-id">${esc(ch.id)}</span>
            ${arc}${tension}
        </div>`;
}

function worldContent(world) {
    const parts = [];

    if (world.world_state) {
        parts.push(`<div class="gl-item"><span class="gl-item-name">State</span><div class="gl-item-detail">${esc(world.world_state)}</div></div>`);
    }

    const c = world.constants || {};
    if (Object.keys(c).length) {
        const bits = [];
        if (c.role) bits.push(`Role: ${esc(c.role)}`);
        if (c.voice) bits.push(`Voice: ${esc(c.voice)}`);
        if (c.tone) bits.push(`Tone: ${esc(c.tone)}`);
        if (bits.length) {
            parts.push(`<div class="gl-item"><span class="gl-item-name">Constants</span><div class="gl-item-detail">${bits.join(' · ')}</div></div>`);
        }
    }

    if (world.factions?.length) {
        for (const f of world.factions) {
            parts.push(`<div class="gl-item"><span class="gl-item-name">${esc(f.name)}</span><div class="gl-item-detail">${esc(f.objective || '')}${f.stance_toward_pc ? ' · Stance: ' + esc(f.stance_toward_pc) : ''}</div></div>`);
        }
    }

    if (world.pressure_points?.length) {
        parts.push(`<div class="gl-item"><span class="gl-item-name">Pressure Points</span><div class="gl-item-detail">${world.pressure_points.map(p => esc(p)).join('<br>')}</div></div>`);
    }

    return parts.length ? parts.join('') : empty('No world data');
}

function pcContent(pc) {
    if (!pc.name) return empty('PC not initialized');

    const parts = [];
    parts.push(`<div class="gl-item"><span class="gl-item-name">${esc(pc.name)}</span></div>`);

    if (pc.demonstrated_traits?.length) {
        parts.push(`<div class="gl-item"><span class="gl-item-detail">Traits: ${pc.demonstrated_traits.map(t => esc(t)).join(', ')}</span></div>`);
    }

    if (Object.keys(pc.reputation || {}).length) {
        const reps = Object.entries(pc.reputation).map(([who, rep]) => `${esc(who)}: ${esc(rep)}`).join('<br>');
        parts.push(`<div class="gl-item"><span class="gl-item-name">Reputation</span><div class="gl-item-detail">${reps}</div></div>`);
    }

    return parts.join('');
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function countWorldKeys(world) {
    let n = 0;
    if (world.world_state) n++;
    if (Object.keys(world.constants || {}).length) n++;
    if (world.factions?.length) n += world.factions.length;
    if (world.pressure_points?.length) n++;
    return n;
}

// ─── CSS Loader ─────────────────────────────────────────────────────────────────

/**
 * Load the panel stylesheet. Called once on init.
 * @param {string} extensionPath - Base path of the extension
 */
function loadStyles(extensionPath) {
    if (document.getElementById('gravity-ledger-styles')) return;

    const link = document.createElement('link');
    link.id = 'gravity-ledger-styles';
    link.rel = 'stylesheet';
    link.href = `${extensionPath}/style.css`;
    document.head.appendChild(link);
}

export {
    createPanel,
    updatePanel,
    loadStyles,
    PANEL_ID,
};
