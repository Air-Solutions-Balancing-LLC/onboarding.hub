// New Hire Checklist — role-based tasks, typed fields, My To-Do with due dates
(function () {
  const STORAGE_KEY = 'new_hire_checklist';
  const ROLE_PREF_KEY = 'nh_role_pref';
  const PERSON_PREF_KEY = 'nh_person_pref';

  let data = null;
  let view = 'todo'; // todo | list | detail | template
  let selectedHireId = null;
  let openSections = {};
  let filters = { q: '', status: 'active', role: 'HR', person: 'all', todoScope: 'open' };
  let revealSensitive = false;
  let saveTimer = null;

  function seed() {
    const s = window.NEW_HIRE_SEED;
    if (!s) return { version: 2, roles: [], sections: [], items: [], hires: [] };
    return JSON.parse(JSON.stringify(s));
  }

  function migrate(raw) {
    const base = seed();
    if (!raw || !Array.isArray(raw.hires)) return base;
    // Force spreadsheet-derived typed metadata from seed (v2 upgrade)
    const forceMeta = !raw.version || raw.version < 2;
    const byId = {};
    (raw.items || []).forEach((i) => { byId[i.id] = i; });
    const items = (base.items || []).map((bi) => {
      const old = byId[bi.id];
      if (!old) return bi;
      if (forceMeta) {
        return Object.assign({}, bi, {
          label: old.label || bi.label,
          // keep values via hire.values; template meta from seed
        });
      }
      return Object.assign({}, bi, {
        label: old.label || bi.label,
        owner: old.owner || bi.owner,
        role: old.role || bi.role,
        assignee: old.assignee || bi.assignee,
        inputType: old.inputType || bi.inputType,
        options: old.options && old.options.length ? old.options : bi.options,
        dueOffsetDays: old.dueOffsetDays != null ? old.dueOffsetDays : bi.dueOffsetDays,
        dueAnchor: old.dueAnchor || bi.dueAnchor,
        sensitive: old.sensitive != null ? old.sensitive : bi.sensitive,
        order: old.order != null ? old.order : bi.order,
        sectionId: old.sectionId || bi.sectionId
      });
    });
    (raw.items || []).forEach((oi) => {
      if (!items.find((i) => i.id === oi.id) && oi.id && String(oi.id).startsWith('t') && oi.label) {
        // only keep truly custom post-seed tasks
        if (!base.items.find((b) => b.id === oi.id) && oi.role) {
          items.push(Object.assign({
            role: 'HR', assignee: 'Lisa', inputType: 'text', options: [],
            dueOffsetDays: -7, dueAnchor: 'start', sensitive: false, order: items.length + 1
          }, oi));
        }
      }
    });
    const hires = (raw.hires || []).map((h) => Object.assign({}, h, {
      assignees: h.assignees || {},
      values: h.values || {}
    }));
    const migrated = {
      version: 2,
      roles: base.roles,
      sections: base.sections,
      items,
      hires
    };
    // Persist upgrade so all teammates get typed fields
    if (forceMeta && window.HubAuth && HubAuth.save) {
      setTimeout(() => HubAuth.save(STORAGE_KEY, migrated), 500);
    }
    return migrated;
  }

  function ensureData() {
    if (!data) data = seed();
    if (!Array.isArray(data.roles)) data.roles = seed().roles || [];
    if (!Array.isArray(data.sections)) data.sections = seed().sections || [];
    if (!Array.isArray(data.items)) data.items = [];
    if (!Array.isArray(data.hires)) data.hires = [];
  }

  function persist() {
    ensureData();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.HubAuth && HubAuth.save) HubAuth.save(STORAGE_KEY, data);
    }, 250);
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseDate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }

  function fmtDate(d) {
    if (!d || isNaN(d)) return '—';
    return d.toISOString().slice(0, 10);
  }

  function addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  function dueDateFor(hire, item) {
    const anchor = item.dueAnchor === 'bootcamp' ? (parseDate(hire.bootcampDate) || parseDate(hire.startDate)) : parseDate(hire.startDate);
    if (!anchor) return null;
    return addDays(anchor, item.dueOffsetDays || 0);
  }

  function isFilled(item, val) {
    if (item.inputType === 'checkbox') return val === true || val === 'true' || val === 'Yes' || val === 1;
    const v = String(val ?? '').trim();
    if (!v) return false;
    if (/^(n\/a|na|—|-|pending|not yet|tbd)$/i.test(v)) return false;
    return true;
  }

  function assigneeOf(hire, item) {
    return (hire.assignees && hire.assignees[item.id]) || item.assignee || item.owner || '';
  }

  function peopleForRole(roleId) {
    const r = (data.roles || []).find((x) => x.id === roleId);
    const base = r ? r.people.slice() : [];
    data.items.forEach((i) => {
      if (i.role === roleId && i.assignee && !base.includes(i.assignee)) base.push(i.assignee);
    });
    data.hires.forEach((h) => {
      Object.values(h.assignees || {}).forEach((p) => {
        if (p && !base.includes(p)) {/* keep global later */}
      });
    });
    if (roleId === 'PM') {
      data.hires.forEach((h) => {
        const pmItem = data.items.find((i) => /Assigned Project Manager/i.test(i.label));
        const pm = pmItem && h.values?.[pmItem.id];
        if (pm && !base.includes(pm)) base.push(String(pm));
      });
    }
    return base.filter(Boolean);
  }

  function itemsForSection(sectionId) {
    return data.items.filter((i) => i.sectionId === sectionId).sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function hireProgress(hire, roleFilter) {
    let items = data.items;
    if (roleFilter && roleFilter !== 'all') items = items.filter((i) => i.role === roleFilter);
    const total = items.length;
    let done = 0;
    items.forEach((it) => { if (isFilled(it, hire.values?.[it.id])) done++; });
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function todoEntries() {
    ensureData();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const week = addDays(today, 7);
    const out = [];
    data.hires.filter((h) => h.status === 'active').forEach((hire) => {
      data.items.forEach((item) => {
        if (filters.role !== 'all' && item.role !== filters.role) return;
        const who = assigneeOf(hire, item);
        if (filters.person !== 'all' && who !== filters.person) return;
        const done = isFilled(item, hire.values?.[item.id]);
        if (filters.todoScope === 'open' && done) return;
        if (filters.todoScope === 'done' && !done) return;
        const due = dueDateFor(hire, item);
        let bucket = 'nodate';
        if (due) {
          if (due < today && !done) bucket = 'overdue';
          else if (due <= week) bucket = 'week';
          else bucket = 'later';
        }
        if (filters.todoScope === 'overdue' && bucket !== 'overdue') return;
        if (filters.todoScope === 'week' && bucket !== 'week' && bucket !== 'overdue') return;
        out.push({ hire, item, who, due, done, bucket });
      });
    });
    out.sort((a, b) => {
      const ad = a.due ? a.due.getTime() : Infinity;
      const bd = b.due ? b.due.getTime() : Infinity;
      if (ad !== bd) return ad - bd;
      return a.hire.name.localeCompare(b.hire.name) || a.item.label.localeCompare(b.item.label);
    });
    return out;
  }

  window.NewHireChecklist = {
    applyRemote(value) {
      data = migrate(value);
      ensureData();
      const role = localStorage.getItem(ROLE_PREF_KEY);
      const person = localStorage.getItem(PERSON_PREF_KEY);
      if (role) filters.role = role;
      if (person) filters.person = person;
      data.sections.forEach((s, i) => {
        if (openSections[s.id] === undefined) openSections[s.id] = i < 2;
      });
    },
    render() {
      ensureData();
      const root = document.getElementById('nh-root');
      if (!root) return;
      if (view === 'detail' && selectedHireId) renderDetail(root);
      else if (view === 'template') renderTemplate(root);
      else if (view === 'archive') renderArchive(root);
      else if (view === 'list') renderList(root);
      else renderTodo(root);
    }
  };

  function roleBar() {
    const roles = data.roles || [];
    const people = peopleForRole(filters.role);
    return `
      <div class="nh-rolebar">
        <div class="nh-rolebar-left">
          <label class="nh-check-label">My role
            <select id="nh-role" class="form-input" style="width:140px;margin-left:6px">
              ${roles.map((r) => `<option value="${esc(r.id)}" ${filters.role === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
              <option value="all" ${filters.role === 'all' ? 'selected' : ''}>All roles</option>
            </select>
          </label>
          <label class="nh-check-label">Person
            <select id="nh-person" class="form-input" style="width:150px;margin-left:6px">
              <option value="all">Everyone in role</option>
              ${people.map((p) => `<option value="${esc(p)}" ${filters.person === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="nh-rolebar-right">
          <button class="btn-secondary ${view === 'todo' ? 'nh-tab-on' : ''}" type="button" data-view="todo">My To-Do</button>
          <button class="btn-secondary ${view === 'list' ? 'nh-tab-on' : ''}" type="button" data-view="list">All hires</button>
          <button class="btn-secondary ${view === 'archive' ? 'nh-tab-on' : ''}" type="button" data-view="archive">Archive</button>
          <button class="btn-secondary" type="button" id="nh-btn-template">Manage process</button>
          <button class="btn-primary" type="button" id="nh-btn-add">+ Add new hire</button>
        </div>
      </div>`;
  }

  function bindRoleBar(root) {
    root.querySelector('#nh-role')?.addEventListener('change', (e) => {
      filters.role = e.target.value;
      filters.person = 'all';
      localStorage.setItem(ROLE_PREF_KEY, filters.role);
      localStorage.setItem(PERSON_PREF_KEY, 'all');
      NewHireChecklist.render();
    });
    root.querySelector('#nh-person')?.addEventListener('change', (e) => {
      filters.person = e.target.value;
      localStorage.setItem(PERSON_PREF_KEY, filters.person);
      NewHireChecklist.render();
    });
    root.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        view = btn.getAttribute('data-view');
        NewHireChecklist.render();
      });
    });
    root.querySelector('#nh-btn-add')?.addEventListener('click', () => openHireModal());
    root.querySelector('#nh-btn-template')?.addEventListener('click', () => {
      view = 'template';
      NewHireChecklist.render();
    });
  }

  // ── MY TO-DO ───────────────────────────────────────────────
  function renderTodo(root) {
    const entries = todoEntries();
    const overdue = entries.filter((e) => e.bucket === 'overdue').length;
    const week = entries.filter((e) => e.bucket === 'week' || e.bucket === 'overdue').length;
    const open = entries.filter((e) => !e.done).length;

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-stats">
        <div class="stat"><div class="stat-num red">${overdue}</div><div class="stat-label">Overdue</div></div>
        <div class="stat"><div class="stat-num amber">${week}</div><div class="stat-label">Due in 7 days</div></div>
        <div class="stat"><div class="stat-num">${open}</div><div class="stat-label">Open for ${esc(filters.role === 'all' ? 'all roles' : filters.role)}</div></div>
        <div class="stat"><div class="stat-num green">${entries.filter((e) => e.done).length}</div><div class="stat-label">Shown complete</div></div>
      </div>
      <div class="nh-toolbar">
        <div class="nh-toolbar-left">
          <button class="wt-filter-btn ${filters.todoScope === 'open' ? 'active' : ''}" data-scope="open">Open</button>
          <button class="wt-filter-btn ${filters.todoScope === 'overdue' ? 'active' : ''}" data-scope="overdue">Overdue</button>
          <button class="wt-filter-btn ${filters.todoScope === 'week' ? 'active' : ''}" data-scope="week">This week</button>
          <button class="wt-filter-btn ${filters.todoScope === 'all' ? 'active' : ''}" data-scope="all">All</button>
          <button class="wt-filter-btn ${filters.todoScope === 'done' ? 'active' : ''}" data-scope="done">Done</button>
        </div>
        <div class="nh-muted">Due dates are calculated from each hire’s start date (bootcamp tasks use bootcamp date).</div>
      </div>
      <div class="nh-todo-list">
        ${entries.length ? entries.map(todoRow).join('') : '<div class="nh-empty">No tasks for this role filter. Pick another role or add a hire.</div>'}
      </div>`;

    bindRoleBar(root);
    root.querySelectorAll('[data-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filters.todoScope = btn.getAttribute('data-scope');
        NewHireChecklist.render();
      });
    });
    root.querySelectorAll('[data-open-hire]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedHireId = btn.getAttribute('data-open-hire');
        view = 'detail';
        NewHireChecklist.render();
      });
    });
    root.querySelectorAll('[data-todo-check]').forEach((el) => {
      el.addEventListener('change', () => {
        const hireId = el.getAttribute('data-hire');
        const itemId = el.getAttribute('data-item');
        saveValue(hireId, itemId, el.checked);
        NewHireChecklist.render();
      });
    });
  }

  function todoRow(e) {
    const dueCls = e.bucket === 'overdue' ? 'due-over' : e.bucket === 'week' ? 'due-soon' : '';
    return `
      <div class="nh-todo-row ${e.done ? 'done' : ''} ${dueCls}">
        <div class="nh-todo-main">
          <div class="nh-todo-hire">${esc(e.hire.name)} <span class="nh-muted">· ${esc(e.hire.division || '')}</span></div>
          <div class="nh-todo-task">${esc(e.item.label)}</div>
          <div class="nh-todo-meta">
            <span class="nh-role-chip">${esc(e.item.role)}</span>
            <span class="nh-owner-chip">${esc(e.who || 'Unassigned')}</span>
            <span class="nh-due ${dueCls}">Due ${esc(fmtDate(e.due))}</span>
            <span class="nh-type">${esc(e.item.inputType)}</span>
          </div>
        </div>
        <div class="nh-todo-actions">
          ${e.item.inputType === 'checkbox'
            ? `<label class="nh-check-label"><input type="checkbox" data-todo-check data-hire="${esc(e.hire.id)}" data-item="${esc(e.item.id)}" ${e.done ? 'checked' : ''}> Done</label>`
            : `<span class="nh-field-status">${e.done ? 'Complete' : 'Open'}</span>`}
          <button class="btn-xs primary" type="button" data-open-hire="${esc(e.hire.id)}">Open hire</button>
        </div>
      </div>`;
  }

  // ── HIRE LIST ──────────────────────────────────────────────
  function renderList(root) {
    const q = filters.q.trim().toLowerCase();
    const hires = data.hires
      .filter((h) => {
        const st = h.status || 'active';
        if (st === 'archived') return false; // Archive tab only
        if (filters.status === 'active' && st !== 'active') return false;
        if (filters.status === 'inactive' && st !== 'inactive') return false;
        if (!q) return true;
        return [h.name, h.division, h.role, h.statusNote].join(' ').toLowerCase().includes(q);
      })
      .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')) || a.name.localeCompare(b.name));

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-toolbar">
        <div class="nh-toolbar-left">
          <input class="wt-search" id="nh-search" type="search" placeholder="Search hires..." value="${esc(filters.q)}" style="width:220px">
          <select id="nh-status" class="form-input" style="width:130px">
            <option value="active" ${filters.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="inactive" ${filters.status === 'inactive' ? 'selected' : ''}>History</option>
            <option value="all" ${filters.status === 'all' ? 'selected' : ''}>All (not archived)</option>
          </select>
        </div>
      </div>
      <div class="nh-hire-grid">
        ${hires.length ? hires.map((h) => {
          const p = hireProgress(h);
          const pr = filters.role !== 'all' ? hireProgress(h, filters.role) : null;
          const st = h.status || 'active';
          return `<article class="nh-hire-card">
            <div class="nh-hire-card-top">
              <div>
                <div class="nh-hire-card-name">${esc(h.name)}</div>
                <div class="nh-hire-card-meta">${esc(h.division || '—')} · Start ${esc(h.startDate || 'TBD')}</div>
              </div>
              <span class="nh-badge ${st === 'active' ? 'ok' : 'off'}">${st === 'active' ? 'Active' : (st === 'archived' ? 'Archived' : 'History')}</span>
            </div>
            <div class="nh-prog">
              <div class="nh-prog-bar"><span style="width:${p.pct}%"></span></div>
              <div class="nh-prog-label">${p.done}/${p.total} · ${p.pct}%</div>
              ${pr ? `<div class="nh-prog-mine">${filters.role}: ${pr.done}/${pr.total}</div>` : ''}
            </div>
            <div class="nh-hire-card-actions">
              <button class="btn-xs primary" type="button" data-open-hire="${esc(h.id)}">Open checklist</button>
              ${st === 'active' || st === 'inactive' ? `<button class="btn-xs" type="button" data-archive-hire="${esc(h.id)}">Archive</button>` : ''}
            </div>
          </article>`;
        }).join('') : '<div class="nh-empty">No hires match.</div>'}
      </div>`;

    bindRoleBar(root);
    root.querySelector('#nh-search')?.addEventListener('input', (e) => { filters.q = e.target.value; NewHireChecklist.render(); });
    root.querySelector('#nh-status')?.addEventListener('change', (e) => { filters.status = e.target.value; NewHireChecklist.render(); });
    root.querySelectorAll('[data-open-hire]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedHireId = btn.getAttribute('data-open-hire');
        view = 'detail';
        NewHireChecklist.render();
      });
    });
    root.querySelectorAll('[data-archive-hire]').forEach((btn) => {
      btn.addEventListener('click', () => archiveHire(btn.getAttribute('data-archive-hire')));
    });
  }

  function renderArchive(root) {
    const q = filters.q.trim().toLowerCase();
    const hires = data.hires
      .filter((h) => (h.status || '') === 'archived')
      .filter((h) => {
        if (!q) return true;
        return [h.name, h.division, h.role, h.statusNote].join(' ').toLowerCase().includes(q);
      })
      .sort((a, b) => String(b.archivedAt || b.startDate || '').localeCompare(String(a.archivedAt || a.startDate || '')) || a.name.localeCompare(b.name));

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-toolbar">
        <div class="nh-toolbar-left">
          <input class="wt-search" id="nh-search" type="search" placeholder="Search archived hires..." value="${esc(filters.q)}" style="width:260px">
        </div>
        <div class="nh-muted" style="font-size:12px">Archived people are hidden from My To-Do. Delete permanently from here.</div>
      </div>
      <div class="nh-hire-grid">
        ${hires.length ? hires.map((h) => {
          const p = hireProgress(h);
          return `<article class="nh-hire-card nh-hire-card-archived">
            <div class="nh-hire-card-top">
              <div>
                <div class="nh-hire-card-name">${esc(h.name)}</div>
                <div class="nh-hire-card-meta">${esc(h.division || '—')} · Start ${esc(h.startDate || 'TBD')}${h.archivedAt ? ` · Archived ${esc(String(h.archivedAt).slice(0, 10))}` : ''}</div>
              </div>
              <span class="nh-badge off">Archived</span>
            </div>
            <div class="nh-prog">
              <div class="nh-prog-bar"><span style="width:${p.pct}%"></span></div>
              <div class="nh-prog-label">${p.done}/${p.total} · ${p.pct}%</div>
            </div>
            <div class="nh-hire-card-actions">
              <button class="btn-xs primary" type="button" data-open-hire="${esc(h.id)}">Open</button>
              <button class="btn-xs" type="button" data-restore-hire="${esc(h.id)}">Restore</button>
              <button class="btn-xs danger" type="button" data-delete-hire="${esc(h.id)}">Delete</button>
            </div>
          </article>`;
        }).join('') : '<div class="nh-empty">No archived hires.</div>'}
      </div>`;

    bindRoleBar(root);
    root.querySelector('#nh-search')?.addEventListener('input', (e) => { filters.q = e.target.value; NewHireChecklist.render(); });
    root.querySelectorAll('[data-open-hire]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedHireId = btn.getAttribute('data-open-hire');
        view = 'detail';
        NewHireChecklist.render();
      });
    });
    root.querySelectorAll('[data-restore-hire]').forEach((btn) => {
      btn.addEventListener('click', () => restoreHire(btn.getAttribute('data-restore-hire')));
    });
    root.querySelectorAll('[data-delete-hire]').forEach((btn) => {
      btn.addEventListener('click', () => deleteHirePermanently(btn.getAttribute('data-delete-hire')));
    });
  }

  function archiveHire(id) {
    const h = data.hires.find((x) => x.id === id);
    if (!h) return;
    if (!confirm(`Archive ${h.name}? They will move to the Archive section and leave My To-Do.`)) return;
    h.status = 'archived';
    h.archivedAt = new Date().toISOString();
    persist();
    if (selectedHireId === id) selectedHireId = null;
    view = 'list';
    NewHireChecklist.render();
  }

  function restoreHire(id) {
    const h = data.hires.find((x) => x.id === id);
    if (!h) return;
    h.status = 'active';
    delete h.archivedAt;
    persist();
    NewHireChecklist.render();
  }

  function deleteHirePermanently(id) {
    const h = data.hires.find((x) => x.id === id);
    if (!h) return;
    if ((h.status || '') !== 'archived') {
      alert('Only archived people can be deleted. Archive them first.');
      return;
    }
    if (!confirm(`Permanently delete ${h.name}? This cannot be undone.`)) return;
    data.hires = data.hires.filter((x) => x.id !== id);
    if (selectedHireId === id) { selectedHireId = null; view = 'archive'; }
    persist();
    NewHireChecklist.render();
  }

  // ── DETAIL ─────────────────────────────────────────────────
  function renderDetail(root) {
    const hire = data.hires.find((h) => h.id === selectedHireId);
    if (!hire) { view = 'todo'; return renderTodo(root); }
    if (!hire.values) hire.values = {};
    if (!hire.assignees) hire.assignees = {};
    const p = hireProgress(hire);
    const st = hire.status || 'active';

    const sectionsHtml = data.sections.map((sec) => {
      let items = itemsForSection(sec.id);
      if (filters.role !== 'all') items = items.filter((i) => i.role === filters.role);
      const open = openSections[sec.id] !== false;
      const spDone = items.filter((it) => isFilled(it, hire.values?.[it.id])).length;
      const spPct = items.length ? Math.round((spDone / items.length) * 100) : 0;
      return `
        <div class="nh-section ${open ? 'open' : ''}">
          <button type="button" class="nh-section-head" data-toggle-sec="${esc(sec.id)}">
            <div>
              <div class="nh-section-title">${esc(sec.id)}. ${esc(sec.title)}</div>
              <div class="nh-muted">${items.length} tasks${filters.role !== 'all' ? ' for ' + esc(filters.role) : ''}</div>
            </div>
            <div class="nh-section-right">
              <span class="nh-section-pct">${spDone}/${items.length} · ${spPct}%</span>
              <span class="nh-chevron">${open ? '▾' : '▸'}</span>
            </div>
          </button>
          <div class="nh-section-body" ${open ? '' : 'hidden'}>
            ${items.map((it) => fieldRow(hire, it)).join('') || '<div class="nh-empty">No tasks for this role in this section.</div>'}
          </div>
        </div>`;
    }).join('');

    root.innerHTML = `
      <div class="nh-detail-top">
        <button class="btn-secondary" type="button" id="nh-back">← ${st === 'archived' ? 'Archive' : 'My To-Do'}</button>
        <div class="nh-detail-actions">
          <label class="nh-check-label"><input type="checkbox" id="nh-reveal" ${revealSensitive ? 'checked' : ''}> Show sensitive</label>
          <select id="nh-role-d" class="form-input" style="width:140px">
            ${(data.roles || []).map((r) => `<option value="${esc(r.id)}" ${filters.role === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
            <option value="all" ${filters.role === 'all' ? 'selected' : ''}>All roles</option>
          </select>
          <button class="btn-secondary" type="button" id="nh-edit-hire">Edit profile</button>
          ${st === 'archived'
            ? `<button class="btn-secondary" type="button" id="nh-restore-hire">Restore</button>
               <button class="btn-secondary" type="button" id="nh-delete-hire" style="color:#b91c1c;border-color:#fca5a5">Delete</button>`
            : `<button class="btn-secondary" type="button" id="nh-archive-hire">Archive</button>`}
        </div>
      </div>
      <div class="nh-profile">
        <div>
          <div class="nh-profile-name">${esc(hire.name)}</div>
          <div class="nh-profile-meta">
            <span>${esc(hire.division || 'No division')}</span>
            <span>· Start ${esc(hire.startDate || 'TBD')}</span>
            ${hire.bootcampDate ? `<span>· Bootcamp ${esc(hire.bootcampDate)}</span>` : ''}
          </div>
        </div>
        <div class="nh-profile-right">
          <span class="nh-badge ${st === 'active' ? 'ok' : 'off'}">${st === 'active' ? 'Active' : (st === 'archived' ? 'Archived' : 'History')}</span>
          <div class="nh-prog big">
            <div class="nh-prog-bar"><span style="width:${p.pct}%"></span></div>
            <div class="nh-prog-label">${p.done} of ${p.total} · ${p.pct}%</div>
          </div>
        </div>
      </div>
      ${sectionsHtml}`;

    root.querySelector('#nh-back').addEventListener('click', () => {
      view = st === 'archived' ? 'archive' : 'todo';
      selectedHireId = null;
      NewHireChecklist.render();
    });
    root.querySelector('#nh-edit-hire').addEventListener('click', () => openHireModal(hire.id));
    root.querySelector('#nh-archive-hire')?.addEventListener('click', () => archiveHire(hire.id));
    root.querySelector('#nh-restore-hire')?.addEventListener('click', () => restoreHire(hire.id));
    root.querySelector('#nh-delete-hire')?.addEventListener('click', () => deleteHirePermanently(hire.id));
    root.querySelector('#nh-role-d').addEventListener('change', (e) => {
      filters.role = e.target.value;
      localStorage.setItem(ROLE_PREF_KEY, filters.role);
      NewHireChecklist.render();
    });
    root.querySelector('#nh-reveal').addEventListener('change', (e) => { revealSensitive = e.target.checked; NewHireChecklist.render(); });
    root.querySelectorAll('[data-toggle-sec]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toggle-sec');
        openSections[id] = !openSections[id];
        NewHireChecklist.render();
      });
    });
    root.querySelectorAll('[data-field]').forEach((el) => {
      const save = () => {
        const itemId = el.getAttribute('data-field');
        const item = data.items.find((i) => i.id === itemId);
        let val = el.type === 'checkbox' ? el.checked : el.value;
        if (item?.sensitive && !revealSensitive && String(val).includes('••')) return;
        saveValue(hire.id, itemId, val);
        const row = el.closest('.nh-field');
        if (row && item) {
          const filled = isFilled(item, val);
          row.classList.toggle('filled', filled);
          row.classList.toggle('open', !filled);
          const stEl = row.querySelector('.nh-field-status');
          if (stEl) stEl.textContent = filled ? 'Complete' : 'Open';
        }
      };
      el.addEventListener('change', save);
      if (el.type !== 'checkbox') el.addEventListener('blur', save);
    });
    root.querySelectorAll('[data-assignee]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const itemId = sel.getAttribute('data-assignee');
        hire.assignees[itemId] = sel.value;
        persist();
      });
    });
  }

  function fieldRow(hire, it) {
    const mine = filters.role !== 'all' && it.role === filters.role;
    const raw = hire.values?.[it.id];
    const filled = isFilled(it, raw);
    const due = dueDateFor(hire, it);
    const who = assigneeOf(hire, it);
    const people = [...new Set([...peopleForRole(it.role), who].filter(Boolean))];
    let control = '';
    if (it.inputType === 'checkbox') {
      control = `<label class="nh-check-label"><input type="checkbox" data-field="${esc(it.id)}" ${filled ? 'checked' : ''}> Complete</label>`;
    } else if (it.inputType === 'select') {
      const opts = (it.options || []).map((o) => `<option value="${esc(o)}" ${String(raw) === o ? 'selected' : ''}>${esc(o)}</option>`).join('');
      control = `<select class="form-input nh-field-input" data-field="${esc(it.id)}"><option value="">—</option>${opts}</select>`;
    } else if (it.inputType === 'date') {
      const v = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
      control = `<input class="form-input nh-field-input" type="date" data-field="${esc(it.id)}" value="${esc(v)}">`;
    } else {
      let display = raw == null ? '' : String(raw);
      if (it.sensitive && !revealSensitive && display) display = '••••••••';
      control = `<input class="form-input nh-field-input" type="text" data-field="${esc(it.id)}" value="${esc(display)}" ${it.sensitive && !revealSensitive && raw ? 'readonly' : ''} placeholder="Enter value…">`;
    }
    return `
      <div class="nh-field ${mine ? 'mine' : ''} ${filled ? 'filled' : 'open'}">
        <div class="nh-field-meta">
          <div class="nh-field-label">${esc(it.label)}${it.sensitive ? ' <span class="nh-lock">sensitive</span>' : ''}</div>
          <div class="nh-todo-meta">
            <span class="nh-role-chip">${esc(it.role)}</span>
            <span class="nh-due">Due ${esc(fmtDate(due))}</span>
          </div>
          <select class="form-input nh-assignee" data-assignee="${esc(it.id)}" title="Assigned person">
            ${people.map((p) => `<option value="${esc(p)}" ${who === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
          </select>
        </div>
        ${control}
        <div class="nh-field-status">${filled ? 'Complete' : 'Open'}</div>
      </div>`;
  }

  function saveValue(hireId, itemId, value) {
    const hire = data.hires.find((h) => h.id === hireId);
    const item = data.items.find((i) => i.id === itemId);
    if (!hire || !item) return;
    if (!hire.values) hire.values = {};
    if (item.inputType === 'checkbox') {
      if (value) hire.values[itemId] = true;
      else delete hire.values[itemId];
    } else {
      const v = String(value ?? '').trim();
      if (v) hire.values[itemId] = v;
      else delete hire.values[itemId];
    }
    if (/^Region$/i.test(item.label)) hire.division = String(value || '');
    if (/START DATE/i.test(item.label)) hire.startDate = String(value || '');
    if (/First Day of BOOTCAMP/i.test(item.label)) hire.bootcampDate = String(value || '');
    persist();
  }

  // ── TEMPLATE ───────────────────────────────────────────────
  function renderTemplate(root) {
    root.innerHTML = `
      <div class="nh-detail-top">
        <button class="btn-secondary" type="button" id="nh-back-t">← Back</button>
        <button class="btn-primary" type="button" id="nh-add-item">+ Add task</button>
      </div>
      <div class="page-sub" style="margin:0 0 16px">Edit the shared process: role, assignee, field type, and due-date offset from start date.</div>
      ${data.sections.map((sec) => {
        const items = itemsForSection(sec.id);
        return `<div class="nh-section open">
          <div class="nh-section-head static">
            <div class="nh-section-title">${esc(sec.id)}. ${esc(sec.title)}</div>
            <div class="nh-muted">${items.length} tasks</div>
          </div>
          <div class="nh-section-body">
            <div class="nh-template-list">
              ${items.map((it) => `
                <div class="nh-template-row">
                  <div>
                    <div class="nh-field-label">${esc(it.label)}</div>
                    <div class="nh-todo-meta">
                      <span class="nh-role-chip">${esc(it.role)}</span>
                      <span class="nh-owner-chip">${esc(it.assignee)}</span>
                      <span class="nh-type">${esc(it.inputType)}</span>
                      <span class="nh-due">${esc(it.dueAnchor)} ${it.dueOffsetDays >= 0 ? '+' : ''}${it.dueOffsetDays}d</span>
                    </div>
                  </div>
                  <div class="nh-template-actions">
                    <button class="btn-xs" type="button" data-edit-item="${esc(it.id)}">Edit</button>
                    <button class="btn-xs danger" type="button" data-del-item="${esc(it.id)}">Delete</button>
                  </div>
                </div>`).join('')}
            </div>
          </div>
        </div>`;
      }).join('')}`;

    root.querySelector('#nh-back-t').addEventListener('click', () => { view = 'todo'; NewHireChecklist.render(); });
    root.querySelector('#nh-add-item').addEventListener('click', () => openItemModal());
    root.querySelectorAll('[data-edit-item]').forEach((btn) => {
      btn.addEventListener('click', () => openItemModal(btn.getAttribute('data-edit-item')));
    });
    root.querySelectorAll('[data-del-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del-item');
        const it = data.items.find((i) => i.id === id);
        if (!it || !confirm(`Delete "${it.label}"?`)) return;
        data.items = data.items.filter((i) => i.id !== id);
        data.hires.forEach((h) => {
          if (h.values) delete h.values[id];
          if (h.assignees) delete h.assignees[id];
        });
        persist();
        NewHireChecklist.render();
      });
    });
  }

  // ── MODALS ─────────────────────────────────────────────────
  function openHireModal(id) {
    ensureData();
    let modal = document.getElementById('nh-hire-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'nh-hire-modal';
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal" style="width:560px">
          <div class="modal-head"><span class="modal-title" id="nh-hire-title">Add new hire</span><button class="modal-close" type="button" id="nh-hire-x">×</button></div>
          <div class="modal-body">
            <input type="hidden" id="nh-hire-id">
            <div class="form-row"><label class="form-label">Full name *</label><input id="nh-hire-name" class="form-input" type="text"></div>
            <div class="form-row-2">
              <div><label class="form-label">Division / region *</label><input id="nh-hire-division" class="form-input" type="text"></div>
              <div><label class="form-label">Role</label><input id="nh-hire-role" class="form-input" type="text"></div>
            </div>
            <div class="form-row-2">
              <div><label class="form-label">Start date *</label><input id="nh-hire-start" class="form-input" type="date"></div>
              <div><label class="form-label">Bootcamp start</label><input id="nh-hire-boot" class="form-input" type="date"></div>
            </div>
            <div class="form-row-2">
              <div><label class="form-label">Status</label>
                <select id="nh-hire-status" class="form-input"><option value="active">Active</option><option value="inactive">History</option></select>
              </div>
              <div><label class="form-label">Status note</label><input id="nh-hire-note" class="form-input" type="text"></div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" type="button" id="nh-hire-cancel">Cancel</button>
            <button class="btn-primary" type="button" id="nh-hire-save">Save</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) closeHireModal(); });
      document.getElementById('nh-hire-x').addEventListener('click', closeHireModal);
      document.getElementById('nh-hire-cancel').addEventListener('click', closeHireModal);
      document.getElementById('nh-hire-save').addEventListener('click', saveHireModal);
    }
    const hire = id ? data.hires.find((h) => h.id === id) : null;
    document.getElementById('nh-hire-title').textContent = hire ? 'Edit hire' : 'Add new hire';
    document.getElementById('nh-hire-id').value = hire?.id || '';
    document.getElementById('nh-hire-name').value = hire?.name || '';
    document.getElementById('nh-hire-division').value = hire?.division || '';
    document.getElementById('nh-hire-role').value = hire?.role || '';
    document.getElementById('nh-hire-start').value = (hire?.startDate || '').slice(0, 10);
    document.getElementById('nh-hire-boot').value = (hire?.bootcampDate || '').slice(0, 10);
    // Archived is managed via Archive tab — don't overwrite via this select
    const st = hire?.status === 'archived' ? 'inactive' : (hire?.status || 'active');
    document.getElementById('nh-hire-status').value = st === 'inactive' ? 'inactive' : 'active';
    document.getElementById('nh-hire-note').value = hire?.statusNote || '';
    modal.classList.add('open');
  }

  function closeHireModal() {
    document.getElementById('nh-hire-modal')?.classList.remove('open');
  }

  function saveHireModal() {
    const id = document.getElementById('nh-hire-id').value;
    const name = document.getElementById('nh-hire-name').value.trim();
    const division = document.getElementById('nh-hire-division').value.trim();
    const role = document.getElementById('nh-hire-role').value.trim();
    const startDate = document.getElementById('nh-hire-start').value;
    const bootcampDate = document.getElementById('nh-hire-boot').value;
    const status = document.getElementById('nh-hire-status').value;
    const statusNote = document.getElementById('nh-hire-note').value.trim();
    if (!name || !division || !startDate) {
      alert('Name, division, and start date are required (due dates depend on start date).');
      return;
    }
    const regionItem = data.items.find((i) => i.label === 'Region');
    const startItem = data.items.find((i) => /START DATE/i.test(i.label));
    const bootItem = data.items.find((i) => /First Day of BOOTCAMP/i.test(i.label));
    if (id) {
      const h = data.hires.find((x) => x.id === id);
      // Keep archived status unless restored from Archive tab
      const nextStatus = h.status === 'archived' ? 'archived' : status;
      Object.assign(h, { name, division, role: role || division, startDate, bootcampDate, status: nextStatus, statusNote });
      if (!h.values) h.values = {};
      if (regionItem) h.values[regionItem.id] = division;
      if (startItem) h.values[startItem.id] = startDate;
      if (bootItem && bootcampDate) h.values[bootItem.id] = bootcampDate;
    } else {
      const values = {};
      if (regionItem) values[regionItem.id] = division;
      if (startItem) values[startItem.id] = startDate;
      if (bootItem && bootcampDate) values[bootItem.id] = bootcampDate;
      const h = {
        id: uid('h'), name, division, role: role || division, startDate, bootcampDate,
        status, statusNote, values, assignees: {}, createdAt: new Date().toISOString(), source: 'hub'
      };
      data.hires.unshift(h);
      selectedHireId = h.id;
      view = 'detail';
    }
    persist();
    closeHireModal();
    NewHireChecklist.render();
  }

  function openItemModal(id) {
    ensureData();
    let modal = document.getElementById('nh-item-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'nh-item-modal';
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal" style="width:560px">
          <div class="modal-head"><span class="modal-title" id="nh-item-title">Add task</span><button class="modal-close" type="button" id="nh-item-x">×</button></div>
          <div class="modal-body">
            <input type="hidden" id="nh-item-id">
            <div class="form-row"><label class="form-label">Section</label><select id="nh-item-section" class="form-input"></select></div>
            <div class="form-row"><label class="form-label">Task label *</label><input id="nh-item-label" class="form-input" type="text"></div>
            <div class="form-row-2">
              <div><label class="form-label">Role *</label>
                <select id="nh-item-role" class="form-input">
                  <option>HR</option><option>Admin</option><option>PM</option><option>Logistics</option><option>Training</option>
                </select>
              </div>
              <div><label class="form-label">Assignee *</label><input id="nh-item-assignee" class="form-input" type="text" list="nh-people-dl"><datalist id="nh-people-dl"></datalist></div>
            </div>
            <div class="form-row-2">
              <div><label class="form-label">Input type</label>
                <select id="nh-item-type" class="form-input">
                  <option value="text">Text</option><option value="date">Date</option>
                  <option value="select">Dropdown</option><option value="checkbox">Checklist</option>
                </select>
              </div>
              <div><label class="form-label">Due offset (days)</label><input id="nh-item-offset" class="form-input" type="number" value="-7"></div>
            </div>
            <div class="form-row-2">
              <div><label class="form-label">Due anchor</label>
                <select id="nh-item-anchor" class="form-input"><option value="start">Start date</option><option value="bootcamp">Bootcamp date</option></select>
              </div>
              <div><label class="form-label">Dropdown options (comma-sep)</label><input id="nh-item-options" class="form-input" type="text" placeholder="Yes, No, N/A"></div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" type="button" id="nh-item-cancel">Cancel</button>
            <button class="btn-primary" type="button" id="nh-item-save">Save task</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) closeItemModal(); });
      document.getElementById('nh-item-x').addEventListener('click', closeItemModal);
      document.getElementById('nh-item-cancel').addEventListener('click', closeItemModal);
      document.getElementById('nh-item-save').addEventListener('click', saveItemModal);
    }
    document.getElementById('nh-item-section').innerHTML = data.sections.map((s) =>
      `<option value="${s.id}">${esc(s.id)}. ${esc(s.title)}</option>`
    ).join('');
    const allPeople = [...new Set((data.roles || []).flatMap((r) => r.people))];
    document.getElementById('nh-people-dl').innerHTML = allPeople.map((p) => `<option value="${esc(p)}">`).join('');
    const it = id ? data.items.find((i) => i.id === id) : null;
    document.getElementById('nh-item-title').textContent = it ? 'Edit task' : 'Add task';
    document.getElementById('nh-item-id').value = it?.id || '';
    document.getElementById('nh-item-section').value = it?.sectionId || 'A';
    document.getElementById('nh-item-label').value = it?.label || '';
    document.getElementById('nh-item-role').value = it?.role || 'HR';
    document.getElementById('nh-item-assignee').value = it?.assignee || '';
    document.getElementById('nh-item-type').value = it?.inputType || 'text';
    document.getElementById('nh-item-offset').value = it?.dueOffsetDays != null ? it.dueOffsetDays : -7;
    document.getElementById('nh-item-anchor').value = it?.dueAnchor || 'start';
    document.getElementById('nh-item-options').value = (it?.options || []).join(', ');
    modal.classList.add('open');
  }

  function closeItemModal() {
    document.getElementById('nh-item-modal')?.classList.remove('open');
  }

  function saveItemModal() {
    const id = document.getElementById('nh-item-id').value;
    const sectionId = document.getElementById('nh-item-section').value;
    const label = document.getElementById('nh-item-label').value.trim();
    const role = document.getElementById('nh-item-role').value;
    const assignee = document.getElementById('nh-item-assignee').value.trim();
    const inputType = document.getElementById('nh-item-type').value;
    const dueOffsetDays = parseInt(document.getElementById('nh-item-offset').value, 10) || 0;
    const dueAnchor = document.getElementById('nh-item-anchor').value;
    const options = document.getElementById('nh-item-options').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!label || !assignee) { alert('Label and assignee are required.'); return; }
    if (id) {
      const it = data.items.find((i) => i.id === id);
      Object.assign(it, { sectionId, label, role, assignee, owner: assignee, inputType, options, dueOffsetDays, dueAnchor });
    } else {
      const maxOrder = data.items.reduce((m, i) => Math.max(m, i.order || 0), 0);
      data.items.push({
        id: uid('t'), sectionId, label, role, assignee, owner: assignee,
        inputType, options, dueOffsetDays, dueAnchor, order: maxOrder + 1, sensitive: false
      });
    }
    persist();
    closeItemModal();
    NewHireChecklist.render();
  }
})();
