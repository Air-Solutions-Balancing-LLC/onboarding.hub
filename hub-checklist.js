// New Hire Checklist — Brian's employee roster + role-based My To-Do
(function () {
  const STORAGE_KEY = 'new_hire_checklist';
  const ROLE_PREF_KEY = 'nh_role_pref';
  const PERSON_PREF_KEY = 'nh_person_pref';
  const SELECT_COLS =
    'id, full_name, employee_number, employee_type, status, status_note, region, start_date, bootcamp_start_date, company_email, assigned_pm';

  let data = null; // { version, roles, sections, items, progress }
  let employees = [];
  let view = 'dashboard'; // dashboard | todo | roster | detail | template
  const STATUS_OPTIONS = ['active', 'terminated', 'quit', 'rescinded', 'resigned'];
  let processAdminOpen = {}; // category expand state in Admin
  let selectedHireId = null;
  let openSections = {};
  let filters = { q: '', status: 'all', role: 'HR', person: 'all', todoScope: 'week', hireWindow: 'onboarding' };
  let revealSensitive = false;
  let saveTimer = null;
  let loading = true;
  let loadError = null;
  let mounted = false;
  let todoLimit = 80;

  function client() {
    return window.HubAuth && HubAuth.getClient ? HubAuth.getClient() : null;
  }

  function seed() {
    const s = window.NEW_HIRE_SEED;
    if (!s) return { version: 2, roles: [], sections: [], items: [], progress: {} };
    const copy = JSON.parse(JSON.stringify(s));
    if (!copy.progress || typeof copy.progress !== 'object') copy.progress = {};
    return copy;
  }

  function migrate(raw) {
    const base = seed();
    if (!raw || typeof raw !== 'object') return base;
    const forceMeta = !raw.version || raw.version < 2;
    const byId = {};
    (raw.items || []).forEach((i) => { byId[i.id] = i; });
    const items = (base.items || []).map((bi) => {
      const old = byId[bi.id];
      if (!old) return bi;
      if (forceMeta) return Object.assign({}, bi);
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
        dependsOnPrior: !!(old.dependsOnPrior || old.dependsOnTaskId || bi.dependsOnPrior || bi.dependsOnTaskId),
        dependsOnTaskId: old.dependsOnTaskId || bi.dependsOnTaskId || null,
        order: old.order != null ? old.order : bi.order,
        sectionId: old.sectionId || bi.sectionId
      });
    });
    (raw.items || []).forEach((oi) => {
      if (oi.id && String(oi.id).startsWith('t') && oi.label && oi.role && !items.find((i) => i.id === oi.id)) {
        items.push(Object.assign({
          role: 'HR', assignee: 'Lisa', inputType: 'text', options: [],
          dueOffsetDays: -7, dueAnchor: 'start', sensitive: false,
          dependsOnPrior: false, dependsOnTaskId: null, order: items.length + 1
        }, oi));
      }
    });
    // Normalize dependency flags
    items.forEach((it) => {
      if (it.dependsOnTaskId && !items.find((x) => x.id === it.dependsOnTaskId)) {
        it.dependsOnTaskId = null;
      }
      it.dependsOnPrior = !!it.dependsOnTaskId || !!it.dependsOnPrior;
      if (!it.dependsOnPrior) it.dependsOnTaskId = null;
    });

    // progress: prefer progress map; migrate legacy hires[].values if present
    const progress = Object.assign({}, raw.progress || {});
    (raw.hires || []).forEach((h) => {
      if (!h || !h.id) return;
      if (!progress[h.id]) {
        progress[h.id] = {
          values: h.values || {},
          assignees: h.assignees || {}
        };
      }
    });

    return {
      version: 2,
      roles: base.roles,
      sections: base.sections,
      items,
      progress
    };
  }

  function ensureData() {
    if (!data) data = seed();
    if (!Array.isArray(data.roles)) data.roles = seed().roles || [];
    if (!Array.isArray(data.sections)) data.sections = seed().sections || [];
    if (!Array.isArray(data.items)) data.items = seed().items || [];
    if (!data.progress || typeof data.progress !== 'object') data.progress = {};
  }

  function persist() {
    ensureData();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.HubAuth && HubAuth.save) {
        HubAuth.save(STORAGE_KEY, {
          version: data.version || 2,
          roles: data.roles,
          sections: data.sections,
          items: data.items,
          progress: data.progress
        });
      }
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

  function progressOf(empId) {
    ensureData();
    if (!data.progress[empId]) data.progress[empId] = { values: {}, assignees: {} };
    if (!data.progress[empId].values) data.progress[empId].values = {};
    if (!data.progress[empId].assignees) data.progress[empId].assignees = {};
    return data.progress[empId];
  }

  function empToHire(emp) {
    const p = progressOf(emp.id);
    const regionItem = data.items.find((i) => i.label === 'Region');
    const startItem = data.items.find((i) => /START DATE/i.test(i.label));
    const bootItem = data.items.find((i) => /First Day of BOOTCAMP/i.test(i.label));
    const pmItem = data.items.find((i) => /Assigned Project Manager/i.test(i.label));
    if (regionItem && emp.region && !p.values[regionItem.id]) p.values[regionItem.id] = emp.region;
    if (startItem && emp.start_date && !p.values[startItem.id]) p.values[startItem.id] = emp.start_date;
    if (bootItem && emp.bootcamp_start_date && !p.values[bootItem.id]) p.values[bootItem.id] = emp.bootcamp_start_date;
    if (pmItem && emp.assigned_pm && !p.values[pmItem.id]) p.values[pmItem.id] = emp.assigned_pm;

    return {
      id: emp.id,
      name: emp.full_name,
      division: emp.region || '',
      role: emp.employee_type || '',
      startDate: emp.start_date || '',
      bootcampDate: emp.bootcamp_start_date || '',
      status: emp.status || 'active',
      statusNote: emp.status_note || '',
      employeeNumber: emp.employee_number,
      employeeType: emp.employee_type,
      companyEmail: emp.company_email || '',
      assignedPm: emp.assigned_pm || '',
      values: p.values,
      assignees: p.assignees,
      _emp: emp
    };
  }

  function hires() {
    ensureData();
    return employees.map(empToHire);
  }

  function dueDateFor(hire, item) {
    const anchor = item.dueAnchor === 'bootcamp'
      ? (parseDate(hire.bootcampDate) || parseDate(hire.startDate))
      : parseDate(hire.startDate);
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
    if (roleId === 'PM') {
      employees.forEach((e) => {
        if (e.assigned_pm && !base.includes(e.assigned_pm)) base.push(e.assigned_pm);
      });
      hires().forEach((h) => {
        const pmItem = data.items.find((i) => /Assigned Project Manager/i.test(i.label));
        const pm = pmItem && h.values?.[pmItem.id];
        if (pm && !base.includes(String(pm))) base.push(String(pm));
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

  function isActiveHire(h) {
    return (h.status || '').toLowerCase() === 'active';
  }

  function inOnboardingWindow(hire, today) {
    const start = parseDate(hire.startDate);
    if (!start) return true; // keep undated hires visible so they can be cleaned up
    const from = addDays(today, -120);
    const to = addDays(today, 60);
    return start >= from && start <= to;
  }

  function todoEntries() {
    ensureData();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const week = addDays(today, 7);
    const out = [];
    hires()
      .filter(isActiveHire)
      .filter((h) => filters.hireWindow === 'all' || inOnboardingWindow(h, today))
      .forEach((hire) => {
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
      const order = { overdue: 0, week: 1, later: 2, nodate: 3 };
      const ao = order[a.bucket] ?? 9;
      const bo = order[b.bucket] ?? 9;
      if (ao !== bo) return ao - bo;
      const ad = a.due ? a.due.getTime() : Infinity;
      const bd = b.due ? b.due.getTime() : Infinity;
      if (ad !== bd) return ad - bd;
      return a.hire.name.localeCompare(b.hire.name) || a.item.label.localeCompare(b.item.label);
    });
    return out;
  }

  function statusBadgeClass(status) {
    const map = {
      active: 'nh-badge nh-badge-active',
      terminated: 'nh-badge nh-badge-danger',
      quit: 'nh-badge nh-badge-danger',
      resigned: 'nh-badge nh-badge-warn',
      rescinded: 'nh-badge nh-badge-muted',
    };
    return map[status] || 'nh-badge nh-badge-muted';
  }

  function typeBadgeClass(type) {
    const map = {
      technician: 'nh-badge nh-badge-tech',
      us_office: 'nh-badge nh-badge-office',
      intl_office: 'nh-badge nh-badge-intl',
    };
    return map[type] || 'nh-badge nh-badge-muted';
  }

  function formatType(type) {
    return String(type || '—').replace(/_/g, ' ');
  }

  function filteredEmployees() {
    const q = filters.q.trim().toLowerCase();
    return employees.filter((e) => {
      const matchSearch =
        !q ||
        (e.full_name || '').toLowerCase().includes(q) ||
        (e.company_email || '').toLowerCase().includes(q) ||
        String(e.employee_number ?? '').includes(q);
      const matchFilter = filters.status === 'all' || e.status === filters.status;
      return matchSearch && matchFilter;
    });
  }

  function stats() {
    const active = employees.filter((e) => e.status === 'active').length;
    return {
      total: employees.length,
      active,
      inactive: employees.length - active,
      technicians: employees.filter((e) => e.employee_type === 'technician').length,
    };
  }

  async function loadEmployees() {
    const supabase = client();
    if (!supabase) {
      loadError = 'Not signed in / Supabase unavailable';
      loading = false;
      return;
    }
    loading = true;
    loadError = null;
    render();
    const { data: rows, error } = await supabase
      .from('employees')
      .select(SELECT_COLS)
      .order('employee_number', { ascending: false, nullsFirst: false });
    if (error) {
      loading = false;
      loadError = error.message;
      render();
      return;
    }
    employees = rows || [];
    loading = false;
    render();
  }

  function setPageSub(text) {
    const el = document.querySelector('#page-checklist .page-sub');
    if (el) el.textContent = text;
  }

  function statusSelect(empId, status, extraClass) {
    const cur = status || 'active';
    const opts = STATUS_OPTIONS.includes(cur) ? STATUS_OPTIONS : [cur, ...STATUS_OPTIONS];
    return `<select class="nh-status-select ${extraClass || ''}" data-status-emp="${esc(empId)}" title="Change status">
      ${opts.map((s) => `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('')}
    </select>`;
  }

  function bindStatusSelects(root) {
    root.querySelectorAll('[data-status-emp]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.getAttribute('data-status-emp');
        const status = sel.value;
        const emp = employees.find((e) => e.id === id);
        if (!emp) return;
        const prev = emp.status;
        emp.status = status;
        sel.classList.add('nh-saving');
        try {
          await syncEmployeePatch(id, { status });
        } catch (e) {
          emp.status = prev;
          sel.value = prev;
          alert('Could not update status: ' + (e.message || e));
        }
        sel.classList.remove('nh-saving');
        // Refresh stats / filters without losing scroll too hard
        if (view === 'roster' || view === 'dashboard') render();
      });
    });
  }

  function sectionProgress(hire, sectionId) {
    const items = itemsForSection(sectionId);
    const total = items.length;
    let done = 0;
    items.forEach((it) => { if (isFilled(it, hire.values?.[it.id])) done++; });
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function pctClass(pct) {
    if (pct >= 100) return 'nh-pct-done';
    if (pct >= 50) return 'nh-pct-mid';
    if (pct > 0) return 'nh-pct-low';
    return 'nh-pct-zero';
  }

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
          <button class="btn-secondary ${view === 'dashboard' ? 'nh-tab-on' : ''}" type="button" data-view="dashboard">Dashboard</button>
          <button class="btn-secondary ${view === 'todo' ? 'nh-tab-on' : ''}" type="button" data-view="todo">My To-Do</button>
          <button class="btn-secondary ${view === 'roster' ? 'nh-tab-on' : ''}" type="button" data-view="roster">Roster</button>
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
      render();
    });
    root.querySelector('#nh-person')?.addEventListener('change', (e) => {
      filters.person = e.target.value;
      localStorage.setItem(PERSON_PREF_KEY, filters.person);
      render();
    });
    root.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        view = btn.getAttribute('data-view');
        selectedHireId = null;
        render();
      });
    });
    root.querySelector('#nh-btn-add')?.addEventListener('click', () => openHireModal());
    root.querySelector('#nh-btn-template')?.addEventListener('click', () => {
      // Process editing lives in Admin for full team control
      if (window.HubAuth && HubAuth.isAdmin && HubAuth.isAdmin()) {
        const adminBtn = document.getElementById('nav-admin');
        showPage('admin', adminBtn);
        setTimeout(() => {
          document.getElementById('nh-process-admin-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
      } else {
        view = 'template';
        render();
      }
    });
  }

  function renderTodo(root) {
    setPageSub('Pick your role (HR / Admin / PM / Logistics / Training). Due dates use each hire’s start date (bootcamp tasks use bootcamp date).');
    const entries = todoEntries();
    const overdue = entries.filter((e) => e.bucket === 'overdue').length;
    const week = entries.filter((e) => e.bucket === 'week' || e.bucket === 'overdue').length;
    const open = entries.filter((e) => !e.done).length;
    const shown = entries.slice(0, todoLimit);

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-stats nh-stats-todo">
        <div class="stat"><div class="stat-num red">${overdue}</div><div class="stat-label">Overdue</div></div>
        <div class="stat"><div class="stat-num amber">${week}</div><div class="stat-label">Due in 7 days</div></div>
        <div class="stat"><div class="stat-num">${open}</div><div class="stat-label">Open for ${esc(filters.role === 'all' ? 'all roles' : filters.role)}</div></div>
        <div class="stat"><div class="stat-num green">${entries.filter((e) => e.done).length}</div><div class="stat-label">Shown complete</div></div>
      </div>
      <div class="nh-toolbar nh-toolbar-plain">
        <div class="nh-toolbar-left">
          <button class="wt-filter-btn ${filters.todoScope === 'week' ? 'active' : ''}" data-scope="week">This week</button>
          <button class="wt-filter-btn ${filters.todoScope === 'overdue' ? 'active' : ''}" data-scope="overdue">Overdue</button>
          <button class="wt-filter-btn ${filters.todoScope === 'open' ? 'active' : ''}" data-scope="open">Open</button>
          <button class="wt-filter-btn ${filters.todoScope === 'all' ? 'active' : ''}" data-scope="all">All</button>
          <button class="wt-filter-btn ${filters.todoScope === 'done' ? 'active' : ''}" data-scope="done">Done</button>
          <button class="wt-filter-btn ${filters.hireWindow === 'onboarding' ? 'active' : ''}" data-hire-window="onboarding" title="Start date within last 120 days or next 60 days">Onboarding window</button>
          <button class="wt-filter-btn ${filters.hireWindow === 'all' ? 'active' : ''}" data-hire-window="all">All active hires</button>
        </div>
        <div class="nh-muted">Roster from employees · showing ${Math.min(shown.length, entries.length)} of ${entries.length}</div>
      </div>
      <div class="nh-todo-list">
        ${shown.length ? shown.map(todoRow).join('') : '<div class="nh-empty-block">No tasks for this filter. Try Open, another role, or Roster.</div>'}
      </div>
      ${entries.length > todoLimit ? `<div style="margin-top:12px;text-align:center"><button class="btn-secondary" type="button" id="nh-todo-more">Show more (${entries.length - todoLimit} left)</button></div>` : ''}`;

    bindRoleBar(root);
    root.querySelectorAll('[data-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filters.todoScope = btn.getAttribute('data-scope');
        todoLimit = 80;
        render();
      });
    });
    root.querySelectorAll('[data-hire-window]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filters.hireWindow = btn.getAttribute('data-hire-window');
        todoLimit = 80;
        render();
      });
    });
    root.querySelector('#nh-todo-more')?.addEventListener('click', () => {
      todoLimit += 80;
      render();
    });
    root.querySelectorAll('[data-open-hire]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedHireId = btn.getAttribute('data-open-hire');
        view = 'detail';
        render();
      });
    });
    root.querySelectorAll('[data-todo-check]').forEach((el) => {
      el.addEventListener('change', () => {
        saveValue(el.getAttribute('data-hire'), el.getAttribute('data-item'), el.checked);
        render();
      });
    });
  }

  function todoRow(e) {
    const dueCls = e.bucket === 'overdue' ? 'due-over' : e.bucket === 'week' ? 'due-soon' : '';
    return `
      <div class="nh-todo-row ${e.done ? 'done' : ''} ${dueCls}">
        <div class="nh-todo-main">
          <div class="nh-todo-hire">${esc(e.hire.name)} <span class="nh-muted-inline">· ${esc(e.hire.division || '')}</span></div>
          <div class="nh-todo-task">${esc(e.item.label)}</div>
          <div class="nh-todo-meta">
            <span class="nh-person-role"><span class="nh-owner-chip">${esc(e.who || 'Unassigned')}</span><span class="nh-role-chip">${esc(e.item.role)}</span></span>
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

  function bindRosterChrome(root) {
    bindRoleBar(root);
    bindStatusSelects(root);
    root.querySelector('#nh-search')?.addEventListener('input', (e) => {
      filters.q = e.target.value;
      render();
      const input = document.getElementById('nh-search');
      if (input) {
        input.focus();
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    });
    root.querySelectorAll('[data-nh-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filters.status = btn.getAttribute('data-nh-filter');
        render();
      });
    });
    root.querySelectorAll('[data-open-hire]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedHireId = btn.getAttribute('data-open-hire');
        // Always open a hire with all categories collapsed
        openSections = {};
        (data.sections || []).forEach((s) => { openSections[s.id] = false; });
        view = 'detail';
        render();
      });
    });
  }

  function renderDashboard(root) {
    setPageSub('Shared spreadsheet dashboard — everyone can see every hire’s progress by section (like the NH Checklist Excel). Change Status in the dropdown.');
    ensureData();
    const s = stats();
    const rows = filteredEmployees();
    const statusFilters = ['all', 'active', 'terminated', 'quit', 'rescinded'];
    const sections = data.sections || [];

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-stats">
        <div class="nh-stat"><div class="nh-stat-label">Total Employees</div><div class="nh-stat-num">${s.total}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Active</div><div class="nh-stat-num nh-stat-green">${s.active}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Inactive</div><div class="nh-stat-num nh-stat-red">${s.inactive}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Technicians</div><div class="nh-stat-num nh-stat-amber">${s.technicians}</div></div>
      </div>
      <div class="nh-toolbar">
        <input type="search" class="nh-search" id="nh-search" placeholder="Search by name, email, or #..." value="${esc(filters.q)}" />
        <div class="nh-filters">
          ${statusFilters.map((f) =>
            `<button type="button" class="nh-filter-btn${filters.status === f ? ' active' : ''}" data-nh-filter="${f}">${f}</button>`
          ).join('')}
        </div>
      </div>
      <div class="nh-sheet-wrap">
        <table class="nh-sheet">
          <thead>
            <tr>
              <th class="nh-sticky">#</th>
              <th class="nh-sticky nh-sticky-2">Name</th>
              <th>Region</th>
              <th>Start</th>
              <th>Status</th>
              <th>Overall</th>
              ${sections.map((sec) => `<th title="${esc(sec.title)}" class="nh-sec-col">${esc(sec.id)}</th>`).join('')}
              <th></th>
            </tr>
            <tr class="nh-sheet-subhead">
              <th class="nh-sticky"></th>
              <th class="nh-sticky nh-sticky-2"></th>
              <th colspan="4" class="nh-muted">Profile</th>
              ${sections.map((sec) => `<th class="nh-sec-sub">${esc(sec.title)}</th>`).join('')}
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((emp) => {
              const hire = empToHire(emp);
              const overall = hireProgress(hire);
              return `<tr>
                <td class="nh-sticky nh-muted">${esc(emp.employee_number ?? '—')}</td>
                <td class="nh-sticky nh-sticky-2 nh-name">
                  <button type="button" class="nh-linkish" data-open-hire="${esc(emp.id)}">${esc(emp.full_name)}</button>
                </td>
                <td>${esc(emp.region || '—')}</td>
                <td>${esc(emp.start_date || '—')}</td>
                <td>${statusSelect(emp.id, emp.status)}</td>
                <td><span class="nh-pct ${pctClass(overall.pct)}" title="${overall.done}/${overall.total}">${overall.pct}%</span></td>
                ${sections.map((sec) => {
                  const sp = sectionProgress(hire, sec.id);
                  return `<td class="nh-sec-cell">
                    <button type="button" class="nh-pct ${pctClass(sp.pct)}" data-open-hire="${esc(emp.id)}" title="${esc(sec.title)}: ${sp.done}/${sp.total}">${sp.done}/${sp.total}</button>
                  </td>`;
                }).join('')}
                <td><button class="btn-xs primary" type="button" data-open-hire="${esc(emp.id)}">Open</button></td>
              </tr>`;
            }).join('') : `<tr><td colspan="${7 + sections.length}" class="nh-empty">No employees found</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="nh-footnote">${rows.length} hires · columns A–J match spreadsheet sections · change Status in the dropdown · click a cell to open that hire</p>`;

    bindRosterChrome(root);
  }

  function renderRoster(root) {
    setPageSub('Employee roster — change Status with the dropdown, search/filter, and open a hire for the full checklist.');
    const s = stats();
    const rows = filteredEmployees();
    const statusFilters = ['all', 'active', 'terminated', 'quit', 'rescinded'];

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-stats">
        <div class="nh-stat"><div class="nh-stat-label">Total Employees</div><div class="nh-stat-num">${s.total}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Active</div><div class="nh-stat-num nh-stat-green">${s.active}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Inactive</div><div class="nh-stat-num nh-stat-red">${s.inactive}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Technicians</div><div class="nh-stat-num nh-stat-amber">${s.technicians}</div></div>
      </div>
      <div class="nh-toolbar">
        <input type="search" class="nh-search" id="nh-search" placeholder="Search by name, email, or #..." value="${esc(filters.q)}" />
        <div class="nh-filters">
          ${statusFilters.map((f) =>
            `<button type="button" class="nh-filter-btn${filters.status === f ? ' active' : ''}" data-nh-filter="${f}">${f}</button>`
          ).join('')}
        </div>
      </div>
      <div class="nh-table-wrap">
        <table class="nh-table">
          <thead>
            <tr><th>#</th><th>Name</th><th>Type</th><th>Region</th><th>Start Date</th><th>Status</th><th>Progress</th></tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((emp) => {
              const hire = empToHire(emp);
              const pr = hireProgress(hire);
              return `<tr>
                <td class="nh-muted">${esc(emp.employee_number ?? '—')}</td>
                <td class="nh-name"><button type="button" class="nh-linkish" data-open-hire="${esc(emp.id)}">${esc(emp.full_name)}</button></td>
                <td><span class="${typeBadgeClass(emp.employee_type)}">${esc(formatType(emp.employee_type))}</span></td>
                <td>${esc(emp.region || '—')}</td>
                <td>${esc(emp.start_date || '—')}</td>
                <td>${statusSelect(emp.id, emp.status)}</td>
                <td><button class="btn-xs primary" type="button" data-open-hire="${esc(emp.id)}">${pr.done}/${pr.total}</button></td>
              </tr>`;
            }).join('') : `<tr><td colspan="7" class="nh-empty">No employees found</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="nh-footnote">${rows.length} employees shown · use the Status dropdown to update · click name/progress to open checklist</p>`;

    bindRosterChrome(root);
  }

  function sectionBarClass(done, total) {
    if (total > 0 && done >= total) return 'nh-bar-green';
    if (done > 0) return 'nh-bar-blue';
    return 'nh-bar-white';
  }

  function isPastDue(due, filled) {
    if (!due || filled) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return due < today;
  }

  function renderDetail(root) {
    const hire = hires().find((h) => h.id === selectedHireId);
    if (!hire) { view = 'dashboard'; return renderDashboard(root); }
    setPageSub('Each task is one row (assignee first). Section bars: white = not started, blue = in progress, green = complete. Past-due dates turn red.');
    const p = hireProgress(hire);

    const sectionsHtml = data.sections.map((sec) => {
      // Always show every task in the section (full spreadsheet visibility)
      const items = itemsForSection(sec.id);
      const expanded = openSections[sec.id] === true;
      const spDone = items.filter((it) => isFilled(it, hire.values?.[it.id])).length;
      const spOpen = items.length - spDone;
      const barCls = sectionBarClass(spDone, items.length);
      return `
        <div class="nh-section ${expanded ? 'open' : ''} ${barCls}">
          <button type="button" class="nh-section-head ${barCls}" data-toggle-sec="${esc(sec.id)}">
            <div class="nh-section-left">
              <span class="nh-chevron">${expanded ? '▾' : '▸'}</span>
              <div class="nh-section-title">${esc(sec.id)}. ${esc(sec.title)}</div>
            </div>
            <div class="nh-section-right">
              <span class="nh-section-counts"><strong>${spDone}</strong> done / <strong>${spOpen}</strong> open</span>
            </div>
          </button>
          <div class="nh-section-body" ${expanded ? '' : 'hidden'}>
            <div class="nh-task-table">
              <div class="nh-task-head">
                <span>Assigned</span>
                <span>Task</span>
                <span>Due</span>
                <span>Value</span>
                <span>Status</span>
              </div>
              ${items.map((it) => fieldRow(hire, it)).join('') || '<div class="nh-empty-block">No tasks in this section.</div>'}
            </div>
          </div>
        </div>`;
    }).join('');

    root.innerHTML = `
      <div class="nh-detail-top">
        <button class="btn-secondary" type="button" id="nh-back">← Dashboard</button>
        <div class="nh-detail-actions">
          <label class="nh-check-label"><input type="checkbox" id="nh-reveal" ${revealSensitive ? 'checked' : ''}> Show sensitive</label>
          <select id="nh-role-d" class="form-input" style="width:140px" title="Highlight tasks for this role">
            <option value="all" ${filters.role === 'all' ? 'selected' : ''}>Highlight: all</option>
            ${(data.roles || []).map((r) => `<option value="${esc(r.id)}" ${filters.role === r.id ? 'selected' : ''}>Highlight: ${esc(r.label)}</option>`).join('')}
          </select>
          <button class="btn-secondary" type="button" id="nh-edit-hire">Edit profile</button>
        </div>
      </div>
      <div class="nh-profile">
        <div>
          <div class="nh-profile-name">${esc(hire.name)}</div>
          <div class="nh-profile-meta">
            <span>${esc(hire.division || 'No region')}</span>
            <span>· Start ${esc(hire.startDate || 'TBD')}</span>
            ${hire.bootcampDate ? `<span>· Bootcamp ${esc(hire.bootcampDate)}</span>` : ''}
            ${hire.assignedPm ? `<span>· PM ${esc(hire.assignedPm)}</span>` : ''}
          </div>
          <div class="nh-bar-legend">
            <span class="nh-leg nh-bar-white">Not started</span>
            <span class="nh-leg nh-bar-blue">In progress</span>
            <span class="nh-leg nh-bar-green">Complete</span>
          </div>
        </div>
        <div class="nh-profile-right">
          <span class="${statusBadgeClass(hire.status)}">${esc(hire.status || '—')}</span>
          <div class="nh-prog big">
            <div class="nh-prog-bar"><span style="width:${p.pct}%"></span></div>
            <div class="nh-prog-label">${p.done} done / ${p.total - p.done} open · ${p.pct}%</div>
          </div>
        </div>
      </div>
      ${sectionsHtml}`;

    root.querySelector('#nh-back').addEventListener('click', () => {
      view = 'dashboard';
      selectedHireId = null;
      render();
    });
    root.querySelector('#nh-edit-hire').addEventListener('click', () => openHireModal(hire.id));
    root.querySelector('#nh-role-d').addEventListener('change', (e) => {
      filters.role = e.target.value;
      localStorage.setItem(ROLE_PREF_KEY, filters.role);
      render();
    });
    root.querySelector('#nh-reveal').addEventListener('change', (e) => {
      revealSensitive = e.target.checked;
      render();
    });
    root.querySelectorAll('[data-toggle-sec]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toggle-sec');
        openSections[id] = openSections[id] !== true;
        render();
      });
    });
    root.querySelectorAll('[data-field]').forEach((el) => {
      const save = () => {
        const itemId = el.getAttribute('data-field');
        const item = data.items.find((i) => i.id === itemId);
        let val = el.type === 'checkbox' ? el.checked : el.value;
        if (item?.sensitive && !revealSensitive && String(val).includes('••')) return;
        saveValue(hire.id, itemId, val);
        // Re-render so section bar colors + done/open counts stay accurate
        render();
      };
      el.addEventListener('change', save);
      if (el.type !== 'checkbox') el.addEventListener('blur', save);
    });
    root.querySelectorAll('[data-assignee]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const itemId = sel.getAttribute('data-assignee');
        progressOf(hire.id).assignees[itemId] = sel.value;
        persist();
      });
    });
  }

  function fieldRow(hire, it) {
    const mine = filters.role !== 'all' && it.role === filters.role;
    const raw = hire.values?.[it.id];
    const filled = isFilled(it, raw);
    const due = dueDateFor(hire, it);
    const overdue = isPastDue(due, filled);
    const who = assigneeOf(hire, it);
    const people = [...new Set([...peopleForRole(it.role), who].filter(Boolean))];
    let control = '';
    if (it.inputType === 'checkbox') {
      control = `<label class="nh-check-label"><input type="checkbox" data-field="${esc(it.id)}" ${filled ? 'checked' : ''}> Done</label>`;
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
      <div class="nh-task-row ${mine ? 'mine' : ''} ${filled ? 'filled' : 'open'} ${overdue ? 'overdue' : ''}">
        <div class="nh-task-assignee" title="${esc(who || 'Unassigned')} · ${esc(it.role)}">
          <select class="form-input nh-assignee" data-assignee="${esc(it.id)}" title="Assigned person">
            ${people.map((p) => `<option value="${esc(p)}" ${who === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
          </select>
          <span class="nh-role-chip">${esc(it.role)}</span>
        </div>
        <div class="nh-task-label">${esc(it.label)}${it.sensitive ? ' <span class="nh-lock">sensitive</span>' : ''}</div>
        <div class="nh-task-due ${overdue ? 'is-overdue' : ''}">${esc(fmtDate(due))}</div>
        <div class="nh-task-value">${control}</div>
        <div class="nh-field-status">${filled ? 'Done' : (overdue ? 'Past due' : 'Open')}</div>
      </div>`;
  }

  function saveValue(hireId, itemId, value) {
    const item = data.items.find((i) => i.id === itemId);
    if (!item) return;
    const p = progressOf(hireId);
    if (item.inputType === 'checkbox') {
      if (value) p.values[itemId] = true;
      else delete p.values[itemId];
    } else {
      const v = String(value ?? '').trim();
      if (v) p.values[itemId] = v;
      else delete p.values[itemId];
    }

    const emp = employees.find((e) => e.id === hireId);
    if (emp) {
      if (/^Region$/i.test(item.label)) emp.region = String(value || '');
      if (/START DATE/i.test(item.label)) emp.start_date = String(value || '') || null;
      if (/First Day of BOOTCAMP/i.test(item.label)) emp.bootcamp_start_date = String(value || '') || null;
      if (/Assigned Project Manager/i.test(item.label)) emp.assigned_pm = String(value || '');
      syncEmployeePatch(hireId, {
        region: emp.region,
        start_date: emp.start_date,
        bootcamp_start_date: emp.bootcamp_start_date,
        assigned_pm: emp.assigned_pm
      });
    }
    persist();
  }

  async function syncEmployeePatch(id, patch) {
    const supabase = client();
    if (!supabase) throw new Error('Not signed in');
    const body = {};
    ['region', 'start_date', 'bootcamp_start_date', 'assigned_pm', 'full_name', 'status', 'status_note', 'employee_type'].forEach((k) => {
      if (patch[k] !== undefined) body[k] = patch[k] || null;
    });
    if (!Object.keys(body).length) return;
    const { error } = await supabase.from('employees').update(body).eq('id', id);
    if (error) throw new Error(error.message);
  }

  function deleteProcessItem(id) {
    ensureData();
    const it = data.items.find((i) => i.id === id);
    if (!it || !confirm(`Delete "${it.label}" from the shared process?`)) return false;
    data.items = data.items.filter((i) => i.id !== id);
    data.items.forEach((item) => {
      if (item.dependsOnTaskId === id) {
        item.dependsOnTaskId = null;
        item.dependsOnPrior = false;
      }
    });
    Object.values(data.progress || {}).forEach((p) => {
      if (p.values) delete p.values[id];
      if (p.assignees) delete p.assignees[id];
    });
    persist();
    return true;
  }

  function taskLabelById(id) {
    const t = (data.items || []).find((i) => i.id === id);
    if (!t) return '';
    return `${t.sectionId}. ${t.label}`;
  }

  function dependencyOptionsHtml(currentId, selectedId) {
    ensureData();
    const groups = (data.sections || []).map((sec) => {
      const opts = itemsForSection(sec.id)
        .filter((i) => i.id !== currentId)
        .map((i) => `<option value="${esc(i.id)}" ${i.id === selectedId ? 'selected' : ''}>${esc(i.label)} (${esc(i.assignee || i.role)})</option>`)
        .join('');
      if (!opts) return '';
      return `<optgroup label="${esc(sec.id)}. ${esc(sec.title)}">${opts}</optgroup>`;
    }).join('');
    return `<option value="">Select prerequisite task…</option>${groups}`;
  }

  function bindProcessEditor(root, opts) {
    const onRefresh = opts && opts.onRefresh;
    const adminMode = !!(opts && opts.adminMode);
    root.querySelectorAll('[data-toggle-process-sec]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toggle-process-sec');
        processAdminOpen[id] = processAdminOpen[id] !== true;
        if (onRefresh) onRefresh();
      });
    });
    root.querySelectorAll('[data-add-section]').forEach((btn) => {
      btn.addEventListener('click', () => openItemModal(null, btn.getAttribute('data-add-section')));
    });
    root.querySelectorAll('[data-edit-item]').forEach((btn) => {
      btn.addEventListener('click', () => openItemModal(btn.getAttribute('data-edit-item')));
    });
    root.querySelectorAll('[data-del-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (deleteProcessItem(btn.getAttribute('data-del-item')) && onRefresh) onRefresh();
      });
    });
    if (adminMode) {
      root.querySelectorAll('[data-depends-item]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const id = cb.getAttribute('data-depends-item');
          const it = data.items.find((i) => i.id === id);
          if (!it) return;
          it.dependsOnPrior = !!cb.checked;
          if (!cb.checked) it.dependsOnTaskId = null;
          persist();
          processAdminOpen[it.sectionId] = true;
          if (onRefresh) onRefresh();
          // Focus the prerequisite picker after enabling dependency
          if (cb.checked) {
            setTimeout(() => {
              document.querySelector(`[data-depends-select="${id}"]`)?.focus();
            }, 0);
          }
        });
        cb.addEventListener('click', (e) => e.stopPropagation());
      });
      root.querySelectorAll('[data-depends-select]').forEach((sel) => {
        sel.addEventListener('change', () => {
          const id = sel.getAttribute('data-depends-select');
          const it = data.items.find((i) => i.id === id);
          if (!it) return;
          it.dependsOnTaskId = sel.value || null;
          it.dependsOnPrior = !!it.dependsOnTaskId;
          persist();
          processAdminOpen[it.sectionId] = true;
          if (onRefresh) onRefresh();
        });
        sel.addEventListener('click', (e) => e.stopPropagation());
      });
    }
  }

  function processSectionsHtml(opts) {
    ensureData();
    const adminMode = !!(opts && opts.adminMode);
    return (data.sections || []).map((sec) => {
      const items = itemsForSection(sec.id);
      const expanded = processAdminOpen[sec.id] === true;
      return `
        <div class="nh-section ${expanded ? 'open' : ''}">
          <button type="button" class="nh-section-head nh-bar-white" data-toggle-process-sec="${esc(sec.id)}">
            <div class="nh-section-left">
              <span class="nh-chevron">${expanded ? '▾' : '▸'}</span>
              <div class="nh-section-title">${esc(sec.id)}. ${esc(sec.title)}</div>
            </div>
            <div class="nh-section-right">
              <span class="nh-section-counts"><strong>${items.length}</strong> tasks</span>
            </div>
          </button>
          <div class="nh-section-body" ${expanded ? '' : 'hidden'}>
            <div class="nh-process-cat-actions">
              <button class="btn-primary" type="button" data-add-section="${esc(sec.id)}">+ Add task to ${esc(sec.id)}</button>
              <span class="nh-muted">${adminMode
                ? 'Check “Depends on another task first”, then pick the prerequisite task from the list.'
                : 'Assignee, role, field type, and due offset from start/bootcamp date'}</span>
            </div>
            <div class="nh-template-list">
              ${items.length ? items.map((it) => {
                const depOn = !!(it.dependsOnPrior || it.dependsOnTaskId);
                const depLabel = it.dependsOnTaskId ? taskLabelById(it.dependsOnTaskId) : '';
                return `
                <div class="nh-template-row${depOn ? ' nh-has-dependency' : ''}">
                  <div>
                    <div class="nh-field-label" style="font-size:13px;font-weight:600;color:#1e293b">${esc(it.label)}</div>
                    <div class="nh-todo-meta">
                      <span class="nh-person-role"><span class="nh-owner-chip">${esc(it.assignee)}</span><span class="nh-role-chip">${esc(it.role)}</span></span>
                      <span class="nh-type">${esc(it.inputType)}</span>
                      <span class="nh-due">${esc(it.dueAnchor)} ${it.dueOffsetDays >= 0 ? '+' : ''}${it.dueOffsetDays}d</span>
                      ${depOn && adminMode ? `<span class="nh-dep-badge">${depLabel ? 'Depends on: ' + esc(depLabel) : 'Pick prerequisite…'}</span>` : ''}
                    </div>
                  </div>
                  <div class="nh-template-actions">
                    ${adminMode ? `
                      <div class="nh-dep-block">
                        <label class="nh-dep-check" title="This task must wait for another task to be done first">
                          <input type="checkbox" data-depends-item="${esc(it.id)}" ${depOn ? 'checked' : ''}>
                          <span>Depends on another task first</span>
                        </label>
                        ${depOn ? `
                          <select class="form-input nh-dep-select" data-depends-select="${esc(it.id)}" title="Select prerequisite task">
                            ${dependencyOptionsHtml(it.id, it.dependsOnTaskId || '')}
                          </select>
                        ` : ''}
                      </div>
                    ` : ''}
                    <button class="btn-xs" type="button" data-edit-item="${esc(it.id)}">Edit</button>
                    <button class="btn-xs danger" type="button" data-del-item="${esc(it.id)}">Delete</button>
                  </div>
                </div>`;
              }).join('') : '<div class="nh-empty-block" style="border:none;margin:8px">No tasks in this category yet.</div>'}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function renderProcessAdmin(root) {
    if (!root) return;
    ensureData();
    if (!data.items?.length) data = seed();
    (data.sections || []).forEach((s) => {
      if (processAdminOpen[s.id] === undefined) processAdminOpen[s.id] = false;
    });
    const total = (data.items || []).length;
    root.innerHTML = `
      <p class="user-mgmt-subtitle" style="margin-bottom:12px">${total} tasks across ${(data.sections || []).length} categories. Expand a category to edit or add tasks. The dependency checkbox appears only here in Admin.</p>
      ${processSectionsHtml({ adminMode: true })}`;
    bindProcessEditor(root, {
      adminMode: true,
      onRefresh: () => renderProcessAdmin(root)
    });
  }

  function mountProcessAdmin() {
    ensureData();
    if (!data || !data.items?.length) data = seed();
    renderProcessAdmin(document.getElementById('nh-process-admin-root'));
  }

  function refreshAfterProcessChange() {
    const adminRoot = document.getElementById('nh-process-admin-root');
    if (adminRoot) renderProcessAdmin(adminRoot);
    if (document.getElementById('page-checklist')?.classList.contains('active')) render();
  }

  function renderTemplate(root) {
    setPageSub('Edit the shared process by category. Prefer Admin → New Hire Checklist Process when you are an Admin.');
    (data.sections || []).forEach((s) => {
      if (processAdminOpen[s.id] === undefined) processAdminOpen[s.id] = true;
    });
    root.innerHTML = `
      <div class="nh-detail-top">
        <button class="btn-secondary" type="button" id="nh-back-t">← Back</button>
        <button class="btn-primary" type="button" id="nh-add-item">+ Add task</button>
      </div>
      ${processSectionsHtml({ adminMode: false })}`;
    root.querySelector('#nh-back-t').addEventListener('click', () => { view = 'dashboard'; render(); });
    root.querySelector('#nh-add-item').addEventListener('click', () => openItemModal());
    bindProcessEditor(root, { adminMode: false, onRefresh: () => renderTemplate(root) });
  }

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
              <div><label class="form-label">Region *</label><input id="nh-hire-division" class="form-input" type="text"></div>
              <div><label class="form-label">Type</label>
                <select id="nh-hire-role" class="form-input">
                  <option value="technician">technician</option>
                  <option value="us_office">us_office</option>
                  <option value="intl_office">intl_office</option>
                </select>
              </div>
            </div>
            <div class="form-row-2">
              <div><label class="form-label">Start date *</label><input id="nh-hire-start" class="form-input" type="date"></div>
              <div><label class="form-label">Bootcamp start</label><input id="nh-hire-boot" class="form-input" type="date"></div>
            </div>
            <div class="form-row-2">
              <div><label class="form-label">Status</label>
                <select id="nh-hire-status" class="form-input">
                  <option value="active">active</option>
                  <option value="terminated">terminated</option>
                  <option value="quit">quit</option>
                  <option value="rescinded">rescinded</option>
                </select>
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
    const emp = id ? employees.find((e) => e.id === id) : null;
    document.getElementById('nh-hire-title').textContent = emp ? 'Edit hire' : 'Add new hire';
    document.getElementById('nh-hire-id').value = emp?.id || '';
    document.getElementById('nh-hire-name').value = emp?.full_name || '';
    document.getElementById('nh-hire-division').value = emp?.region || '';
    document.getElementById('nh-hire-role').value = emp?.employee_type || 'technician';
    document.getElementById('nh-hire-start').value = (emp?.start_date || '').slice(0, 10);
    document.getElementById('nh-hire-boot').value = (emp?.bootcamp_start_date || '').slice(0, 10);
    document.getElementById('nh-hire-status').value = emp?.status || 'active';
    document.getElementById('nh-hire-note').value = emp?.status_note || '';
    modal.classList.add('open');
  }

  function closeHireModal() {
    document.getElementById('nh-hire-modal')?.classList.remove('open');
  }

  async function saveHireModal() {
    const id = document.getElementById('nh-hire-id').value;
    const full_name = document.getElementById('nh-hire-name').value.trim();
    const region = document.getElementById('nh-hire-division').value.trim();
    const employee_type = document.getElementById('nh-hire-role').value;
    const start_date = document.getElementById('nh-hire-start').value || null;
    const bootcamp_start_date = document.getElementById('nh-hire-boot').value || null;
    const status = document.getElementById('nh-hire-status').value;
    const status_note = document.getElementById('nh-hire-note').value.trim() || null;
    if (!full_name || !region || !start_date) {
      alert('Name, region, and start date are required (due dates depend on start date).');
      return;
    }
    const supabase = client();
    const payload = { full_name, region, employee_type, start_date, bootcamp_start_date, status, status_note };
    if (id) {
      const { error } = await supabase.from('employees').update(payload).eq('id', id);
      if (error) { alert('Could not update employee: ' + error.message); return; }
      const emp = employees.find((e) => e.id === id);
      if (emp) Object.assign(emp, payload);
      const regionItem = data.items.find((i) => i.label === 'Region');
      const startItem = data.items.find((i) => /START DATE/i.test(i.label));
      const bootItem = data.items.find((i) => /First Day of BOOTCAMP/i.test(i.label));
      const p = progressOf(id);
      if (regionItem) p.values[regionItem.id] = region;
      if (startItem) p.values[startItem.id] = start_date;
      if (bootItem && bootcamp_start_date) p.values[bootItem.id] = bootcamp_start_date;
      persist();
    } else {
      const { data: created, error } = await supabase.from('employees').insert(payload).select(SELECT_COLS).single();
      if (error) { alert('Could not create employee: ' + error.message); return; }
      employees.unshift(created);
      selectedHireId = created.id;
      view = 'detail';
      const regionItem = data.items.find((i) => i.label === 'Region');
      const startItem = data.items.find((i) => /START DATE/i.test(i.label));
      const bootItem = data.items.find((i) => /First Day of BOOTCAMP/i.test(i.label));
      const p = progressOf(created.id);
      if (regionItem) p.values[regionItem.id] = region;
      if (startItem) p.values[startItem.id] = start_date;
      if (bootItem && bootcamp_start_date) p.values[bootItem.id] = bootcamp_start_date;
      persist();
    }
    closeHireModal();
    render();
  }

  function openItemModal(id, defaultSectionId) {
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
            <div class="form-row"><label class="form-label">Category *</label><select id="nh-item-section" class="form-input"></select></div>
            <div class="form-row"><label class="form-label">Task label *</label><input id="nh-item-label" class="form-input" type="text" placeholder="e.g. Date background check requested"></div>
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
    document.getElementById('nh-item-section').value = it?.sectionId || defaultSectionId || 'A';
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
        inputType, options, dueOffsetDays, dueAnchor, order: maxOrder + 1,
        sensitive: false, dependsOnPrior: false, dependsOnTaskId: null
      });
      processAdminOpen[sectionId] = true;
    }
    persist();
    closeItemModal();
    refreshAfterProcessChange();
    if (view === 'template') render();
  }

  function render() {
    ensureData();
    const root = document.getElementById('nh-checklist-root');
    if (!root) return;

    if (loading) {
      root.innerHTML = '<p class="nh-status">Loading employees…</p>';
      return;
    }
    if (loadError) {
      root.innerHTML = `<p class="nh-status nh-error">Failed to load employees: ${esc(loadError)}. Run the New Hire Checklist section of supabase-schema.sql if you have not yet.</p>`;
      return;
    }

    if (view === 'detail' && selectedHireId) renderDetail(root);
    else if (view === 'template') renderTemplate(root);
    else if (view === 'roster') renderRoster(root);
    else if (view === 'todo') renderTodo(root);
    else renderDashboard(root);
  }

  function applyRemote(value) {
    data = migrate(value);
    ensureData();
    const role = localStorage.getItem(ROLE_PREF_KEY);
    const person = localStorage.getItem(PERSON_PREF_KEY);
    if (role) filters.role = role;
    if (person) filters.person = person;
    // Start with every category collapsed
    data.sections.forEach((s) => {
      if (openSections[s.id] === undefined) openSections[s.id] = false;
    });
  }

  async function mount(opts) {
    const forceReload = !!(opts && opts.forceReload);
    ensureData();
    if (!data || !data.items?.length) data = seed();
    const role = localStorage.getItem(ROLE_PREF_KEY);
    const person = localStorage.getItem(PERSON_PREF_KEY);
    if (role) filters.role = role;
    if (person) filters.person = person;

    // Avoid reloading/re-rendering a huge todo list every time the nav tab is clicked
    if (mounted && !forceReload && !loading) {
      render();
      return;
    }
    mounted = true;
    await loadEmployees();
  }

  window.HubChecklist = {
    mount,
    loadEmployees,
    applyRemote,
    render,
    mountProcessAdmin,
    openItemModal
  };
})();
