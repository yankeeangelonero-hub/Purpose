/**
 * ui-panel.js — Floating popup panel for Gravity Ledger.
 *
 * Renders the current computed state as collapsible folders in a draggable
 * popup window. Toggle button is added to the extensions wand menu.
 */

import { listWorldInfoBooks, loadWorldInfoBook, saveWorldInfoBook } from './lorebook-api.js';

const PANEL_ID = 'gravity-ledger-panel';
const TOGGLE_ID = 'gravity-ledger-toggle';

// Callbacks set by index.js
let _onLoadBook = null;
let _onNewBook = null;

function setCallbacks({ onLoadBook, onNewBook }) {
    _onLoadBook = onLoadBook;
    _onNewBook = onNewBook;
}

// ─── Panel Scaffold ─────────────────────────────────────────────────────────────

function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    // Toggle button in the wand menu
    const extensionsMenu = document.getElementById('extensionsMenu');
    if (extensionsMenu) {
        const toggleBtn = document.createElement('div');
        toggleBtn.id = TOGGLE_ID;
        toggleBtn.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
        toggleBtn.tabIndex = 0;
        toggleBtn.innerHTML = '<i class="fa-solid fa-book"></i> Gravity Ledger';
        toggleBtn.addEventListener('click', () => {
            const panel = document.getElementById(PANEL_ID);
            if (panel) panel.classList.toggle('gl-hidden');
        });
        extensionsMenu.appendChild(toggleBtn);
    }

    // Floating popup panel
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.classList.add('gl-hidden');
    panel.innerHTML = `
        <div class="gl-popup-header" id="gl-drag-handle">
            <span class="gl-popup-title">Gravity Ledger</span>
            <span class="gl-status" id="gl-status">not initialized</span>
            <button class="gl-popup-close" id="gl-close-btn" title="Close">&times;</button>
        </div>
        <div class="gl-toolbar">
            <select class="gl-book-select" id="gl-book-select" title="Select lorebook">
                <option value="">-- Select Lorebook --</option>
            </select>
            <button class="gl-toolbar-btn gl-toolbar-btn-icon" id="gl-btn-refresh" title="Refresh list">
                <i class="fa-solid fa-sync"></i>
            </button>
            <button class="gl-toolbar-btn gl-toolbar-btn-icon" id="gl-btn-new" title="Create new lorebook">
                <i class="fa-solid fa-plus"></i>
            </button>
            <button class="gl-toolbar-btn gl-toolbar-btn-icon" id="gl-btn-export" title="Export lorebook as JSON">
                <i class="fa-solid fa-download"></i>
            </button>
            <button class="gl-toolbar-btn gl-toolbar-btn-icon" id="gl-btn-import" title="Import lorebook from JSON">
                <i class="fa-solid fa-upload"></i>
            </button>
        </div>
        <div class="gl-popup-body">
            <div id="gl-folders"></div>
        </div>
        <div class="gl-footer">
            <span id="gl-turn">Turn 0</span>
            <span id="gl-tx">TX 0</span>
        </div>
    `;
    document.body.appendChild(panel);

    // Close button
    document.getElementById('gl-close-btn').addEventListener('click', () => {
        panel.classList.add('gl-hidden');
    });

    // Toolbar buttons
    document.getElementById('gl-book-select').addEventListener('change', handleSelectChange);
    document.getElementById('gl-btn-refresh').addEventListener('click', refreshBookList);
    document.getElementById('gl-btn-new').addEventListener('click', handleNew);
    document.getElementById('gl-btn-export').addEventListener('click', handleExport);
    document.getElementById('gl-btn-import').addEventListener('click', handleImport);

    // Populate dropdown on first open
    refreshBookList();

    // Dragging
    initDrag(panel, document.getElementById('gl-drag-handle'));

    console.log('[GravityLedger] Popup panel created.');
}

// ─── Toolbar Handlers ───────────────────────────────────────────────────────────

async function refreshBookList() {
    const select = document.getElementById('gl-book-select');
    if (!select) return;

    const currentValue = select.dataset.current || '';

    try {
        const books = await listWorldInfoBooks();
        const gravityBooks = books.filter(b =>
            b.file_id?.startsWith('Gravity_Ledger') || b.name?.startsWith('Gravity_Ledger')
        );

        select.innerHTML = '<option value="">-- Select Lorebook --</option>';
        for (const b of gravityBooks) {
            const name = b.file_id || b.name;
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === currentValue) opt.selected = true;
            select.appendChild(opt);
        }
    } catch (err) {
        console.error('[GravityLedger] Failed to refresh book list:', err);
    }
}

async function handleSelectChange(e) {
    const bookName = e.target.value;
    if (!bookName) return;

    const select = document.getElementById('gl-book-select');
    if (select) select.dataset.current = bookName;

    if (_onLoadBook) {
        try {
            await _onLoadBook(bookName);
            toastr.success(`Loaded: ${bookName}`);
        } catch (err) {
            toastr.error('Failed to load: ' + err.message);
        }
    }
}

async function handleNew() {
    try {
        const { Popup } = SillyTavern.getContext();
        const chatId = SillyTavern.getContext().chatId || 'default';
        const suggested = `Gravity_Ledger_${chatId}`;

        const name = await Popup.show.input(
            'Create New Gravity Ledger',
            'Enter a name for the new lorebook:',
            suggested,
        );

        if (!name) return;

        await saveWorldInfoBook(name, { entries: {} });

        if (_onNewBook) {
            await _onNewBook(name);
        }

        await refreshBookList();
        setBookName(name);
        toastr.success(`Created: ${name}`);
    } catch (err) {
        console.error('[GravityLedger] Create failed:', err);
        toastr.error('Failed to create lorebook: ' + err.message);
    }
}

async function handleExport() {
    try {
        const select = document.getElementById('gl-book-select');
        const bookName = select?.dataset?.current;

        if (!bookName) {
            toastr.warning('No lorebook loaded to export.');
            return;
        }

        const book = await loadWorldInfoBook(bookName);
        const json = JSON.stringify(book, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `${bookName}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toastr.success(`Exported: ${bookName}`);
    } catch (err) {
        console.error('[GravityLedger] Export failed:', err);
        toastr.error('Failed to export: ' + err.message);
    }
}

async function handleImport() {
    try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;

            const text = await file.text();
            const data = JSON.parse(text);

            if (!data.entries || typeof data.entries !== 'object') {
                toastr.error('Invalid lorebook file — missing entries.');
                return;
            }

            const name = file.name.replace(/\.json$/, '');
            const { Popup } = SillyTavern.getContext();
            const finalName = await Popup.show.input(
                'Import Gravity Ledger',
                'Save imported lorebook as:',
                name,
            );

            if (!finalName) return;

            await saveWorldInfoBook(finalName, data);

            if (_onLoadBook) {
                await _onLoadBook(finalName);
            }

            await refreshBookList();
            setBookName(finalName);
            toastr.success(`Imported: ${finalName}`);
        });

        input.click();
    } catch (err) {
        console.error('[GravityLedger] Import failed:', err);
        toastr.error('Failed to import: ' + err.message);
    }
}

// ─── Book Name Display ──────────────────────────────────────────────────────────

function setBookName(name) {
    const select = document.getElementById('gl-book-select');
    if (select) {
        select.dataset.current = name || '';
        // Select the matching option if it exists
        for (const opt of select.options) {
            opt.selected = opt.value === (name || '');
        }
    }
}

// ─── Drag Logic ─────────────────────────────────────────────────────────────────

function initDrag(panel, handle) {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('.gl-popup-close')) return;
        isDragging = true;
        offsetX = e.clientX - panel.offsetLeft;
        offsetY = e.clientY - panel.offsetTop;
        panel.style.transition = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panel.style.left = (e.clientX - offsetX) + 'px';
        panel.style.top = (e.clientY - offsetY) + 'px';
        panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        panel.style.transition = '';
    });
}

// ─── Rendering ──────────────────────────────────────────────────────────────────

function updatePanel(state, turn) {
    if (!document.getElementById(PANEL_ID)) createPanel();

    const foldersEl = document.getElementById('gl-folders');
    if (!foldersEl) return;

    if (!state) {
        foldersEl.innerHTML = empty('No active chat');
        const statusEl = document.getElementById('gl-status');
        if (statusEl) statusEl.textContent = 'no chat';
        return;
    }

    // Preserve open/closed state
    const openFolders = new Set();
    foldersEl.querySelectorAll('.gl-folder.open').forEach(el => {
        openFolders.add(el.dataset.folder);
    });

    const folders = [];

    const chars = Object.values(state.characters).filter(c => c.tier !== 'UNKNOWN');
    folders.push(buildFolder('characters', 'Characters', chars.length, () =>
        chars.length === 0 ? empty('No characters') : chars.map(c => charItem(c, state)).join('')
    ));

    const constraints = Object.values(state.constraints);
    folders.push(buildFolder('constraints', 'Constraints', constraints.length, () =>
        constraints.length === 0 ? empty('No constraints') : constraints.map(c => constraintItem(c, state)).join('')
    ));

    const collisions = Object.values(state.collisions).filter(c => c.status !== 'RESOLVED');
    folders.push(buildFolder('collisions', 'Collisions', collisions.length, () =>
        collisions.length === 0 ? empty('No active collisions') : collisions.map(c => collisionItem(c)).join('')
    ));

    const chapters = Object.values(state.chapters);
    const openCh = chapters.filter(ch => ch.status !== 'CLOSED');
    folders.push(buildFolder('chapters', 'Chapters', openCh.length, () =>
        chapters.length === 0 ? empty('No chapters') : chapters.map(ch => chapterItem(ch)).join('')
    ));

    const worldKeys = countWorldKeys(state.world);
    folders.push(buildFolder('world', 'World', worldKeys, () => worldContent(state.world)));
    folders.push(buildFolder('pc', 'PC', state.pc.name ? 1 : 0, () => pcContent(state.pc)));

    foldersEl.innerHTML = folders.join('');

    foldersEl.querySelectorAll('.gl-folder').forEach(el => {
        if (openFolders.has(el.dataset.folder)) el.classList.add('open');
    });

    foldersEl.querySelectorAll('.gl-folder-head').forEach(head => {
        head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
    });

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
                <span class="gl-folder-arrow">&#9654;</span>
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
        ? `<div class="gl-item-detail">--> ${esc(c.replacement)} (${esc(c.replacement_type)})</div>`
        : '';
    return `
        <div class="gl-item">
            <span class="gl-item-name">${esc(c.name || c.id)}</span>
            ${badge(c.integrity)}
            <span class="gl-item-id">${esc(ownerName)} | ${esc(c.id)}</span>
            ${prevents}${breach}
        </div>`;
}

function collisionItem(col) {
    const forces = (col.forces || []).map(f => esc(f.name || f)).join(' vs ');
    const dist = col.distance != null ? `dist: ${col.distance}` : '';
    const cost = col.cost ? `<div class="gl-item-detail">Cost: ${esc(col.cost)}</div>` : '';
    return `
        <div class="gl-item">
            <span class="gl-item-name">${esc(col.name || col.id)}</span>
            ${badge(col.status)}
            <span class="gl-item-id">${esc(col.id)}</span>
            <div class="gl-item-detail">${forces}${forces && dist ? ' | ' : ''}${dist}</div>
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
            parts.push(`<div class="gl-item"><span class="gl-item-name">Constants</span><div class="gl-item-detail">${bits.join(' | ')}</div></div>`);
        }
    }
    if (world.factions?.length) {
        for (const f of world.factions) {
            parts.push(`<div class="gl-item"><span class="gl-item-name">${esc(f.name)}</span><div class="gl-item-detail">${esc(f.objective || '')}${f.stance_toward_pc ? ' | Stance: ' + esc(f.stance_toward_pc) : ''}</div></div>`);
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

function countWorldKeys(world) {
    let n = 0;
    if (world.world_state) n++;
    if (Object.keys(world.constants || {}).length) n++;
    if (world.factions?.length) n += world.factions.length;
    if (world.pressure_points?.length) n++;
    return n;
}

export {
    createPanel,
    updatePanel,
    setCallbacks,
    setBookName,
    PANEL_ID,
};
