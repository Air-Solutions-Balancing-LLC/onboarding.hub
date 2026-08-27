/**
 * Atlas-style Hub chrome: collapsible sidebar and sortable tables.
 */
(function (root) {
  const STORAGE_KEY = 'hub-sidebar-collapsed';
  const savedSort = {};

  function initials(name, email) {
    const source = String(name || email || '').trim();
    if (!source) return '?';
    const parts = source.split(/[\s@._-]+/).filter(Boolean);
    const letters = (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
    return letters.toUpperCase() || source.slice(0, 2).toUpperCase();
  }

  function isCollapsedPref() {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setSidebarCollapsed(collapsed) {
    document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    } catch (e) { /* ignore */ }
    const btn = document.getElementById('sidebarToggle');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
      btn.title = collapsed ? 'Expand navigation' : 'Collapse navigation';
    }
  }

  function initSidebar() {
    const sidebar = document.querySelector('aside.sidebar');
    if (!sidebar) return;
    if (sidebar.dataset.collapseBound === '1') {
      setSidebarCollapsed(isCollapsedPref());
      return;
    }
    sidebar.dataset.collapseBound = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'sidebarToggle';
    btn.className = 'sidebar-toggle';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';
    btn.addEventListener('click', function () {
      setSidebarCollapsed(!document.documentElement.classList.contains('sidebar-collapsed'));
    });
    sidebar.insertBefore(btn, sidebar.firstChild);
    setSidebarCollapsed(isCollapsedPref());
  }

  function fillUserProfile(user) {
    const nameEl = document.querySelector('.user-profile .user-info .name');
    const roleEl = document.querySelector('.user-profile .user-info .role');
    const avatarEl = document.querySelector('.user-profile .avatar');
    if (!user) return;
    const labeler = root.HubAccess && root.HubAccess.roleLabel;
    const roleText = labeler ? labeler(user.role) : String(user.role || '');
    if (nameEl) nameEl.textContent = user.full_name || user.email || '';
    if (roleEl) {
      roleEl.textContent =
        user.realRole === 'admin' && user.role !== 'admin'
          ? 'Admin · as ' + roleText
          : roleText;
    }
    if (avatarEl) avatarEl.textContent = initials(user.full_name, user.email);
  }

  function cellSortValue(td) {
    if (!td) return '';
    const select = td.querySelector('select');
    if (select) {
      const opt = select.options[select.selectedIndex];
      return String(opt ? opt.text : select.value || '').trim();
    }
    const btn = td.querySelector('button');
    if (btn) return String(btn.textContent || '').trim();
    const span = td.querySelector('.nh-pct');
    if (span) return String(span.textContent || '').trim();
    return String(td.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function compareValues(a, b) {
    const sa = String(a || '');
    const sb = String(b || '');
    const dateA = /^\d{4}-\d{2}-\d{2}/.test(sa);
    const dateB = /^\d{4}-\d{2}-\d{2}/.test(sb);
    if (dateA && dateB) return sa.localeCompare(sb);
    const fracA = sa.match(/^(\d+)\s*\/\s*(\d+)$/);
    const fracB = sb.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (fracA && fracB) {
      const pa = Number(fracA[2]) ? Number(fracA[1]) / Number(fracA[2]) : 0;
      const pb = Number(fracB[2]) ? Number(fracB[1]) / Number(fracB[2]) : 0;
      if (pa !== pb) return pa - pb;
    }
    return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
  }

  function ensureIndicator(th) {
    let span = th.querySelector('.sort-ind');
    if (!span) {
      span = document.createElement('span');
      span.className = 'sort-ind';
      th.appendChild(span);
    }
    return span;
  }

  function applySort(table, colIndex, dir) {
    const tbody = table.tBodies[0];
    if (!tbody) return;
    const headerRow = table.tHead && table.tHead.rows[0];
    if (!headerRow) return;
    [...headerRow.cells].forEach((el) => {
      el.removeAttribute('data-sort-dir');
      el.classList.remove('sorted-asc', 'sorted-desc');
      const ind = el.querySelector('.sort-ind');
      if (ind) ind.textContent = '';
    });
    const th = headerRow.cells[colIndex];
    if (!th) return;
    th.setAttribute('data-sort-dir', dir);
    th.classList.add(dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    ensureIndicator(th).textContent = dir === 'asc' ? ' ↑' : ' ↓';

    const rows = [...tbody.rows];
    const empty = rows.filter((r) => r.querySelector('.nh-empty'));
    const dataRows = rows.filter((r) => !r.querySelector('.nh-empty'));
    dataRows.sort((a, b) => {
      const cmp = compareValues(cellSortValue(a.cells[colIndex]), cellSortValue(b.cells[colIndex]));
      return dir === 'asc' ? cmp : -cmp;
    });
    dataRows.concat(empty).forEach((r) => tbody.appendChild(r));

    const key = table.getAttribute('data-sort-key');
    if (key) savedSort[key] = { col: colIndex, dir };
    syncStickyOffsets(table);
  }

  function syncStickyOffsets(table) {
    if (!table || !table.classList.contains('nh-sheet')) return;
    const headerRow = table.tHead && table.tHead.rows[0];
    if (!headerRow) return;
    const first = headerRow.querySelector('.nh-sticky:not(.nh-sticky-2)');
    if (!first) return;
    const apply = () => {
      const width = Math.round(first.getBoundingClientRect().width);
      if (width > 0) table.style.setProperty('--nh-sticky-2-left', width + 'px');
      const row0 = headerRow.getBoundingClientRect().height;
      const row1 = table.tHead.rows[1] ? table.tHead.rows[1].getBoundingClientRect().height : 0;
      if (row0 > 0) table.style.setProperty('--nh-sticky-top-1', Math.round(row0) + 'px');
      if (row0 + row1 > 0) table.style.setProperty('--nh-sticky-top-2', Math.round(row0 + row1) + 'px');
    };
    apply();
    requestAnimationFrame(apply);
  }

  function bindSortableTable(table) {
    const headerRow = table.tHead && table.tHead.rows[0];
    if (!headerRow || headerRow.dataset.sortBound === '1') return;
    headerRow.dataset.sortBound = '1';
    [...headerRow.cells].forEach((th, colIndex) => {
      if (th.colSpan > 1) return;
      if (th.classList.contains('no-sort')) return;
      const label = String(th.textContent || '').replace(/[↑↓]\s*$/, '').trim();
      if (!label) return;
      th.classList.add('sortable');
      th.setAttribute('role', 'columnheader');
      th.tabIndex = 0;
      const onSort = () => {
        const next = th.getAttribute('data-sort-dir') === 'asc' ? 'desc' : 'asc';
        applySort(table, colIndex, next);
      };
      th.addEventListener('click', onSort);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort();
        }
      });
    });
  }

  function enhanceTables(scope) {
    const root = scope || document;
    root.querySelectorAll('table.nh-table, table.nh-sheet, table.data-table').forEach((table) => {
      bindSortableTable(table);
      const key = table.getAttribute('data-sort-key');
      const saved = key ? savedSort[key] : null;
      if (saved) applySort(table, saved.col, saved.dir);
      else syncStickyOffsets(table);
    });
  }

  function placeFixedPopup(el, anchor, opts) {
    if (!el || !anchor) return;
    opts = opts || {};
    const pad = opts.pad == null ? 8 : opts.pad;
    const gap = opts.gap == null ? 6 : opts.gap;
    const prefer = opts.prefer || 'below';
    const rect = typeof anchor.getBoundingClientRect === 'function'
      ? anchor.getBoundingClientRect()
      : anchor;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    el.style.position = 'fixed';
    el.style.maxHeight = '';
    el.style.maxWidth = '';
    el.style.top = '0px';
    el.style.left = '0px';

    const naturalH = el.scrollHeight;
    const naturalW = Math.max(el.offsetWidth, el.scrollWidth);

    let top = pad;
    let left = pad;

    if (prefer === 'right') {
      const spaceRight = vw - rect.right - pad - gap;
      const spaceLeft = rect.left - pad - gap;
      const placeRight = spaceRight >= Math.min(naturalW, 160) || spaceRight >= spaceLeft;
      const maxW = Math.max(120, placeRight ? spaceRight : spaceLeft);
      if (naturalW > maxW) el.style.maxWidth = Math.round(maxW) + 'px';
      const w = Math.min(el.offsetWidth, maxW);
      left = placeRight ? rect.right + gap : rect.left - gap - w;
      const maxH = Math.max(96, vh - pad * 2);
      if (naturalH > maxH) el.style.maxHeight = Math.round(maxH) + 'px';
      const h = Math.min(naturalH, maxH);
      top = rect.top;
      if (top + h > vh - pad) top = vh - pad - h;
    } else {
      const spaceBelow = vh - rect.bottom - pad - gap;
      const spaceAbove = rect.top - pad - gap;
      let placeBelow = true;
      if (spaceBelow >= naturalH) placeBelow = true;
      else if (spaceAbove >= naturalH) placeBelow = false;
      else placeBelow = spaceBelow >= spaceAbove;
      const maxH = Math.min(opts.maxHeight || 420, Math.max(96, placeBelow ? spaceBelow : spaceAbove));
      el.style.maxHeight = Math.round(maxH) + 'px';
      const h = Math.min(naturalH, maxH);
      top = placeBelow ? rect.bottom + gap : rect.top - gap - h;
      const maxW = vw - pad * 2;
      if (naturalW > maxW) el.style.maxWidth = Math.round(maxW) + 'px';
      const w = Math.min(el.offsetWidth, maxW);
      left = rect.left;
      if (left + w > vw - pad) left = vw - pad - w;
    }

    if (top < pad) top = pad;
    if (left < pad) left = pad;
    el.style.top = Math.round(top) + 'px';
    el.style.left = Math.round(left) + 'px';
  }

  root.HubShell = {
    initSidebar,
    fillUserProfile,
    enhanceTables,
    syncStickyOffsets,
    placeFixedPopup,
  };
})(typeof window !== 'undefined' ? window : globalThis);
