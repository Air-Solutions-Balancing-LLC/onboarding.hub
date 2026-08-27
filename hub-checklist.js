// New Hire Checklist — Brian's employee roster + role-based My To-Do
(function () {
  const STORAGE_KEY = 'new_hire_checklist';
  const ROLE_PREF_KEY = 'nh_role_pref';
  const PERSON_PREF_KEY = 'nh_person_pref';
  // start_date = Orientation date (due-date anchor). work_start_date = Start date (techs for now).
  const SELECT_COLS =
    'id, full_name, preferred_name, employee_number, employee_type, status, status_note, region, city_center, start_date, work_start_date, bootcamp_start_date, company_email, assigned_pm';
  const OPTIONAL_EMP_COLS = ['city_center', 'work_start_date', 'preferred_name'];
  // Columns confirmed missing in this project's PostgREST schema (survive across saves)
  const missingEmpCols = new Set();

  function errText(err) {
    if (!err) return '';
    return [err.message, err.details, err.hint, err.code].filter(Boolean).join(' ');
  }

  function omitEmpCols(obj, omitSet) {
    const next = Object.assign({}, obj);
    (omitSet || []).forEach((k) => { delete next[k]; });
    return next;
  }

  function selectColsWithout(omitSet) {
    let cols = SELECT_COLS;
    (omitSet || []).forEach((k) => {
      cols = cols.replace(new RegExp(`,\\s*${k}\\b`, 'i'), '');
      cols = cols.replace(new RegExp(`\\b${k}\\s*,\\s*`, 'i'), '');
    });
    return cols;
  }

  function rememberMissingEmpCols(err) {
    const text = errText(err);
    let found = false;
    OPTIONAL_EMP_COLS.forEach((k) => {
      if (new RegExp(k, 'i').test(text) || /schema cache|PGRST204/i.test(text)) {
        // If schema-cache error names a column, only that one; if generic, drop all optional
        if (new RegExp(k, 'i').test(text)) {
          missingEmpCols.add(k);
          found = true;
        }
      }
    });
    if (!found && /schema cache|PGRST204|Could not find the/i.test(text)) {
      OPTIONAL_EMP_COLS.forEach((k) => missingEmpCols.add(k));
      found = true;
    }
    return found;
  }

  let data = null; // { version, roles, sections, items, progress }
  let employees = [];
  let view = 'dashboard'; // dashboard (People) | todo (My work) | reports | roster | archive | detail | template
  let detailReturnView = 'dashboard';
  let reportKind = 'cohorts'; // cohorts | onboard | it | missing
  let reportCohort = ''; // YYYY-MM-DD orientation date or '' = auto
  let reportMissingHireId = '__all__'; // '__all__' | hire id
  let userDefaultsApplied = false;
  const STATUS_OPTIONS = ['active', 'archived', 'terminated', 'quit', 'rescinded', 'resigned'];
  const ARCHIVE_STATUSES = ['archived', 'terminated', 'quit', 'rescinded', 'resigned'];
  const STATUS_LABELS = {
    active: 'Active',
    archived: 'Archive',
    terminated: 'Terminated',
    quit: 'Quit',
    rescinded: 'Rescinded',
    resigned: 'Resigned'
  };
  const REGION_OPTIONS = [
    'New England',
    'Mid-Atlantic',
    'Southeast',
    'Mid-West',
    'Southwest',
    'Rocky Mountain',
    'Intermountain',
    'Pacific',
    'National',
    'KES'
  ];
  // value stored in employees.employee_type
  const POSITION_OPTIONS = [
    { value: 'technician', label: 'TAB Technician' },
    { value: 'kes_installer', label: 'KES Installer' },
    { value: 'office_staff', label: 'Office Staff' }
  ];
  // Fill in when the team confirms the official list
  const CITY_CENTER_OPTIONS = [];
  let processAdminOpen = {}; // category expand state in Admin
  let selectedHireId = null;
  let openSections = {};
  let filters = {
    q: '',
    status: 'active',
    role: 'HR',
    person: 'all',
    todoScope: 'week',
    hireWindow: 'onboarding',
    archiveStatus: 'all',
    cols: {
      name: '',
      position: '',
      region: '',
      city_center: '',
      orientation: '',
      start: '',
      bootcamp: '',
      status: ''
    }
  };
  let revealSensitive = false;
  let saveTimer = null;
  let loading = true;
  let loadError = null;
  let mounted = false;
  let todoLimit = 40; // hire groups shown (not flat task rows)
  let todoOpenHires = {}; // hireId -> expanded
  const COLUMN_VISIBILITY_KEY = 'nh_dashboard_column_visibility_v1';
  const PROFILE_COLUMNS = [
    { id: 'position', label: 'Position' },
    { id: 'region', label: 'Region' },
    { id: 'city_center', label: 'City center' },
    { id: 'orientation', label: 'Orientation' },
    { id: 'start', label: 'Start' },
    { id: 'bootcamp', label: 'Bootcamp' },
    { id: 'status', label: 'Status' },
    { id: 'overall', label: 'Overall' },
    { id: 'resume', label: 'Resume' }
  ];
  const LOCKED_COLUMNS = ['_num', 'name', '_actions'];
  let columnVisibility = readColumnVisibility();
  let columnMenuBound = false;

  function sectionColumns() {
    return (data && data.sections ? data.sections : []).map((sec) => ({
      id: 'sec-' + sec.id,
      label: sec.id + ' — ' + (sec.title || sec.id)
    }));
  }

  function toggleableColumns() {
    return PROFILE_COLUMNS.concat(sectionColumns());
  }

  function readColumnVisibility() {
    try {
      const raw = localStorage.getItem(COLUMN_VISIBILITY_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeColumnVisibility() {
    try {
      localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(columnVisibility));
    } catch (_) { /* ignore */ }
  }

  function isColumnVisible(id) {
    return columnVisibility[id] !== false;
  }

  function visibleColumnCount() {
    let n = LOCKED_COLUMNS.length;
    toggleableColumns().forEach((c) => {
      if (isColumnVisible(c.id)) n += 1;
    });
    return n;
  }

  function ensureColumnHideStyles() {
    let style = document.getElementById('nhSheetColumnHideStyles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'nhSheetColumnHideStyles';
      document.head.appendChild(style);
    }
    style.textContent = toggleableColumns().map((c) => {
      const id = String(c.id).replace(/[^a-zA-Z0-9_-]/g, '');
      return `.nh-sheet.hide-col-${id} th[data-col="${id}"],` +
        `.nh-sheet.hide-col-${id} td[data-col="${id}"]{display:none !important;}`;
    }).join('\n');
  }

  function applyColumnVisibility() {
    ensureColumnHideStyles();
    const table = document.querySelector('table.nh-sheet');
    if (table) {
      toggleableColumns().forEach((c) => {
        table.classList.toggle('hide-col-' + c.id, !isColumnVisible(c.id));
      });
      if (window.HubShell && HubShell.syncStickyOffsets) HubShell.syncStickyOffsets(table);
    }
    const btn = document.getElementById('nh-column-visibility-btn');
    if (btn) {
      const hidden = toggleableColumns().filter((c) => !isColumnVisible(c.id)).length;
      btn.textContent = hidden ? `Show/Hide columns (${hidden} hidden)` : 'Show/Hide columns';
      btn.classList.toggle('is-active', hidden > 0);
    }
    const menu = document.getElementById('nh-column-visibility-menu');
    if (menu) {
      menu.querySelectorAll('input[data-col-toggle]').forEach((input) => {
        input.checked = isColumnVisible(input.getAttribute('data-col-toggle'));
      });
    }
  }

  function setColumnVisible(id, visible) {
    if (!toggleableColumns().some((c) => c.id === id)) return;
    columnVisibility[id] = !!visible;
    writeColumnVisibility();
    applyColumnVisibility();
  }

  function setColumnGroupVisible(ids, visible) {
    ids.forEach((id) => { columnVisibility[id] = !!visible; });
    writeColumnVisibility();
    applyColumnVisibility();
  }

  function closeColumnVisibilityMenu() {
    const menu = document.getElementById('nh-column-visibility-menu');
    const btn = document.getElementById('nh-column-visibility-btn');
    if (menu) menu.remove();
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function columnOptionHtml(c) {
    return `<label class="column-visibility-option" role="menuitemcheckbox">
      <input type="checkbox" data-col-toggle="${esc(c.id)}" ${isColumnVisible(c.id) ? 'checked' : ''} />
      ${esc(c.label)}
    </label>`;
  }

  function openColumnVisibilityMenu() {
    const btn = document.getElementById('nh-column-visibility-btn');
    if (!btn) return;
    closeColumnVisibilityMenu();
    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'nh-column-visibility-menu';
    menu.className = 'column-visibility-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Show or hide columns');
    menu.style.top = Math.round(rect.bottom + 6) + 'px';
    menu.style.left = Math.round(rect.left) + 'px';
    const process = sectionColumns();
    menu.innerHTML = `
      <div class="column-visibility-actions">
        <button type="button" data-col-vis="all">Show all</button>
        ${process.length ? '<button type="button" data-col-vis="hide-process">Hide process</button>' : ''}
      </div>
      <div class="column-visibility-heading">Profile</div>
      ${PROFILE_COLUMNS.map(columnOptionHtml).join('')}
      ${process.length ? `<div class="column-visibility-heading">Process</div>${process.map(columnOptionHtml).join('')}` : ''}
    `;
    menu.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
    });
    menu.addEventListener('change', (e) => {
      const input = e.target.closest('input[data-col-toggle]');
      if (!input) return;
      setColumnVisible(input.getAttribute('data-col-toggle'), input.checked);
    });
    menu.addEventListener('click', (e) => {
      const action = e.target.closest('[data-col-vis]');
      if (!action) return;
      if (action.getAttribute('data-col-vis') === 'all') {
        setColumnGroupVisible(toggleableColumns().map((c) => c.id), true);
      } else if (action.getAttribute('data-col-vis') === 'hide-process') {
        setColumnGroupVisible(sectionColumns().map((c) => c.id), false);
      }
    });
    document.body.appendChild(menu);
    btn.setAttribute('aria-expanded', 'true');
    const place = () => {
      if (window.HubShell && HubShell.placeFixedPopup) {
        HubShell.placeFixedPopup(menu, btn, { prefer: 'below', gap: 6, pad: 8, maxHeight: 420 });
      }
    };
    place();
    requestAnimationFrame(place);
  }

  function toggleColumnVisibilityMenu() {
    if (document.getElementById('nh-column-visibility-menu')) closeColumnVisibilityMenu();
    else openColumnVisibilityMenu();
  }

  function bindColumnVisibility(root) {
    const btn = root.querySelector('#nh-column-visibility-btn');
    if (!btn) {
      closeColumnVisibilityMenu();
      return;
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleColumnVisibilityMenu();
    });
    if (!columnMenuBound) {
      columnMenuBound = true;
      document.addEventListener('click', (e) => {
        const menu = document.getElementById('nh-column-visibility-menu');
        const currentBtn = document.getElementById('nh-column-visibility-btn');
        if (!menu) return;
        if (menu.contains(e.target) || (currentBtn && currentBtn.contains(e.target))) return;
        closeColumnVisibilityMenu();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeColumnVisibilityMenu();
      });
      window.addEventListener('resize', () => closeColumnVisibilityMenu());
    }
    applyColumnVisibility();
  }

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
        dueDaysBefore: old.dueDaysBefore != null ? old.dueDaysBefore : bi.dueDaysBefore,
        sensitive: old.sensitive != null ? old.sensitive : bi.sensitive,
        dependsOnPrior: !!(old.dependsOnPrior || old.dependsOnTaskId || bi.dependsOnPrior || bi.dependsOnTaskId),
        dependsOnTaskId: old.dependsOnTaskId || bi.dependsOnTaskId || null,
        checklistSteps: Array.isArray(old.checklistSteps) ? old.checklistSteps : (bi.checklistSteps || []),
        link: (old.link != null && String(old.link).trim()) ? String(old.link).trim() : (bi.link || ''),
        order: old.order != null ? old.order : bi.order,
        sectionId: old.sectionId || bi.sectionId
      });
    });
    (raw.items || []).forEach((oi) => {
      if (oi.id && String(oi.id).startsWith('t') && oi.label && oi.role && !items.find((i) => i.id === oi.id)) {
        items.push(Object.assign({
          role: 'HR', assignee: 'Lisa', inputType: 'text', options: [],
          dueOffsetDays: 0, dueAnchor: 'orientation', dueDaysBefore: 0, sensitive: false,
          dependsOnPrior: false, dependsOnTaskId: null, checklistSteps: [], link: '',
          order: items.length + 1
        }, oi));
      }
    });
    // Normalize dependency flags + due-date fields
    items.forEach((it) => {
      if (it.dependsOnTaskId && !items.find((x) => x.id === it.dependsOnTaskId)) {
        it.dependsOnTaskId = null;
      }
      it.dependsOnPrior = !!it.dependsOnTaskId || !!it.dependsOnPrior;
      if (!it.dependsOnPrior) it.dependsOnTaskId = null;
      it.link = (it.link && String(it.link).trim()) || '';
      normalizeItemDue(it);
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

  function todayIso() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  function progressOf(empId) {
    ensureData();
    if (!data.progress[empId]) data.progress[empId] = { values: {}, assignees: {}, checklists: {} };
    if (!data.progress[empId].values) data.progress[empId].values = {};
    if (!data.progress[empId].assignees) data.progress[empId].assignees = {};
    if (!data.progress[empId].checklists) data.progress[empId].checklists = {};
    return data.progress[empId];
  }

  function normalizeSteps(item) {
    const raw = (item && item.checklistSteps) || [];
    return raw.map((s, i) => {
      if (typeof s === 'string') {
        return { id: 's' + i, label: s };
      }
      return {
        id: s.id || ('s' + i),
        label: String(s.label || '').trim()
      };
    }).filter((s) => s.label);
  }

  function taskLinkUrl(item) {
    const raw = item && item.link != null ? String(item.link).trim() : '';
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^mailto:/i.test(raw)) return raw;
    return 'https://' + raw;
  }

  function taskLinkHtml(item, label) {
    const href = taskLinkUrl(item);
    if (!href) return '';
    return `<a class="nh-task-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label || 'Open link')}</a>`;
  }

  function checklistProgress(hire, item) {
    const steps = normalizeSteps(item);
    if (!steps.length) return null;
    const cl = (hire.checklists && hire.checklists[item.id]) || {};
    const done = steps.filter((s) => !!cl[s.id]).length;
    return { done, total: steps.length, pct: Math.round((done / steps.length) * 100), steps, map: cl };
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
      name: displayHireName(emp),
      fullName: emp.full_name || '',
      preferredName: emp.preferred_name || '',
      division: emp.region || '',
      cityCenter: emp.city_center || '',
      role: emp.employee_type || '',
      startDate: emp.start_date || '', // Orientation date
      workStartDate: emp.work_start_date || '',
      bootcampDate: emp.bootcamp_start_date || '',
      status: emp.status || 'active',
      statusNote: emp.status_note || '',
      employeeNumber: emp.employee_number,
      employeeType: emp.employee_type,
      companyEmail: emp.company_email || '',
      assignedPm: emp.assigned_pm || '',
      values: p.values,
      assignees: p.assignees,
      checklists: p.checklists,
      _emp: emp
    };
  }

  function parseGoesByFromFullName(full) {
    const raw = String(full || '').trim();
    const m = raw.match(/^(.*?)\s*\(\s*Goes\s+by\s+(.+?)\s*\)\s*$/i);
    if (!m) return { full_name: raw, preferred_name: '' };
    return { full_name: m[1].trim(), preferred_name: m[2].trim() };
  }

  function displayHireName(emp) {
    if (!emp) return '';
    let full = String(emp.full_name || emp.name || '').trim();
    let goes = String(emp.preferred_name || '').trim();
    const parsed = parseGoesByFromFullName(full);
    if (parsed.preferred_name) {
      full = parsed.full_name;
      if (!goes) goes = parsed.preferred_name;
    }
    if (goes && goes.toLowerCase() !== full.toLowerCase()) return `${full} (${goes})`;
    return full;
  }

  function employeeNameKey(emp) {
    return normalizeNameKey(displayHireName(emp) || emp?.full_name || emp?.name || '');
  }

  function preferEmployeeRecord(a, b) {
    ensureData();
    const filled = (e) => Object.keys((data.progress?.[e.id]?.values) || {}).length;
    const fa = filled(a);
    const fb = filled(b);
    if (fa !== fb) return fa >= fb ? a : b;
    const na = Number(a.employee_number) || 0;
    const nb = Number(b.employee_number) || 0;
    if (na !== nb) return na >= nb ? a : b;
    if (!!a.start_date !== !!b.start_date) return a.start_date ? a : b;
    return String(a.id).localeCompare(String(b.id)) <= 0 ? a : b;
  }

  function mergeHireProgress(keepId, fromId) {
    if (!keepId || !fromId || keepId === fromId) return;
    ensureData();
    const keep = progressOf(keepId);
    const from = data.progress[fromId];
    if (!from) return;
    Object.keys(from.values || {}).forEach((k) => {
      const cur = keep.values[k];
      const next = from.values[k];
      if (cur == null || cur === '' || cur === false) keep.values[k] = next;
    });
    Object.keys(from.assignees || {}).forEach((k) => {
      if (!keep.assignees[k]) keep.assignees[k] = from.assignees[k];
    });
    Object.keys(from.checklists || {}).forEach((itemId) => {
      if (!keep.checklists[itemId]) keep.checklists[itemId] = {};
      Object.assign(keep.checklists[itemId], from.checklists[itemId] || {});
    });
  }

  /** Drop duplicate Active rows with the same person name (keep the richer record). */
  function collapseActiveEmployeeDuplicatesInMemory() {
    ensureData();
    const keepByKey = new Map();
    const dropIds = new Set();
    employees.forEach((e) => {
      if ((e.status || 'active').toLowerCase() !== 'active') return;
      const key = employeeNameKey(e);
      if (!key) return;
      const prev = keepByKey.get(key);
      if (!prev) {
        keepByKey.set(key, e);
        return;
      }
      const keep = preferEmployeeRecord(prev, e);
      const drop = keep === prev ? e : prev;
      mergeHireProgress(keep.id, drop.id);
      keepByKey.set(key, keep);
      dropIds.add(drop.id);
    });
    if (!dropIds.size) return;
    employees = employees.filter((e) => !dropIds.has(e.id));
    persist();
  }

  function hires() {
    ensureData();
    return employees.map(empToHire);
  }

  const DUE_ANCHORS = [
    { value: 'orientation', label: 'Orientation date' },
    { value: 'work_start', label: 'Start date' },
    { value: 'bootcamp', label: 'Bootcamp date' }
  ];

  function normalizeDueAnchor(anchor) {
    const a = String(anchor || '').toLowerCase();
    if (a === 'bootcamp') return 'bootcamp';
    if (a === 'work_start' || a === 'work' || a === 'employment' || a === 'start_date') return 'work_start';
    // legacy "start" meant Orientation (stored in start_date)
    return 'orientation';
  }

  function daysBeforeOf(item) {
    if (!item) return 0;
    if (item.dueDaysBefore != null && item.dueDaysBefore !== '') {
      return Math.max(0, parseInt(item.dueDaysBefore, 10) || 0);
    }
    const off = parseInt(item.dueOffsetDays, 10) || 0;
    // Legacy: negative offset = days before; positive (days after) kept via dueOffsetDays until edited
    return off < 0 ? -off : 0;
  }

  function normalizeItemDue(it) {
    if (!it) return it;
    it.dueAnchor = normalizeDueAnchor(it.dueAnchor);
    if (it.dueDaysBefore == null || it.dueDaysBefore === '') {
      const off = parseInt(it.dueOffsetDays, 10);
      if (!Number.isNaN(off) && off < 0) it.dueDaysBefore = -off;
      else if (!Number.isNaN(off) && off > 0) {
        // keep legacy "days after" as negative days-before equivalent via offset only
        it.dueDaysBefore = 0;
      } else {
        it.dueDaysBefore = 0;
      }
    } else {
      it.dueDaysBefore = Math.max(0, parseInt(it.dueDaysBefore, 10) || 0);
    }
    // Canonical storage: days before → negative offset (unless legacy positive offset and daysBefore still 0)
    const off = parseInt(it.dueOffsetDays, 10) || 0;
    if (it.dueDaysBefore > 0 || off <= 0) {
      it.dueOffsetDays = -it.dueDaysBefore;
    }
    return it;
  }

  function dueAnchorLabel(anchor) {
    const a = normalizeDueAnchor(anchor);
    return (DUE_ANCHORS.find((x) => x.value === a) || DUE_ANCHORS[0]).label;
  }

  function dueRuleLabel(item) {
    const days = daysBeforeOf(item);
    const base = dueAnchorLabel(item && item.dueAnchor);
    if (days === 0) return `On ${base}`;
    return `${days} day${days === 1 ? '' : 's'} before ${base}`;
  }

  function dueDateFor(hire, item) {
    const anchor = normalizeDueAnchor(item && item.dueAnchor);
    let base = null;
    if (anchor === 'bootcamp') {
      base = parseDate(hire.bootcampDate) || parseDate(hire.startDate);
    } else if (anchor === 'work_start') {
      base = parseDate(hire.workStartDate) || parseDate(hire.startDate);
    } else {
      base = parseDate(hire.startDate); // Orientation date
    }
    if (!base) return null;
    // Prefer days-before model; fall back to legacy offset (supports old "days after")
    if (item.dueDaysBefore != null && item.dueDaysBefore !== '') {
      return addDays(base, -daysBeforeOf(item));
    }
    return addDays(base, item.dueOffsetDays || 0);
  }

  function dueAnchorOptionsHtml(selected) {
    const cur = normalizeDueAnchor(selected);
    return DUE_ANCHORS.map((a) =>
      `<option value="${esc(a.value)}" ${a.value === cur ? 'selected' : ''}>${esc(a.label)}</option>`
    ).join('');
  }

  function isFilled(item, val, hire) {
    const steps = normalizeSteps(item);
    if (steps.length && hire) {
      const cl = (hire.checklists && hire.checklists[item.id]) || {};
      return steps.every((s) => !!cl[s.id]);
    }
    if (item.inputType === 'checkbox') return val === true || val === 'true' || val === 'Yes' || val === 1;
    const v = String(val ?? '').trim();
    if (!v) return false;
    if (/^(n\/a|na|—|-|pending|not yet|tbd)$/i.test(v)) return false;
    return true;
  }

  function assigneeOf(hire, item) {
    return (hire.assignees && hire.assignees[item.id]) || item.assignee || item.owner || '';
  }

  function mapAppUserToChecklistRole(appUser) {
    const role = String(appUser?.role || '').toLowerCase().trim();
    const map = {
      admin: 'Admin',
      project_manager: 'PM',
      project_engineer: 'PM',
      bid_coordinator: 'PM',
      estimator: 'PM',
      pm: 'PM',
      hr: 'HR',
      finance: 'HR',
      general_office: 'HR',
      social_media: 'HR', // checklist person Maria stays on HR tasks
      accounting: 'HR',
      logistics: 'Logistics',
      training: 'Training',
      technician: 'all'
    };
    return map[role] || 'all';
  }

  function isHubAdminUser(appUser) {
    const role = String(appUser?.role || '').toLowerCase().trim();
    return role === 'admin';
  }

  function canManageAllTasks() {
    if (window.HubAuth && HubAuth.isRealAdmin && HubAuth.isRealAdmin()) return true;
    return isHubAdminUser(window.hubCurrentUser);
  }

  function viewerChecklistName() {
    if (!window.hubCurrentUser) return 'all';
    return matchChecklistPerson(window.hubCurrentUser, 'all');
  }

  function namesRoughMatch(a, b) {
    const ka = normalizeNameKey(a);
    const kb = normalizeNameKey(b);
    if (!ka || !kb) return false;
    if (ka === kb) return true;
    const fa = ka.split(' ')[0];
    const fb = kb.split(' ')[0];
    if (fa && fb && fa === fb) return true;
    if (fa.length >= 4 && kb.startsWith(fa)) return true;
    if (fb.length >= 4 && ka.startsWith(fb)) return true;
    return false;
  }

  function ownsAssigneeName(assignee) {
    if (canManageAllTasks()) return true;
    const me = viewerChecklistName();
    if (!me || me === 'all') return false;
    return namesRoughMatch(assignee, me);
  }

  function ownsProcessItem(item) {
    if (!item) return false;
    return ownsAssigneeName(item.assignee || item.owner || '');
  }

  function ownsHireTask(hire, item) {
    return ownsAssigneeName(assigneeOf(hire, item));
  }

  function applyMyTasksFilter() {
    ensureData();
    const user = window.hubCurrentUser;
    if (!user) {
      alert('Sign in to filter to your tasks.');
      return;
    }
    const matched = matchChecklistPerson(user, 'all');
    if (matched !== 'all') {
      filters.person = matched;
      filters.role = primaryRoleForPerson(matched) || mapAppUserToChecklistRole(user);
    } else {
      filters.role = mapAppUserToChecklistRole(user);
      filters.person = 'all';
    }
    localStorage.setItem(ROLE_PREF_KEY, filters.role);
    localStorage.setItem(PERSON_PREF_KEY, filters.person);
    render();
  }

  function primaryRoleForPerson(personName) {
    if (!personName || personName === 'all') return null;
    const key = normalizeNameKey(personName);
    const roles = data.roles || [];
    for (let i = 0; i < roles.length; i++) {
      const hit = (roles[i].people || []).find((p) => normalizeNameKey(p) === key);
      if (hit) return roles[i].id;
    }
    const item = (data.items || []).find((it) => normalizeNameKey(it.assignee || '') === key);
    return item ? item.role : null;
  }

  function matchChecklistPerson(appUser, roleId) {
    const full = String(appUser?.full_name || '').trim();
    if (!full) return 'all';
    const people = peopleForRole(roleId === 'all' ? 'all' : roleId);
    const fullKey = normalizeNameKey(full);
    const first = fullKey.split(' ')[0];
    const exact = people.find((p) => normalizeNameKey(p) === fullKey);
    if (exact) return exact;
    const byFirst = people.find((p) => {
      const pk = normalizeNameKey(p);
      return (
        pk === first ||
        pk.startsWith(first + ' ') ||
        fullKey.includes(pk) ||
        (first.length >= 4 && pk.startsWith(first)) // Jess → Jessa
      );
    });
    return byFirst || 'all';
  }

  function applySignedInUserDefaults(force) {
    ensureData();
    const user = window.hubCurrentUser;
    if (!user) return;
    if (userDefaultsApplied && !force) return;
    // Named owners (Ana, Lisa, …) open on their own role + name.
    // Hub admins who are not a named checklist person (Brian) get the full overview.
    const matched = matchChecklistPerson(user, 'all');
    if (matched !== 'all') {
      filters.role = primaryRoleForPerson(matched) || mapAppUserToChecklistRole(user);
      filters.person = matched;
    } else if (isHubAdminUser(user)) {
      filters.role = 'all';
      filters.person = 'all';
    } else {
      filters.role = mapAppUserToChecklistRole(user);
      filters.person = 'all';
    }
    localStorage.setItem(ROLE_PREF_KEY, filters.role);
    localStorage.setItem(PERSON_PREF_KEY, filters.person);
    userDefaultsApplied = true;
  }

  function openHireDetail(hireId) {
    if (view !== 'detail') detailReturnView = view || 'dashboard';
    selectedHireId = hireId;
    openSections = {};
    (data.sections || []).forEach((s) => { openSections[s.id] = false; });
    view = 'detail';
    try {
      history.pushState(
        { hubNh: true, view: 'detail', hireId, returnView: detailReturnView },
        '',
        window.location.pathname || '/'
      );
    } catch (e) { /* ignore */ }
    render();
  }

  function leaveHireDetail(opts) {
    const fromPop = !!(opts && opts.fromPopstate);
    const archived = selectedHireId && isArchivedStatus((employees.find((e) => e.id === selectedHireId) || {}).status);
    selectedHireId = null;
    view = detailReturnView || (archived ? 'archive' : 'dashboard');
    if (!fromPop) {
      try {
        history.pushState({ hubNh: true, view }, '', window.location.pathname || '/');
      } catch (e) { /* ignore */ }
    }
    render();
  }

  function hubHistoryPath() {
    return window.location.pathname || '/';
  }

  function claimHistory(state) {
    try {
      history.replaceState(state || { hubNh: true, view }, '', hubHistoryPath());
    } catch (e) { /* ignore */ }
  }

  function bindBrowserNav() {
    if (bindBrowserNav._bound) return;
    bindBrowserNav._bound = true;
    claimHistory({ hubNh: true, view: view === 'detail' ? 'dashboard' : view });
    window.addEventListener('popstate', (ev) => {
      const st = ev.state;
      if (st && st.hubNh) {
        view = st.view || 'dashboard';
        selectedHireId = st.hireId || null;
        if (st.returnView) detailReturnView = st.returnView;
        if (view !== 'detail') selectedHireId = null;
        render();
        return;
      }
      // Leaving Microsoft / OAuth history: stay inside the Hub
      if (view === 'detail') {
        leaveHireDetail({ fromPopstate: true });
      }
      claimHistory({ hubNh: true, view });
    });
  }

  function peopleForRole(roleId) {
    if (roleId === 'PM') return [];
    if (roleId === 'all') {
      const all = [];
      (data.roles || []).forEach((r) => {
        if (r.id === 'PM') return;
        (r.people || []).forEach((p) => { if (p && !all.includes(p)) all.push(p); });
      });
      data.items.forEach((i) => {
        if (i.role === 'PM') return;
        if (i.assignee && !all.includes(i.assignee)) all.push(i.assignee);
      });
      return all.filter(Boolean).sort((a, b) => a.localeCompare(b));
    }
    const r = (data.roles || []).find((x) => x.id === roleId);
    const base = r ? r.people.slice() : [];
    data.items.forEach((i) => {
      if (i.role === roleId && i.assignee && !base.includes(i.assignee)) base.push(i.assignee);
    });
    return base.filter(Boolean);
  }

  function itemsForSection(sectionId) {
    return data.items.filter((i) => i.sectionId === sectionId).sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function matchesRolePersonFilter(hire, item, roleFilter, personFilter) {
    // PMs are out of the Hub checklist views (kept in Edit process only)
    if (item && item.role === 'PM') return false;
    const role = roleFilter != null ? roleFilter : filters.role;
    const person = personFilter != null ? personFilter : filters.person;
    if (role && role !== 'all' && item.role !== role) return false;
    if (person && person !== 'all' && assigneeOf(hire, item) !== person) return false;
    return true;
  }

  function itemsForHireFilter(hire, items, roleFilter, personFilter) {
    return (items || data.items || []).filter((it) =>
      matchesRolePersonFilter(hire, it, roleFilter, personFilter)
    );
  }

  function hireProgress(hire, roleFilter, personFilter) {
    const items = itemsForHireFilter(hire, data.items, roleFilter, personFilter);
    const total = items.length;
    let done = 0;
    items.forEach((it) => { if (isFilled(it, hire.values?.[it.id], hire)) done++; });
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function isActiveHire(h) {
    return (h.status || '').toLowerCase() === 'active';
  }

  function isArchivedStatus(status) {
    return ARCHIVE_STATUSES.includes(String(status || '').toLowerCase());
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
          // My To-Do default view excludes PM tasks
          if (item.role === 'PM') return;
          if (filters.role !== 'all' && item.role !== filters.role) return;
          const who = assigneeOf(hire, item);
          if (filters.person !== 'all' && who !== filters.person) return;
          const done = isFilled(item, hire.values?.[item.id], hire);
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

  function todoGroups(entries) {
    const map = new Map();
    (entries || []).forEach((e) => {
      // Prefer id, but collapse same-name actives if duplicate employee rows slipped through
      const nameKey = normalizeNameKey(e.hire.name || e.hire.fullName || '');
      const id = nameKey ? `name:${nameKey}` : e.hire.id;
      if (!map.has(id)) {
        map.set(id, {
          hire: e.hire,
          tasks: [],
          open: 0,
          overdue: 0,
          done: 0,
          _seenItems: new Set()
        });
      }
      const g = map.get(id);
      // Keep the hire record that already has more progress when names collide
      if (e.hire.id !== g.hire.id) {
        const filled = (h) => Object.keys(h.values || {}).length;
        if (filled(e.hire) > filled(g.hire)) g.hire = e.hire;
      }
      if (g._seenItems.has(e.item.id)) return;
      g._seenItems.add(e.item.id);
      g.tasks.push(e);
      if (e.done) g.done += 1;
      else g.open += 1;
      if (e.bucket === 'overdue') g.overdue += 1;
    });
    return [...map.values()].map((g) => {
      delete g._seenItems;
      return g;
    }).sort((a, b) => {
      if (a.overdue !== b.overdue) return b.overdue - a.overdue;
      if (a.open !== b.open) return b.open - a.open;
      return a.hire.name.localeCompare(b.hire.name);
    });
  }

  function statusBadgeClass(status) {
    const map = {
      active: 'nh-badge nh-badge-active',
      archived: 'nh-badge nh-badge-muted',
      terminated: 'nh-badge nh-badge-danger',
      quit: 'nh-badge nh-badge-danger',
      resigned: 'nh-badge nh-badge-warn',
      rescinded: 'nh-badge nh-badge-muted',
    };
    return map[status] || 'nh-badge nh-badge-muted';
  }

  function formatStatusLabel(status) {
    const key = String(status || '').toLowerCase();
    return STATUS_LABELS[key] || String(status || '—').replace(/_/g, ' ');
  }

  function typeBadgeClass(type) {
    const map = {
      technician: 'nh-badge nh-badge-tech',
      kes_installer: 'nh-badge nh-badge-intl',
      office_staff: 'nh-badge nh-badge-office',
      us_office: 'nh-badge nh-badge-office',
      intl_office: 'nh-badge nh-badge-intl',
    };
    return map[type] || 'nh-badge nh-badge-muted';
  }

  function formatType(type) {
    const hit = POSITION_OPTIONS.find((p) => p.value === type);
    if (hit) return hit.label;
    return String(type || '—').replace(/_/g, ' ');
  }

  function positionText(type) {
    if (!type) return '—';
    return esc(formatType(normalizePosition(type)));
  }

  function regionText(region) {
    return esc(normalizeRegion(region) || region || '—');
  }

  function cityCenterText(city) {
    const v = String(city || '').trim();
    return esc(v || '—');
  }

  function normalizePosition(type) {
    const t = String(type || '').toLowerCase().trim();
    if (!t) return 'technician';
    if (POSITION_OPTIONS.some((p) => p.value === t)) return t;
    if (t === 'tab technician' || t === 'tab_technician') return 'technician';
    if (t.includes('kes')) return 'kes_installer';
    if (t.includes('office') || t === 'us_office' || t === 'intl_office') return 'office_staff';
    return t;
  }

  function normalizeRegion(region) {
    const raw = String(region || '').trim();
    if (!raw) return '';
    const hit = REGION_OPTIONS.find((r) => r.toLowerCase() === raw.toLowerCase());
    if (hit) return hit;
    const lower = raw.toLowerCase();
    // Old titles like "KES Assistant Project Manager" → KES only
    if (lower === 'kes' || lower.startsWith('kes ') || lower.startsWith('kes/') || lower.includes(' kes ')) {
      return 'KES';
    }
    // common aliases from older data
    const aliases = {
      'mid atlantic': 'Mid-Atlantic',
      midwest: 'Mid-West',
      'mid west': 'Mid-West',
      'pacific coast': 'Pacific',
      'rocky mountains': 'Rocky Mountain'
    };
    return aliases[lower] || raw;
  }

  function filteredEmployees(opts) {
    const onboardingWindowOnly = !!(opts && opts.onboardingWindowOnly);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const q = filters.q.trim().toLowerCase();
    const c = filters.cols || {};
    return employees.filter((e) => {
      const matchSearch =
        !q ||
        (e.full_name || '').toLowerCase().includes(q) ||
        (e.preferred_name || '').toLowerCase().includes(q) ||
        displayHireName(e).toLowerCase().includes(q) ||
        (e.company_email || '').toLowerCase().includes(q) ||
        String(e.employee_number ?? '').includes(q);
      // Dashboard / Roster: active only (archived hires live in Archive)
      if (!(matchSearch && (e.status || 'active') === 'active')) return false;

      if (onboardingWindowOnly && !inOnboardingWindow(empToHire(e), today)) return false;

      const nameQ = (c.name || '').trim().toLowerCase();
      if (nameQ) {
        const hay = `${displayHireName(e)} ${e.full_name || ''} ${e.preferred_name || ''}`.toLowerCase();
        if (!hay.includes(nameQ)) return false;
      }
      if (c.position && normalizePosition(e.employee_type) !== c.position) return false;
      if (c.region) {
        const reg = normalizeRegion(e.region) || e.region || '';
        if (String(reg).toLowerCase() !== String(c.region).toLowerCase()) return false;
      }
      const cityQ = (c.city_center || '').trim().toLowerCase();
      if (cityQ && !(e.city_center || '').toLowerCase().includes(cityQ)) return false;
      const orientQ = (c.orientation || '').trim().toLowerCase();
      if (orientQ && !(e.start_date || '').toLowerCase().includes(orientQ)) return false;
      const startQ = (c.start || '').trim().toLowerCase();
      if (startQ && !(e.work_start_date || '').toLowerCase().includes(startQ)) return false;
      const bootQ = (c.bootcamp || '').trim().toLowerCase();
      if (bootQ && !(e.bootcamp_start_date || '').toLowerCase().includes(bootQ)) return false;
      if (c.status && (e.status || 'active') !== c.status) return false;
      return true;
    });
  }

  function filteredArchivedEmployees() {
    const q = filters.q.trim().toLowerCase();
    return employees.filter((e) => {
      if (!isArchivedStatus(e.status)) return false;
      const matchSearch =
        !q ||
        (e.full_name || '').toLowerCase().includes(q) ||
        (e.preferred_name || '').toLowerCase().includes(q) ||
        displayHireName(e).toLowerCase().includes(q) ||
        (e.company_email || '').toLowerCase().includes(q) ||
        String(e.employee_number ?? '').includes(q);
      const matchFilter = filters.archiveStatus === 'all' || e.status === filters.archiveStatus;
      return matchSearch && matchFilter;
    });
  }

  function stats() {
    const active = employees.filter((e) => e.status === 'active').length;
    return {
      total: employees.length,
      active,
      inactive: employees.length - active,
      technicians: employees.filter((e) => e.employee_type === 'technician' || e.employee_type === 'kes_installer').length,
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
    const omit = new Set(missingEmpCols);
    let rows = null;
    let error = null;
    for (let attempt = 0; attempt < OPTIONAL_EMP_COLS.length + 2; attempt++) {
      const selectCols = selectColsWithout(omit);
      ({ data: rows, error } = await supabase
        .from('employees')
        .select(selectCols)
        .order('employee_number', { ascending: false, nullsFirst: false }));
      if (!error) {
        if (omit.size && rows) {
          rows = rows.map((r) => {
            const filled = Object.assign({}, r);
            OPTIONAL_EMP_COLS.forEach((k) => {
              if (omit.has(k) && filled[k] === undefined) filled[k] = null;
            });
            return filled;
          });
        }
        break;
      }
      if (rememberMissingEmpCols(error)) {
        OPTIONAL_EMP_COLS.forEach((k) => { if (missingEmpCols.has(k)) omit.add(k); });
        continue;
      }
      break;
    }
    if (error) {
      loading = false;
      loadError = error.message;
      render();
      return;
    }
    employees = (rows || []).map((r) => Object.assign({}, r, {
      employee_type: normalizePosition(r.employee_type),
      region: normalizeRegion(r.region) || r.region || null
    }));
    collapseActiveEmployeeDuplicatesInMemory();
    loading = false;
    render();
  }

  function setPageTitle(text) {
    const el = document.querySelector('#page-checklist .page-title');
    if (el) el.textContent = text;
    const headerTitle = document.getElementById('hub-header-title');
    const checklistPage = document.getElementById('page-checklist');
    if (headerTitle && checklistPage && checklistPage.classList.contains('active')) {
      headerTitle.textContent = text;
    }
  }

  function setPageSub(text) {
    const el = document.querySelector('#page-checklist .page-sub');
    if (el) el.textContent = text;
    const headerSub = document.getElementById('hub-header-sub');
    const checklistPage = document.getElementById('page-checklist');
    if (headerSub && checklistPage && checklistPage.classList.contains('active')) {
      headerSub.textContent = text;
    }
  }

  function navViewKey() {
    if (view === 'detail') return detailReturnView || 'dashboard';
    if (['dashboard', 'todo', 'reports', 'roster', 'archive', 'template'].includes(view)) return view;
    return 'dashboard';
  }

  function syncChecklistNav() {
    const page = document.getElementById('page-checklist');
    if (!page || !page.classList.contains('active')) return;
    const key = navViewKey();
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((b) => b.classList.remove('active'));
    const match = document.querySelector(`.sidebar-nav .nav-item[data-nh-view="${key}"]`);
    if (match) match.classList.add('active');
  }

  function syncHeaderActions() {
    const wrap = document.getElementById('hub-header-actions');
    if (!wrap) return;
    const page = document.getElementById('page-checklist');
    const onChecklist = !!(page && page.classList.contains('active'));
    wrap.hidden = !(onChecklist && ['dashboard', 'roster', 'archive', 'reports'].includes(view));
  }

  function setView(next, opts) {
    if (next === 'people') next = 'dashboard';
    if (next === 'mywork' || next === 'my-work') next = 'todo';
    const allowed = ['dashboard', 'todo', 'reports', 'roster', 'archive', 'template'];
    view = allowed.includes(next) ? next : 'dashboard';
    selectedHireId = null;
    if (!(opts && opts.silent) && mounted) render();
    else {
      syncChecklistNav();
      syncHeaderActions();
    }
  }

  function getView() {
    return view;
  }

  function bindHeaderAdd() {
    const btn = document.getElementById('nh-header-add');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => openHireModal());
  }

  function statusSelect(empId, status, extraClass) {
    const cur = status || 'active';
    const opts = STATUS_OPTIONS.includes(cur) ? STATUS_OPTIONS : [cur, ...STATUS_OPTIONS];
    return `<select class="nh-status-select ${extraClass || ''}" data-status-emp="${esc(empId)}" title="Change status">
      ${opts.map((s) => `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${esc(formatStatusLabel(s))}</option>`).join('')}
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
        // Non-active statuses move to Archive; Active leaves Archive
        if (view === 'detail' && selectedHireId === id && isArchivedStatus(status)) {
          view = 'archive';
          selectedHireId = null;
        }
        if (view === 'roster' || view === 'dashboard' || view === 'archive' || view === 'detail') render();
      });
    });
  }

  function syncRegionProgress(empId, region) {
    ensureData();
    const regionItem = data.items.find((i) => i.label === 'Region');
    if (!regionItem) return;
    const p = progressOf(empId);
    if (region) p.values[regionItem.id] = region;
    else delete p.values[regionItem.id];
    persist();
  }

  async function deleteEmployee(id) {
    const emp = employees.find((e) => e.id === id);
    if (!emp) return false;
    const name = emp.full_name || 'this hire';
    if (!confirm(`Permanently delete "${name}"?\n\nThis removes them from the Hub and cannot be undone.`)) return false;
    if (!confirm(`Confirm delete for "${name}". Continue?`)) return false;
    const supabase = client();
    if (!supabase) {
      alert('Not signed in');
      return false;
    }
    try {
      await supabase.from('event_employees').delete().eq('employee_id', id);
      await supabase.from('employee_notes').delete().eq('employee_id', id);
      const { error } = await supabase.from('employees').delete().eq('id', id);
      if (error) throw error;
    } catch (e) {
      alert('Could not delete: ' + (e.message || e));
      return false;
    }
    employees = employees.filter((e) => e.id !== id);
    ensureData();
    if (data.progress && data.progress[id]) {
      delete data.progress[id];
      persist();
    }
    if (selectedHireId === id) selectedHireId = null;
    return true;
  }

  function sectionProgress(hire, sectionId, roleFilter, personFilter) {
    const items = itemsForHireFilter(hire, itemsForSection(sectionId), roleFilter, personFilter);
    const total = items.length;
    let done = 0;
    items.forEach((it) => { if (isFilled(it, hire.values?.[it.id], hire)) done++; });
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function filterScopeLabel() {
    if (filters.person && filters.person !== 'all') {
      return `${filters.person}${filters.role !== 'all' ? ` (${filters.role})` : ''}`;
    }
    if (filters.role && filters.role !== 'all') return `${filters.role} role`;
    return 'all roles';
  }

  function pctClass(pct) {
    if (pct >= 100) return 'nh-pct-done';
    if (pct >= 50) return 'nh-pct-mid';
    if (pct > 0) return 'nh-pct-low';
    return 'nh-pct-zero';
  }

  function rolePeopleChips() {
    const people = peopleForRole('all');
    if (!people.length) {
      return '<span class="nh-person-chips nh-muted">No assignees yet</span>';
    }
    const chips = [
      `<button type="button" class="nh-person-chip ${filters.person === 'all' ? 'active' : ''}" data-person="all">Everyone</button>`,
      ...people.map((p) =>
        `<button type="button" class="nh-person-chip ${filters.person === p ? 'active' : ''}" data-person="${esc(p)}">${esc(p)}</button>`
      ),
    ];
    return `<div class="nh-person-chips">${chips.join('')}</div>`;
  }

  function roleFilterControls(selectId) {
    if (filters.role === 'PM') {
      filters.role = 'all';
      try { localStorage.setItem(ROLE_PREF_KEY, 'all'); } catch (e) { /* ignore */ }
    }
    const roles = (data.roles || []).filter((r) => r.id !== 'PM');
    const me = viewerChecklistName();
    const myLabel = me !== 'all' ? me : (window.hubCurrentUser?.full_name || 'me');
    const mineActive = me !== 'all' && filters.person === me;
    return `
      <div class="nh-filter-panel">
        <div class="nh-filter-group">
          <span class="nh-filter-label">Quick</span>
          <button type="button" class="nh-my-tasks-btn ${mineActive ? 'active' : ''}" id="nh-my-tasks" title="Filter this list to tasks assigned to you">
            Assigned to me${me !== 'all' ? ` · ${esc(myLabel)}` : ''}
          </button>
        </div>
        <div class="nh-filter-divider" aria-hidden="true"></div>
        <div class="nh-filter-group">
          <span class="nh-filter-label">Role</span>
          <select id="${esc(selectId)}" class="form-input nh-role-select" title="Filter tasks by role">
            <option value="all" ${filters.role === 'all' ? 'selected' : ''}>All roles</option>
            ${roles.map((r) => `<option value="${esc(r.id)}" ${filters.role === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
          </select>
        </div>
        <div class="nh-filter-divider" aria-hidden="true"></div>
        <div class="nh-filter-group nh-filter-people">
          <span class="nh-filter-label">Person</span>
          ${rolePeopleChips()}
        </div>
        <div class="nh-filter-scope">Viewing <strong>${esc(filterScopeLabel())}</strong></div>
      </div>`;
  }

  function roleBar(opts) {
    const showRoleFilter = !!(opts && opts.showRoleFilter);
    if (!showRoleFilter) return '';
    return `
      <div class="nh-rolebar">
        ${roleFilterControls('nh-role')}
      </div>`;
  }

  function syncPersonAfterRoleChange(roleId) {
    const people = peopleForRole(roleId === 'all' ? 'all' : roleId);
    if (filters.person !== 'all' && people.includes(filters.person)) {
      localStorage.setItem(PERSON_PREF_KEY, filters.person);
      return;
    }
    const me = window.hubCurrentUser ? matchChecklistPerson(window.hubCurrentUser, roleId === 'all' ? 'all' : roleId) : 'all';
    // Keep a named owner's own chip when their role is selected; otherwise Everyone
    filters.person = (me !== 'all' && people.includes(me)) ? me : 'all';
    localStorage.setItem(PERSON_PREF_KEY, filters.person);
  }

  function bindPersonChips(root) {
    root.querySelector('#nh-my-tasks')?.addEventListener('click', () => applyMyTasksFilter());
    root.querySelectorAll('[data-person]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const person = btn.getAttribute('data-person') || 'all';
        filters.person = person;
        // Jump to that person's role so their tasks actually show
        if (person !== 'all') {
          const roleOf = primaryRoleForPerson(person);
          if (roleOf) filters.role = roleOf;
        }
        localStorage.setItem(PERSON_PREF_KEY, filters.person);
        localStorage.setItem(ROLE_PREF_KEY, filters.role);
        render();
      });
    });
  }

  function bindRoleBar(root) {
    root.querySelector('#nh-role')?.addEventListener('change', (e) => {
      filters.role = e.target.value;
      localStorage.setItem(ROLE_PREF_KEY, filters.role);
      syncPersonAfterRoleChange(filters.role);
      render();
    });
    bindPersonChips(root);
  }

  function renderTodo(root) {
    setPageTitle('My work');
    setPageSub('Your open tasks by hire — check off, enter dates, or Edit. Use Role / Person filters on People.');
    const entries = todoEntries();
    const groups = todoGroups(entries);
    const overdue = entries.filter((e) => e.bucket === 'overdue').length;
    const week = entries.filter((e) => e.bucket === 'week' || e.bucket === 'overdue').length;
    const open = entries.filter((e) => !e.done).length;
    const shownGroups = groups.slice(0, todoLimit);

    // Default: expand hires with overdue work (first time only)
    shownGroups.forEach((g) => {
      if (todoOpenHires[g.hire.id] === undefined) {
        todoOpenHires[g.hire.id] = g.overdue > 0;
      }
    });

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-stats nh-stats-todo">
        <div class="stat"><div class="stat-num red">${overdue}</div><div class="stat-label">Overdue</div></div>
        <div class="stat"><div class="stat-num amber">${week}</div><div class="stat-label">Due in 7 days</div></div>
        <div class="stat"><div class="stat-num">${open}</div><div class="stat-label">Open for ${esc(filterScopeLabel())}</div></div>
        <div class="stat"><div class="stat-num green">${entries.filter((e) => e.done).length}</div><div class="stat-label">Shown complete</div></div>
      </div>
      <div class="nh-toolbar nh-toolbar-plain">
        <div class="nh-toolbar-left">
          <button class="wt-filter-btn ${filters.todoScope === 'week' ? 'active' : ''}" data-scope="week">This week</button>
          <button class="wt-filter-btn ${filters.todoScope === 'overdue' ? 'active' : ''}" data-scope="overdue">Overdue</button>
          <button class="wt-filter-btn ${filters.todoScope === 'open' ? 'active' : ''}" data-scope="open">Open</button>
          <button class="wt-filter-btn ${filters.todoScope === 'all' ? 'active' : ''}" data-scope="all">All</button>
          <button class="wt-filter-btn ${filters.todoScope === 'done' ? 'active' : ''}" data-scope="done">Done</button>
          <button class="wt-filter-btn ${filters.hireWindow === 'onboarding' ? 'active' : ''}" data-hire-window="onboarding" title="Orientation date within last 120 days or next 60 days">Onboarding window</button>
          <button class="wt-filter-btn ${filters.hireWindow === 'all' ? 'active' : ''}" data-hire-window="all">All active hires</button>
          <button class="wt-filter-btn" type="button" id="nh-todo-expand-all">Expand all</button>
          <button class="wt-filter-btn" type="button" id="nh-todo-collapse-all">Collapse all</button>
        </div>
        <div class="nh-muted">${shownGroups.length} of ${groups.length} hires · ${entries.length} tasks</div>
      </div>
      <div class="nh-todo-list nh-todo-grouped">
        ${shownGroups.length
          ? shownGroups.map(todoHireGroup).join('')
          : '<div class="nh-empty-block">No tasks for this filter. Try Open, or set Role / Person on People.</div>'}
      </div>
      ${groups.length > todoLimit
        ? `<div style="margin-top:12px;text-align:center"><button class="btn-secondary" type="button" id="nh-todo-more">Show more hires (${groups.length - todoLimit} left)</button></div>`
        : ''}`;

    bindRoleBar(root);
    root.querySelectorAll('[data-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filters.todoScope = btn.getAttribute('data-scope');
        todoLimit = 40;
        render();
      });
    });
    root.querySelectorAll('[data-hire-window]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filters.hireWindow = btn.getAttribute('data-hire-window');
        todoLimit = 40;
        render();
      });
    });
    root.querySelector('#nh-todo-more')?.addEventListener('click', () => {
      todoLimit += 40;
      render();
    });
    root.querySelector('#nh-todo-expand-all')?.addEventListener('click', () => {
      shownGroups.forEach((g) => { todoOpenHires[g.hire.id] = true; });
      render();
    });
    root.querySelector('#nh-todo-collapse-all')?.addEventListener('click', () => {
      shownGroups.forEach((g) => { todoOpenHires[g.hire.id] = false; });
      render();
    });
    root.querySelectorAll('[data-todo-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-todo-toggle');
        todoOpenHires[id] = !todoOpenHires[id];
        render();
      });
    });
    root.querySelectorAll('[data-open-hire]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openHireDetail(btn.getAttribute('data-open-hire'));
      });
    });
    root.querySelectorAll('[data-todo-check]').forEach((el) => {
      el.addEventListener('change', () => {
        const hireId = el.getAttribute('data-hire');
        const itemId = el.getAttribute('data-item');
        const item = data.items.find((i) => i.id === itemId);
        if (!item) return;
        if (item.inputType === 'checkbox') {
          saveValue(hireId, itemId, el.checked);
        } else if (el.checked) {
          saveValue(hireId, itemId, quickCompleteValue(item));
        } else {
          saveValue(hireId, itemId, '');
        }
        render();
      });
    });
    root.querySelectorAll('[data-todo-field]').forEach((el) => {
      const save = () => {
        const hireId = el.getAttribute('data-hire');
        const itemId = el.getAttribute('data-todo-field');
        const item = data.items.find((i) => i.id === itemId);
        let val = el.type === 'checkbox' ? el.checked : el.value;
        if (item?.sensitive && !revealSensitive && String(val).includes('••')) return;
        saveValue(hireId, itemId, val);
        render();
      };
      el.addEventListener('change', save);
      if (el.type !== 'checkbox' && el.tagName !== 'SELECT') el.addEventListener('blur', save);
    });
    root.querySelectorAll('[data-todo-edit]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openItemModal(btn.getAttribute('data-todo-edit'));
      });
    });
    root.querySelectorAll('[data-open-checklist]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openTaskChecklistModal(btn.getAttribute('data-hire'), btn.getAttribute('data-open-checklist'));
      });
    });
  }

  function quickCompleteValue(item) {
    if (!item) return 'Done';
    if (item.inputType === 'date') return todayIso();
    if (item.inputType === 'select') {
      const opts = (item.options || []).map((o) => (typeof o === 'string' ? o : o.value)).filter(Boolean);
      const yes = opts.find((o) => /^yes$/i.test(o));
      return yes || opts.find((o) => !/^(n\/a|na|—|-)$/i.test(o)) || opts[0] || 'Done';
    }
    if (/^DATE\b/i.test(item.label || '')) return todayIso();
    return 'Done';
  }

  function todoHireGroup(g) {
    const expanded = !!todoOpenHires[g.hire.id];
    const overdueCls = g.overdue ? 'has-overdue' : '';
    return `
      <div class="nh-todo-hire-group ${overdueCls} ${expanded ? 'open' : ''}">
        <div class="nh-todo-hire-head">
          <button type="button" class="nh-todo-hire-toggle" data-todo-toggle="${esc(g.hire.id)}">
            <span class="nh-chevron">${expanded ? '▾' : '▸'}</span>
            <span class="nh-todo-hire-name">${esc(g.hire.name)}</span>
            <span class="nh-muted-inline">${esc(g.hire.division || '')}</span>
            <span class="nh-todo-hire-counts">
              ${g.overdue ? `<span class="nh-todo-pill overdue">${g.overdue} overdue</span>` : ''}
              <span class="nh-todo-pill">${g.open} open</span>
              <span class="nh-todo-pill muted">${g.done} done</span>
            </span>
          </button>
          <button class="btn-xs primary" type="button" data-open-hire="${esc(g.hire.id)}">Open hire</button>
        </div>
        <div class="nh-todo-checklist" ${expanded ? '' : 'hidden'}>
          ${g.tasks.map(todoCheckRow).join('')}
        </div>
      </div>`;
  }

  function todoCheckRow(e) {
    const dueCls = e.bucket === 'overdue' ? 'due-over' : e.bucket === 'week' ? 'due-soon' : '';
    const linkHtml = taskLinkHtml(e.item);
    const stepProg = checklistProgress(e.hire, e.item);
    const raw = e.hire.values?.[e.item.id];
    const canEdit = ownsHireTask(e.hire, e.item);
    const isRegionField = /^Region$/i.test(e.item.label);
    let control = '';
    let valueCtrl = '';

    if (stepProg) {
      control = `<button type="button" class="btn-xs" data-open-checklist="${esc(e.item.id)}" data-hire="${esc(e.hire.id)}">Steps ${stepProg.done}/${stepProg.total}</button>`;
    } else {
      control = `<input type="checkbox" class="nh-todo-cb" data-todo-check data-hire="${esc(e.hire.id)}" data-item="${esc(e.item.id)}" ${e.done ? 'checked' : ''} title="${e.done ? 'Mark open' : 'Mark done'}">`;
      if (e.item.inputType === 'date') {
        const v = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
        valueCtrl = `<input class="form-input nh-todo-field" type="date" data-todo-field="${esc(e.item.id)}" data-hire="${esc(e.hire.id)}" value="${esc(v)}" title="Enter completion date">`;
      } else if (isRegionField || e.item.inputType === 'select') {
        const optsList = isRegionField ? REGION_OPTIONS : (e.item.options || []);
        const cur = isRegionField ? (normalizeRegion(raw) || raw || '') : String(raw || '');
        const opts = optsList.map((o) => {
          const v = typeof o === 'string' ? o : o.value;
          return `<option value="${esc(v)}" ${String(cur) === v ? 'selected' : ''}>${esc(v)}</option>`;
        }).join('');
        valueCtrl = `<select class="form-input nh-todo-field" data-todo-field="${esc(e.item.id)}" data-hire="${esc(e.hire.id)}" title="Select value"><option value="">—</option>${opts}</select>`;
      } else if (e.item.inputType === 'text' || e.item.inputType === 'number') {
        let display = raw == null ? '' : String(raw);
        if (e.item.sensitive && !revealSensitive && display) display = '••••••••';
        valueCtrl = `<input class="form-input nh-todo-field" type="text" data-todo-field="${esc(e.item.id)}" data-hire="${esc(e.hire.id)}" value="${esc(display)}" ${e.item.sensitive && !revealSensitive && raw ? 'readonly' : ''} placeholder="Enter…" title="Enter value">`;
      }
    }

    const editBtn = canEdit
      ? `<button type="button" class="btn-xs" data-todo-edit="${esc(e.item.id)}" title="Edit this process task">Edit</button>`
      : '';

    return `
      <div class="nh-todo-check-row ${e.done ? 'done' : ''} ${dueCls}">
        <span class="nh-todo-check-ctrl">${control}</span>
        <span class="nh-todo-check-body">
          <span class="nh-todo-check-label" title="${esc(e.item.label)}">${esc(e.item.label)}${linkHtml ? ' · ' + linkHtml : ''}</span>
          ${valueCtrl ? `<span class="nh-todo-check-value">${valueCtrl}</span>` : ''}
          <span class="nh-todo-check-meta">
            <span class="nh-owner-chip">${esc(e.who || 'Unassigned')}</span>
            <span class="nh-due ${dueCls}">${e.due ? esc(fmtDate(e.due)) : 'No due date'}</span>
            ${editBtn}
          </span>
        </span>
      </div>`;
  }

  function colFilterInput(key, placeholder) {
    const val = (filters.cols && filters.cols[key]) || '';
    return `<input type="search" class="nh-col-filter" data-col-filter="${esc(key)}" placeholder="${esc(placeholder)}" value="${esc(val)}" />`;
  }

  function colFilterSelect(key, options, allLabel) {
    const val = (filters.cols && filters.cols[key]) || '';
    return `<select class="nh-col-filter" data-col-filter="${esc(key)}">
      <option value="">${esc(allLabel || 'All')}</option>
      ${options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('')}
    </select>`;
  }

  function dashboardColFilterRow(sections) {
    const c = filters.cols || {};
    return `<tr class="nh-sheet-filters">
      <th class="nh-sticky" data-col="_num"></th>
      <th class="nh-sticky nh-sticky-2" data-col="name">${colFilterInput('name', 'Filter name…')}</th>
      <th data-col="position">${colFilterSelect('position', POSITION_OPTIONS, 'All positions')}</th>
      <th data-col="region">${colFilterSelect('region', REGION_OPTIONS, 'All regions')}</th>
      <th data-col="city_center">${colFilterInput('city_center', 'City…')}</th>
      <th data-col="orientation">${colFilterInput('orientation', 'YYYY-MM-DD')}</th>
      <th data-col="start">${colFilterInput('start', 'YYYY-MM-DD')}</th>
      <th data-col="bootcamp">${colFilterInput('bootcamp', 'YYYY-MM-DD')}</th>
      <th data-col="status">${colFilterSelect('status', STATUS_OPTIONS.map((s) => ({ value: s, label: formatStatusLabel(s) })), 'All statuses')}</th>
      <th data-col="overall"></th>
      ${sections.map((sec) => `<th data-col="sec-${esc(sec.id)}"></th>`).join('')}
      <th data-col="resume"></th>
      <th data-col="_actions">${Object.values(c).some(Boolean) ? '<button type="button" class="btn-xs" id="nh-clear-col-filters" title="Clear column filters">Clear</button>' : ''}</th>
    </tr>`;
  }

  function bindColFilters(root) {
    const restoreFocus = (key, isSelect) => {
      const el = root.querySelector(`[data-col-filter="${key}"]`) || document.querySelector(`[data-col-filter="${key}"]`);
      if (!el) return;
      el.focus();
      if (!isSelect && typeof el.setSelectionRange === 'function') {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    };
    root.querySelectorAll('[data-col-filter]').forEach((el) => {
      const key = el.getAttribute('data-col-filter');
      const handler = () => {
        if (!filters.cols) filters.cols = {};
        filters.cols[key] = el.value || '';
        render();
        restoreFocus(key, el.tagName === 'SELECT');
      };
      if (el.tagName === 'SELECT') el.addEventListener('change', handler);
      else el.addEventListener('input', handler);
    });
    root.querySelector('#nh-clear-col-filters')?.addEventListener('click', () => {
      filters.cols = {
        name: '', position: '', region: '', city_center: '',
        orientation: '', start: '', bootcamp: '', status: ''
      };
      render();
    });
  }

  function bindRosterChrome(root) {
    bindRoleBar(root);
    bindStatusSelects(root);
    bindColFilters(root);
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
    root.querySelectorAll('[data-archive-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filters.archiveStatus = btn.getAttribute('data-archive-filter');
        render();
      });
    });
    root.querySelectorAll('[data-open-hire]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openHireDetail(btn.getAttribute('data-open-hire'));
      });
    });
    root.querySelectorAll('[data-del-emp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del-emp');
        btn.disabled = true;
        const ok = await deleteEmployee(id);
        if (ok) render();
        else btn.disabled = false;
      });
    });
    if (window.HubShell && HubShell.enhanceTables) HubShell.enhanceTables(root);
    bindColumnVisibility(root);
  }

  function renderDashboard(root) {
    setPageTitle('People');
    setPageSub('Recent / onboarding-window hires (orientation within last ~120 days or next ~60). Use Roster for the full active list. Progress counts follow Role / Person.');
    ensureData();
    const s = stats();
    const rows = filteredEmployees({ onboardingWindowOnly: true });
    const sections = data.sections || [];

    root.innerHTML = `
      ${roleBar({ showRoleFilter: true })}
      <div class="nh-stats">
        <div class="nh-stat"><div class="nh-stat-label">In window</div><div class="nh-stat-num">${rows.length}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Active (all)</div><div class="nh-stat-num nh-stat-green">${s.active}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Archived</div><div class="nh-stat-num nh-stat-red">${s.inactive}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Filter</div><div class="nh-stat-num" style="font-size:14px">${esc(filterScopeLabel())}</div></div>
      </div>
      <div class="nh-toolbar">
        <input type="search" class="nh-search" id="nh-search" placeholder="Search by name, email, or #..." value="${esc(filters.q)}" />
        <div class="nh-filters">
          <button type="button" class="btn-secondary" id="nh-column-visibility-btn" aria-expanded="false" aria-haspopup="menu" aria-controls="nh-column-visibility-menu">Show/Hide columns</button>
          <span class="nh-muted">Onboarding window only · full list is under Roster · archived under Archive</span>
        </div>
      </div>
      <div class="nh-sheet-wrap">
        <table class="nh-sheet" data-sort-key="nh-dashboard">
          <thead>
            <tr>
              <th class="nh-sticky" data-col="_num">#</th>
              <th class="nh-sticky nh-sticky-2" data-col="name">Name</th>
              <th data-col="position">Position</th>
              <th data-col="region">Region</th>
              <th data-col="city_center">City center</th>
              <th data-col="orientation">Orientation</th>
              <th data-col="start">Start</th>
              <th data-col="bootcamp">Bootcamp</th>
              <th data-col="status">Status</th>
              <th data-col="overall">Overall</th>
              ${sections.map((sec) => `<th title="${esc(sec.title)}" class="nh-sec-col" data-col="sec-${esc(sec.id)}">${esc(sec.id)}</th>`).join('')}
              <th data-col="resume">Resume</th>
              <th data-col="_actions"></th>
            </tr>
            ${dashboardColFilterRow(sections)}
            <tr class="nh-sheet-subhead">
              <th class="nh-sticky" data-col="_num"></th>
              <th class="nh-sticky nh-sticky-2" data-col="name"></th>
              <th data-col="position" class="nh-muted">Profile</th>
              <th data-col="region"></th>
              <th data-col="city_center"></th>
              <th data-col="orientation"></th>
              <th data-col="start"></th>
              <th data-col="bootcamp"></th>
              <th data-col="status"></th>
              <th data-col="overall"></th>
              ${sections.map((sec) => `<th class="nh-sec-sub" data-col="sec-${esc(sec.id)}">${esc(sec.title)}</th>`).join('')}
              <th data-col="resume"></th>
              <th data-col="_actions"></th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((emp) => {
              const hire = empToHire(emp);
              const overall = hireProgress(hire);
              const resumeHtml = resumeCellHtml(hire);
              return `<tr>
                <td class="nh-sticky nh-muted" data-col="_num">${esc(emp.employee_number ?? '—')}</td>
                <td class="nh-sticky nh-sticky-2 nh-name" data-col="name">
                  <button type="button" class="nh-linkish" data-open-hire="${esc(emp.id)}">${esc(displayHireName(emp))}</button>
                </td>
                <td data-col="position">${positionText(emp.employee_type)}</td>
                <td data-col="region">${regionText(emp.region)}</td>
                <td data-col="city_center">${cityCenterText(emp.city_center)}</td>
                <td data-col="orientation">${esc(emp.start_date || '—')}</td>
                <td data-col="start">${esc(emp.work_start_date || '—')}</td>
                <td data-col="bootcamp">${esc(emp.bootcamp_start_date || '—')}</td>
                <td data-col="status">${statusSelect(emp.id, emp.status)}</td>
                <td data-col="overall"><span class="nh-pct ${pctClass(overall.pct)}" title="${overall.done}/${overall.total} for ${esc(filterScopeLabel())}">${overall.done}/${overall.total}</span></td>
                ${sections.map((sec) => {
                  const sp = sectionProgress(hire, sec.id);
                  return `<td class="nh-sec-cell" data-col="sec-${esc(sec.id)}">
                    <button type="button" class="nh-pct ${pctClass(sp.pct)}" data-open-hire="${esc(emp.id)}" title="${esc(sec.title)} · ${esc(filterScopeLabel())}: ${sp.done}/${sp.total}">${sp.done}/${sp.total}</button>
                  </td>`;
                }).join('')}
                <td class="nh-resume-cell" data-col="resume">${resumeHtml}</td>
                <td data-col="_actions"><button class="btn-xs primary" type="button" data-open-hire="${esc(emp.id)}">Open</button></td>
              </tr>`;
            }).join('') : `<tr><td colspan="${visibleColumnCount()}" class="nh-empty">No employees found</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="nh-footnote">${rows.length} hires in onboarding window · A–J counts are for ${esc(filterScopeLabel())} · choose All roles to see full totals · Roster shows every active hire</p>`;

    bindRosterChrome(root);
  }

  function renderRoster(root) {
    setPageTitle('Roster');
    setPageSub('Full active roster — every Active hire, not only the onboarding window. Change Status to move someone to Archive (Quit, Terminated, Resigned, etc.).');
    const s = stats();
    const rows = filteredEmployees();

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-stats">
        <div class="nh-stat"><div class="nh-stat-label">Total Employees</div><div class="nh-stat-num">${s.total}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Active</div><div class="nh-stat-num nh-stat-green">${s.active}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Archived</div><div class="nh-stat-num nh-stat-red">${s.inactive}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Technicians</div><div class="nh-stat-num nh-stat-amber">${s.technicians}</div></div>
      </div>
      <div class="nh-toolbar">
        <input type="search" class="nh-search" id="nh-search" placeholder="Search by name, email, or #..." value="${esc(filters.q)}" />
        <div class="nh-filters">
          <span class="nh-muted">All active hires · People is onboarding-window only · archived under Archive</span>
        </div>
      </div>
      <div class="nh-table-wrap">
        <table class="nh-table" data-sort-key="nh-roster">
          <thead>
            <tr><th>#</th><th>Name</th><th>Position</th><th>Region</th><th>City center</th><th>Orientation</th><th>Start</th><th>Bootcamp</th><th>Status</th><th>Progress</th></tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((emp) => {
              const hire = empToHire(emp);
              const pr = hireProgress(hire);
              return `<tr>
                <td class="nh-muted">${esc(emp.employee_number ?? '—')}</td>
                <td class="nh-name"><button type="button" class="nh-linkish" data-open-hire="${esc(emp.id)}">${esc(displayHireName(emp))}</button></td>
                <td>${positionText(emp.employee_type)}</td>
                <td>${regionText(emp.region)}</td>
                <td>${cityCenterText(emp.city_center)}</td>
                <td>${esc(emp.start_date || '—')}</td>
                <td>${esc(emp.work_start_date || '—')}</td>
                <td>${esc(emp.bootcamp_start_date || '—')}</td>
                <td>${statusSelect(emp.id, emp.status)}</td>
                <td><button class="btn-xs primary" type="button" data-open-hire="${esc(emp.id)}">${pr.done}/${pr.total}</button></td>
              </tr>`;
            }).join('') : `<tr><td colspan="10" class="nh-empty">No employees found</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="nh-footnote">${rows.length} active employees (full roster) · use Status to archive · click name/progress to open checklist</p>`;

    bindRosterChrome(root);
  }

  function renderArchive(root) {
    setPageTitle('Archive');
    setPageSub('Quit, Terminated, Resigned, Rescinded, and Archive statuses. Active hires stay on People / Roster. Set Status back to Active to restore, or Delete permanently.');
    ensureData();
    const s = stats();
    const rows = filteredArchivedEmployees();
    const archiveFilters = ['all', ...ARCHIVE_STATUSES];

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-stats">
        <div class="nh-stat"><div class="nh-stat-label">Archived</div><div class="nh-stat-num nh-stat-red">${s.inactive}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Terminated</div><div class="nh-stat-num">${employees.filter((e) => e.status === 'terminated').length}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Quit / Resigned</div><div class="nh-stat-num">${employees.filter((e) => e.status === 'quit' || e.status === 'resigned').length}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Rescinded</div><div class="nh-stat-num">${employees.filter((e) => e.status === 'rescinded').length}</div></div>
      </div>
      <div class="nh-toolbar">
        <input type="search" class="nh-search" id="nh-search" placeholder="Search archived by name, email, or #..." value="${esc(filters.q)}" />
        <div class="nh-filters">
          ${archiveFilters.map((f) =>
            `<button type="button" class="nh-filter-btn${filters.archiveStatus === f ? ' active' : ''}" data-archive-filter="${f}">${f === 'all' ? 'all archived' : formatStatusLabel(f)}</button>`
          ).join('')}
        </div>
      </div>
      <div class="nh-table-wrap">
        <table class="nh-table" data-sort-key="nh-archive">
          <thead>
            <tr><th>#</th><th>Name</th><th>Position</th><th>Region</th><th>City center</th><th>Orientation</th><th>Start</th><th>Bootcamp</th><th>Status</th><th>Progress</th><th></th></tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((emp) => {
              const hire = empToHire(emp);
              const pr = hireProgress(hire);
              return `<tr>
                <td class="nh-muted">${esc(emp.employee_number ?? '—')}</td>
                <td class="nh-name"><button type="button" class="nh-linkish" data-open-hire="${esc(emp.id)}">${esc(displayHireName(emp))}</button></td>
                <td>${positionText(emp.employee_type)}</td>
                <td>${regionText(emp.region)}</td>
                <td>${cityCenterText(emp.city_center)}</td>
                <td>${esc(emp.start_date || '—')}</td>
                <td>${esc(emp.work_start_date || '—')}</td>
                <td>${esc(emp.bootcamp_start_date || '—')}</td>
                <td>${statusSelect(emp.id, emp.status)}</td>
                <td><button class="btn-xs primary" type="button" data-open-hire="${esc(emp.id)}">${pr.done}/${pr.total}</button></td>
                <td><button class="btn-xs danger" type="button" data-del-emp="${esc(emp.id)}" title="Permanently delete">Delete</button></td>
              </tr>`;
            }).join('') : `<tr><td colspan="11" class="nh-empty">No archived hires</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="nh-footnote">${rows.length} archived · set Status to Active to restore · Delete removes them permanently</p>`;

    bindRosterChrome(root);
  }

  function sectionBarClass(done, total) {
    if (total > 0 && done >= total) return 'nh-bar-green';
    if (done > 0) return 'nh-bar-blue';
    return 'nh-bar-white';
  }

  function sectionBarDateControl(sec, hire) {
    const title = String(sec.title || '');
    const isBoot = sec.id === 'I' || (/bootcamp/i.test(title) && !/orientation/i.test(title));
    const isOrient = sec.id === 'H' || /orientation/i.test(title);
    if (isBoot) {
      return `<label class="nh-sec-date">
        <span>Bootcamp date</span>
        <input type="date" class="form-input nh-sec-date-input" data-hire-date="bootcamp_start_date" data-hire-id="${esc(hire.id)}" value="${esc((hire.bootcampDate || '').slice(0, 10))}">
      </label>`;
    }
    if (isOrient) {
      return `<label class="nh-sec-date">
        <span>Orientation date</span>
        <input type="date" class="form-input nh-sec-date-input" data-hire-date="start_date" data-hire-id="${esc(hire.id)}" value="${esc((hire.startDate || '').slice(0, 10))}">
      </label>`;
    }
    return '';
  }

  async function saveHireKeyDate(hireId, field, value) {
    const emp = employees.find((e) => e.id === hireId);
    if (!emp) return;
    const prev = emp[field];
    const next = value || null;
    emp[field] = next;
    try {
      await syncEmployeePatch(hireId, { [field]: next });
    } catch (e) {
      emp[field] = prev;
      alert('Could not save date: ' + (e.message || e));
      return false;
    }
    ensureData();
    const p = progressOf(hireId);
    if (field === 'start_date') {
      const startItem = data.items.find((i) => /START DATE/i.test(i.label));
      if (startItem) {
        if (next) p.values[startItem.id] = next;
        else delete p.values[startItem.id];
      }
    }
    if (field === 'bootcamp_start_date') {
      const bootItem = data.items.find((i) => /First Day of BOOTCAMP/i.test(i.label));
      if (bootItem) {
        if (next) p.values[bootItem.id] = next;
        else delete p.values[bootItem.id];
      }
    }
    persist();
    return true;
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
    const archived = isArchivedStatus(hire.status);
    const p = hireProgress(hire);
    const scoped = filterScopeLabel();
    setPageTitle(displayHireName(hire));
    setPageSub(archived
      ? 'Archived hire — set Status back to Active on Archive to restore, or Delete from Archive.'
      : `Showing tasks for ${scoped} (${p.done}/${p.total}). Use Role and your name below to see only your tasks.`);

    const sectionsHtml = data.sections.map((sec) => {
      const items = itemsForHireFilter(hire, itemsForSection(sec.id));
      const dateCtrl = sectionBarDateControl(sec, hire);
      // Keep Orientation / Bootcamp bars visible so dates can be set even when role filter hides tasks
      if (!items.length && !dateCtrl && (filters.role !== 'all' || filters.person !== 'all')) return '';
      const expanded = openSections[sec.id] === true;
      const spDone = items.filter((it) => isFilled(it, hire.values?.[it.id], hire)).length;
      const spOpen = items.length - spDone;
      const barCls = sectionBarClass(spDone, items.length || (dateCtrl ? 1 : 0));
      return `
        <div class="nh-section ${expanded ? 'open' : ''} ${barCls}">
          <div class="nh-section-head ${barCls}">
            <button type="button" class="nh-section-toggle" data-toggle-sec="${esc(sec.id)}">
              <span class="nh-chevron">${expanded ? '▾' : '▸'}</span>
              <div class="nh-section-title">${esc(sec.id)}. ${esc(sec.title)}</div>
            </button>
            <div class="nh-section-right">
              ${dateCtrl}
              <span class="nh-section-counts"><strong>${spDone}</strong> done / <strong>${spOpen}</strong> open</span>
            </div>
          </div>
          <div class="nh-section-body" ${expanded ? '' : 'hidden'}>
            <div class="nh-task-table">
              <div class="nh-task-head">
                <span>Assigned</span>
                <span>Task</span>
                <span>Due</span>
                <span>Value</span>
                <span>Status</span>
              </div>
              ${items.map((it) => fieldRow(hire, it)).join('') || '<div class="nh-empty-block">No tasks in this section for this filter.</div>'}
            </div>
          </div>
        </div>`;
    }).join('');

    root.innerHTML = `
      <div class="nh-detail-top">
        <button class="btn-secondary" type="button" id="nh-back">← Back</button>
        <div class="nh-detail-actions">
          <button class="btn-primary" type="button" id="nh-add-my-task" title="Add a process task assigned to you">+ Add my task</button>
          <label class="nh-check-label"><input type="checkbox" id="nh-reveal" ${revealSensitive ? 'checked' : ''}> Show sensitive</label>
          <button class="btn-secondary" type="button" id="nh-edit-hire">Edit profile</button>
          ${archived ? `<button class="btn-xs danger" type="button" id="nh-del-hire">Delete</button>` : ''}
        </div>
      </div>
      <div class="nh-detail-filters">
        ${roleFilterControls('nh-role-d')}
      </div>
      <div class="nh-profile">
        <div>
          <div class="nh-profile-name">${esc(hire.name)}</div>
          <div class="nh-profile-meta nh-profile-selects">
            <span class="nh-check-label">Position ${positionText(hire.employeeType)}</span>
            <span class="nh-check-label">Region ${regionText(hire.division)}</span>
            <span class="nh-check-label">City center ${cityCenterText(hire.cityCenter)}</span>
            <label class="nh-check-label">Status ${statusSelect(hire.id, hire.status)}</label>
          </div>
          <div class="nh-profile-meta nh-date-meta">
            <span><strong>Orientation date</strong> ${esc(hire.startDate || 'TBD')}</span>
            <span><strong>Start date</strong> ${esc(hire.workStartDate || 'TBD')}</span>
            <span><strong>Bootcamp date</strong> ${esc(hire.bootcampDate || 'TBD')}</span>
          </div>
        </div>
        <div class="nh-profile-right">
          <span class="${statusBadgeClass(hire.status)}">${esc(formatStatusLabel(hire.status))}</span>
          <div class="nh-prog big">
            <div class="nh-prog-bar"><span style="width:${p.pct}%"></span></div>
            <div class="nh-prog-label">${p.done}/${p.total} for ${esc(scoped)} · ${p.pct}%</div>
          </div>
        </div>
      </div>
      ${sectionsHtml || `<div class="nh-empty-block">No tasks assigned to ${esc(scoped)} for this hire.</div>`}`;

    root.querySelector('#nh-back').addEventListener('click', () => {
      if (history.state && history.state.hubNh && history.state.view === 'detail') {
        history.back();
        return;
      }
      leaveHireDetail();
    });
    root.querySelector('#nh-edit-hire').addEventListener('click', () => openHireModal(hire.id));
    root.querySelector('#nh-add-my-task')?.addEventListener('click', () => openItemModal(null, null, { forSelf: true }));
    root.querySelector('#nh-del-hire')?.addEventListener('click', async () => {
      if (await deleteEmployee(hire.id)) {
        view = 'archive';
        render();
      }
    });
    bindStatusSelects(root);
    root.querySelector('#nh-role-d').addEventListener('change', (e) => {
      filters.role = e.target.value;
      localStorage.setItem(ROLE_PREF_KEY, filters.role);
      syncPersonAfterRoleChange(filters.role);
      render();
    });
    bindPersonChips(root);
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
    root.querySelectorAll('[data-hire-date]').forEach((inp) => {
      inp.addEventListener('click', (e) => e.stopPropagation());
      inp.addEventListener('change', async () => {
        inp.classList.add('nh-saving');
        const ok = await saveHireKeyDate(
          inp.getAttribute('data-hire-id'),
          inp.getAttribute('data-hire-date'),
          inp.value
        );
        inp.classList.remove('nh-saving');
        if (ok) render();
        else {
          const emp = employees.find((e) => e.id === inp.getAttribute('data-hire-id'));
          const field = inp.getAttribute('data-hire-date');
          inp.value = emp && emp[field] ? String(emp[field]).slice(0, 10) : '';
        }
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
        const item = data.items.find((i) => i.id === itemId);
        if (!item || !ownsHireTask(hire, item)) {
          alert('You can only reassign tasks that are assigned to you.');
          render();
          return;
        }
        progressOf(hire.id).assignees[itemId] = sel.value;
        persist();
        render();
      });
    });
    root.querySelectorAll('[data-edit-hire-item]').forEach((btn) => {
      btn.addEventListener('click', () => openItemModal(btn.getAttribute('data-edit-hire-item')));
    });
    root.querySelectorAll('[data-del-hire-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (deleteProcessItem(btn.getAttribute('data-del-hire-item'))) render();
      });
    });
    root.querySelectorAll('[data-open-checklist]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openTaskChecklistModal(hire.id, btn.getAttribute('data-open-checklist'));
      });
    });
  }

  function fieldRow(hire, it) {
    const mine = filters.role !== 'all' && it.role === filters.role;
    const raw = hire.values?.[it.id];
    const filled = isFilled(it, raw, hire);
    const due = dueDateFor(hire, it);
    const overdue = isPastDue(due, filled);
    const who = assigneeOf(hire, it);
    const canEditMine = ownsHireTask(hire, it);
    const people = [...new Set([...peopleForRole(it.role), who, viewerChecklistName() !== 'all' ? viewerChecklistName() : null].filter(Boolean))];
    const stepProg = checklistProgress(hire, it);
    const linkHtml = taskLinkHtml(it);
    const isRegionField = /^Region$/i.test(it.label);
    let control = '';
    if (stepProg) {
      control = `<button type="button" class="btn-secondary nh-checklist-btn" data-open-checklist="${esc(it.id)}">
        Open check-off list (${stepProg.done}/${stepProg.total})
      </button>`;
    } else if (it.inputType === 'checkbox') {
      control = `<label class="nh-check-label"><input type="checkbox" data-field="${esc(it.id)}" ${filled ? 'checked' : ''}> Done</label>`;
    } else if (isRegionField || it.inputType === 'select') {
      const optsList = isRegionField ? REGION_OPTIONS : (it.options || []);
      const cur = isRegionField ? (normalizeRegion(raw) || raw || '') : String(raw || '');
      const opts = optsList.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        return `<option value="${esc(v)}" ${String(cur) === v ? 'selected' : ''}>${esc(v)}</option>`;
      }).join('');
      control = `<select class="form-input nh-field-input" data-field="${esc(it.id)}"><option value="">—</option>${opts}</select>`;
    } else if (it.inputType === 'date') {
      const v = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
      control = `<input class="form-input nh-field-input" type="date" data-field="${esc(it.id)}" value="${esc(v)}">`;
    } else if (/resume/i.test(it.label || '')) {
      let display = raw == null ? '' : String(raw);
      const openBtn = isHttpUrl(display)
        ? `<a class="btn-xs primary nh-resume-open" href="${esc(display.trim())}" target="_blank" rel="noopener">Open resume</a>`
        : '';
      control = `<div class="nh-resume-field">
        <input class="form-input nh-field-input" type="url" data-field="${esc(it.id)}" value="${esc(display)}" placeholder="Paste SharePoint / Drive link (https://…)">
        ${openBtn}
        <span class="nh-muted nh-resume-hint">Jessa: paste a link to the PDF or file</span>
      </div>`;
    } else {
      let display = raw == null ? '' : String(raw);
      if (it.sensitive && !revealSensitive && display) display = '••••••••';
      control = `<input class="form-input nh-field-input" type="text" data-field="${esc(it.id)}" value="${esc(display)}" ${it.sensitive && !revealSensitive && raw ? 'readonly' : ''} placeholder="Enter value…">`;
    }
    const ownerActions = canEditMine
      ? `<div class="nh-task-owner-actions">
          <button type="button" class="btn-xs" data-edit-hire-item="${esc(it.id)}" title="Edit this process task">Edit</button>
          <button type="button" class="btn-xs danger" data-del-hire-item="${esc(it.id)}" title="Delete this process task">Delete</button>
        </div>`
      : '';
    return `
      <div class="nh-task-row ${mine ? 'mine' : ''} ${filled ? 'filled' : 'open'} ${overdue ? 'overdue' : ''}${stepProg ? ' has-checklist' : ''}${canEditMine ? ' nh-mine-owned' : ''}">
        <div class="nh-task-assignee" title="${esc(who || 'Unassigned')} · ${esc(it.role)}">
          <select class="form-input nh-assignee" data-assignee="${esc(it.id)}" title="${canEditMine ? 'Reassign this task' : 'Only the assignee can reassign'}" ${canEditMine ? '' : 'disabled'}>
            ${people.map((p) => `<option value="${esc(p)}" ${who === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
          </select>
          <span class="nh-role-chip ${roleChipClass(it.role)}">${esc(it.role)}</span>
        </div>
        <div class="nh-task-label">
          ${stepProg
            ? `<button type="button" class="nh-linkish" data-open-checklist="${esc(it.id)}">${esc(it.label)}</button>`
            : esc(it.label)}
          ${it.sensitive ? ' <span class="nh-lock">sensitive</span>' : ''}
          ${stepProg ? ` <span class="nh-steps-chip">${stepProg.total} steps</span>` : ''}
          ${linkHtml ? ` <span class="nh-task-link-wrap">${linkHtml}</span>` : ''}
          ${ownerActions}
        </div>
        <div class="nh-task-due ${overdue ? 'is-overdue' : ''}">${esc(fmtDate(due))}</div>
        <div class="nh-task-value">${control}</div>
        <div class="nh-field-status">${filled ? 'Done' : (overdue ? 'Past due' : 'Open')}</div>
      </div>`;
  }

  function syncChecklistCompletion(hireId, itemId) {
    const item = data.items.find((i) => i.id === itemId);
    if (!item) return;
    const steps = normalizeSteps(item);
    if (!steps.length) return;
    const p = progressOf(hireId);
    const allDone = steps.every((s) => !!(p.checklists[itemId] && p.checklists[itemId][s.id]));
    if (allDone) {
      if (item.inputType === 'checkbox') p.values[itemId] = true;
      else if (!p.values[itemId]) p.values[itemId] = 'Complete';
    }
  }

  function openTaskChecklistModal(hireId, itemId) {
    ensureData();
    const hire = hires().find((h) => h.id === hireId);
    const item = data.items.find((i) => i.id === itemId);
    if (!hire || !item) return;
    const steps = normalizeSteps(item);
    if (!steps.length) return;
    const p = progressOf(hireId);
    if (!p.checklists[itemId]) p.checklists[itemId] = {};
    const map = p.checklists[itemId];
    const done = steps.filter((s) => !!map[s.id]).length;

    let modal = document.getElementById('nh-task-checklist-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'nh-task-checklist-modal';
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal" style="width:520px">
          <div class="modal-head">
            <span class="modal-title" id="nh-cl-title">Check-off list</span>
            <button class="modal-close" type="button" id="nh-cl-x">×</button>
          </div>
          <div class="modal-body">
            <p class="nh-cl-sub" id="nh-cl-sub"></p>
            <div id="nh-cl-steps" class="nh-cl-steps"></div>
          </div>
          <div class="modal-footer">
            <span class="nh-muted" id="nh-cl-count" style="margin-right:auto"></span>
            <button class="btn-primary" type="button" id="nh-cl-done">Done</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) closeTaskChecklistModal(); });
      document.getElementById('nh-cl-x').addEventListener('click', closeTaskChecklistModal);
      document.getElementById('nh-cl-done').addEventListener('click', () => {
        closeTaskChecklistModal();
        render();
      });
    }

    document.getElementById('nh-cl-title').textContent = item.label;
    const linkHtml = taskLinkHtml(item);
    document.getElementById('nh-cl-sub').innerHTML = `${esc(hire.name)} · ${esc(item.assignee || item.role)} · check off each step${linkHtml ? ' · ' + linkHtml : ''}`;
    document.getElementById('nh-cl-count').textContent = `${done} of ${steps.length} complete`;
    document.getElementById('nh-cl-steps').innerHTML = steps.map((s) => `
      <label class="nh-cl-step">
        <input type="checkbox" data-cl-hire="${esc(hireId)}" data-cl-item="${esc(itemId)}" data-cl-step="${esc(s.id)}" ${map[s.id] ? 'checked' : ''}>
        <span>${esc(s.label)}</span>
      </label>
    `).join('');

    document.getElementById('nh-cl-steps').querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const hid = cb.getAttribute('data-cl-hire');
        const iid = cb.getAttribute('data-cl-item');
        const sid = cb.getAttribute('data-cl-step');
        const prog = progressOf(hid);
        if (!prog.checklists[iid]) prog.checklists[iid] = {};
        if (cb.checked) prog.checklists[iid][sid] = true;
        else delete prog.checklists[iid][sid];
        syncChecklistCompletion(hid, iid);
        persist();
        const item2 = data.items.find((i) => i.id === iid);
        const steps2 = normalizeSteps(item2);
        const done2 = steps2.filter((s) => !!(prog.checklists[iid] && prog.checklists[iid][s.id])).length;
        document.getElementById('nh-cl-count').textContent = `${done2} of ${steps2.length} complete`;
      });
    });

    modal.classList.add('open');
  }

  function closeTaskChecklistModal() {
    document.getElementById('nh-task-checklist-modal')?.classList.remove('open');
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
    const raw = {};
    ['region', 'city_center', 'start_date', 'work_start_date', 'bootcamp_start_date', 'assigned_pm', 'full_name', 'preferred_name', 'status', 'status_note', 'employee_type'].forEach((k) => {
      if (patch[k] !== undefined) raw[k] = patch[k] || null;
    });
    const omit = new Set(missingEmpCols);
    for (let attempt = 0; attempt < OPTIONAL_EMP_COLS.length + 2; attempt++) {
      const body = omitEmpCols(raw, omit);
      if (!Object.keys(body).length) return;
      const { error } = await supabase.from('employees').update(body).eq('id', id);
      if (!error) return;
      if (rememberMissingEmpCols(error)) {
        OPTIONAL_EMP_COLS.forEach((k) => { if (missingEmpCols.has(k)) omit.add(k); });
        continue;
      }
      throw new Error(error.message || String(error));
    }
  }

  function deleteProcessItem(id) {
    ensureData();
    const it = data.items.find((i) => i.id === id);
    if (!it) return false;
    if (!ownsProcessItem(it)) {
      alert('You can only delete tasks assigned to you.');
      return false;
    }
    if (!confirm(`Delete "${it.label}" from the shared process?`)) return false;
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
      btn.addEventListener('click', () => openItemModal(null, btn.getAttribute('data-add-section'), { forSelf: !canManageAllTasks() }));
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
      root.querySelectorAll('[data-due-anchor]').forEach((sel) => {
        sel.addEventListener('change', () => {
          const id = sel.getAttribute('data-due-anchor');
          const it = data.items.find((i) => i.id === id);
          if (!it) return;
          it.dueAnchor = normalizeDueAnchor(sel.value);
          normalizeItemDue(it);
          persist();
          processAdminOpen[it.sectionId] = true;
          if (onRefresh) onRefresh();
        });
        sel.addEventListener('click', (e) => e.stopPropagation());
      });
      root.querySelectorAll('[data-due-before]').forEach((inp) => {
        const commit = () => {
          const id = inp.getAttribute('data-due-before');
          const it = data.items.find((i) => i.id === id);
          if (!it) return;
          it.dueDaysBefore = Math.max(0, parseInt(inp.value, 10) || 0);
          it.dueOffsetDays = -it.dueDaysBefore;
          normalizeItemDue(it);
          inp.value = String(it.dueDaysBefore);
          persist();
          processAdminOpen[it.sectionId] = true;
          const meta = inp.closest('.nh-template-row')?.querySelector('.nh-due');
          if (meta) meta.textContent = dueRuleLabel(it);
        };
        inp.addEventListener('change', commit);
        inp.addEventListener('click', (e) => e.stopPropagation());
      });
    }
  }

  function roleChipClass(role) {
    const key = String(role || '').toLowerCase().replace(/\s+/g, '');
    if (key === 'hr') return 'nh-role-hr';
    if (key === 'admin') return 'nh-role-admin';
    if (key === 'logistics') return 'nh-role-logistics';
    if (key === 'training') return 'nh-role-training';
    if (key === 'pm') return 'nh-role-pm';
    return 'nh-role-other';
  }

  function processSectionsHtml(opts) {
    ensureData();
    const adminMode = !!(opts && opts.adminMode);
    const manageAll = canManageAllTasks();
    const showAllTasks = adminMode || manageAll;
    return (data.sections || []).map((sec) => {
      let items = itemsForSection(sec.id).filter((it) => it.role !== 'PM');
      if (!showAllTasks) {
        items = items.filter((it) => ownsProcessItem(it));
      }
      const expanded = processAdminOpen[sec.id] === true;
      const roleCounts = {};
      items.forEach((it) => {
        const r = it.role || 'Other';
        roleCounts[r] = (roleCounts[r] || 0) + 1;
      });
      const toneRole = Object.keys(roleCounts).sort((a, b) => roleCounts[b] - roleCounts[a])[0] || '';
      return `
        <div class="nh-section nh-process-sec ${toneRole ? 'nh-tone-' + esc(roleChipClass(toneRole)) : ''} ${expanded ? 'open' : ''}">
          <button type="button" class="nh-section-head nh-bar-white nh-process-sec-head" data-toggle-process-sec="${esc(sec.id)}">
            <div class="nh-section-left">
              <span class="nh-chevron">${expanded ? '▾' : '▸'}</span>
              <div class="nh-section-title">${esc(sec.id)}. ${esc(sec.title)}</div>
            </div>
            <div class="nh-section-right">
              <span class="nh-section-counts"><strong>${items.length}</strong> task${items.length === 1 ? '' : 's'}${showAllTasks ? '' : ' (yours)'}</span>
            </div>
          </button>
          <div class="nh-section-body" ${expanded ? '' : 'hidden'}>
            <div class="nh-process-cat-actions">
              <button class="btn-primary" type="button" data-add-section="${esc(sec.id)}">+ Add task to ${esc(sec.id)}</button>
              <span class="nh-muted">${adminMode && manageAll
                ? 'Admin: you can add, edit, or delete anyone’s tasks. Due date = selected date minus “days before”. Set dependency if a task must wait on another.'
                : 'Add tasks for yourself. Edit or delete only tasks assigned to you. Admins manage everyone’s tasks in Admin → Checklist Process.'}</span>
            </div>
            <div class="nh-template-list">
              ${items.length ? items.map((it) => {
                const depOn = !!(it.dependsOnPrior || it.dependsOnTaskId);
                const depLabel = it.dependsOnTaskId ? taskLabelById(it.dependsOnTaskId) : '';
                const daysBefore = daysBeforeOf(it);
                const canOwn = manageAll || ownsProcessItem(it);
                return `
                <div class="nh-template-row${depOn ? ' nh-has-dependency' : ''}${canOwn ? ' nh-mine-owned' : ''}">
                  <div>
                    <div class="nh-field-label" style="font-size:13px;font-weight:600;color:#1e293b">${esc(it.label)}</div>
                    <div class="nh-todo-meta">
                      <span class="nh-person-role"><span class="nh-owner-chip">${esc(it.assignee)}</span><span class="nh-role-chip ${roleChipClass(it.role)}">${esc(it.role)}</span></span>
                      <span class="nh-type">${esc(it.inputType)}</span>
                      <span class="nh-due">${esc(dueRuleLabel(it))}</span>
                      ${normalizeSteps(it).length ? `<span class="nh-steps-chip">${normalizeSteps(it).length}-step check-off</span>` : ''}
                      ${taskLinkHtml(it) || ''}
                      ${depOn && adminMode ? `<span class="nh-dep-badge">${depLabel ? 'Depends on: ' + esc(depLabel) : 'Pick prerequisite…'}</span>` : ''}
                    </div>
                    ${adminMode && manageAll ? `
                      <div class="nh-due-inline">
                        <label class="nh-check-label">Based on
                          <select class="form-input nh-due-anchor" data-due-anchor="${esc(it.id)}" title="Date used to calculate due date">
                            ${dueAnchorOptionsHtml(it.dueAnchor)}
                          </select>
                        </label>
                        <label class="nh-check-label">Days before
                          <input class="form-input nh-due-before" type="number" min="0" step="1" value="${daysBefore}" data-due-before="${esc(it.id)}" title="Days before the selected date (0 = same day)">
                        </label>
                      </div>
                    ` : ''}
                  </div>
                  <div class="nh-template-actions">
                    ${adminMode && manageAll ? `
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
                    ${canOwn ? `
                      <button class="btn-xs" type="button" data-edit-item="${esc(it.id)}">Edit</button>
                      <button class="btn-xs danger" type="button" data-del-item="${esc(it.id)}">Delete</button>
                    ` : `<span class="nh-muted" style="font-size:11px">Assigned to ${esc(it.assignee || 'other')}</span>`}
                  </div>
                </div>`;
              }).join('') : `<div class="nh-empty-block" style="border:none;margin:8px">${showAllTasks ? 'No tasks in this category yet.' : 'No tasks assigned to you in this category.'}</div>`}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function resetAllDueDefaults() {
    ensureData();
    (data.items || []).forEach((it) => {
      it.dueAnchor = 'orientation';
      it.dueDaysBefore = 0;
      it.dueOffsetDays = 0;
    });
    persist();
  }

  function renderProcessAdmin(root) {
    if (!root) return;
    ensureData();
    if (!data.items?.length) data = seed();
    (data.sections || []).forEach((s) => {
      if (processAdminOpen[s.id] === undefined) processAdminOpen[s.id] = false;
    });
    const total = (data.items || []).length;
    const manageAll = canManageAllTasks();
    root.innerHTML = `
      <div class="nh-process-admin-banner">
        <p class="user-mgmt-subtitle" style="margin:0">${total} tasks across ${(data.sections || []).length} categories. ${manageAll
          ? 'You see <strong>everyone’s</strong> tasks and can add, edit, or delete any of them.'
          : 'Showing tasks assigned to you.'} Due = chosen date minus days before (default: 0 days before Orientation).</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button type="button" class="btn-secondary" id="nh-reset-dues">Reset all dues → 0 days before Orientation</button>
        </div>
      </div>
      <div class="nh-role-legend" aria-hidden="true">
        <span class="nh-role-chip nh-role-hr">HR</span>
        <span class="nh-role-chip nh-role-admin">Admin</span>
        <span class="nh-role-chip nh-role-logistics">Logistics</span>
        <span class="nh-role-chip nh-role-training">Training</span>
      </div>
      ${processSectionsHtml({ adminMode: true })}`;
    root.querySelector('#nh-reset-dues')?.addEventListener('click', () => {
      if (!confirm('Set every task to 0 days before Orientation date? You can still change individual tasks after.')) return;
      resetAllDueDefaults();
      renderProcessAdmin(root);
      if (document.getElementById('page-checklist')?.classList.contains('active')) render();
    });
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

  // Jul + Aug 2026 cohort to keep Active (Angel Leon Pagan struck from Aug list — archive)
  const KEEP_ACTIVE_COHORT = [
    { full_name: 'Hakym Conejo', preferred_name: '', start_date: null, cohort: 'July 2026' },
    { full_name: 'Jackson Price', preferred_name: '', start_date: null, cohort: 'July 2026' },
    { full_name: 'Joshua Kropf', preferred_name: 'Josh', start_date: null, cohort: 'July 2026' },
    { full_name: 'Ryan Dinger', preferred_name: '', start_date: null, cohort: 'July 2026' },
    { full_name: 'James Bell', preferred_name: '', start_date: null, cohort: 'July 2026' },
    { full_name: 'Clinton Duru', preferred_name: '', start_date: null, cohort: 'July 2026' },
    { full_name: 'Javed Mohammed', preferred_name: '', start_date: '2026-08-18', cohort: 'August 2026' },
    { full_name: 'David Summiel IV', preferred_name: '', start_date: '2026-08-18', cohort: 'August 2026' },
    { full_name: 'Ryan Esparza', preferred_name: '', start_date: '2026-08-18', cohort: 'August 2026' },
    { full_name: 'Bilardo Artiga', preferred_name: '', start_date: '2026-08-18', cohort: 'August 2026' },
    { full_name: 'Evan Smith', preferred_name: '', start_date: '2026-08-18', cohort: 'August 2026' },
    { full_name: 'Derrick Jackson', preferred_name: '', start_date: '2026-08-18', cohort: 'August 2026' },
    { full_name: 'Chase Grahl', preferred_name: '', start_date: '2026-08-18', cohort: 'August 2026' }
  ];

  function normalizeNameKey(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/\(goes\s+by[^)]*\)/gi, ' ')
      .replace(/goes\s+by\s+/gi, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/["']/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cohortAliasKeys(row) {
    const full = normalizeNameKey(row.full_name);
    const keys = [full].filter(Boolean);
    if (row.preferred_name) {
      const parts = String(row.full_name || '').trim().split(/\s+/);
      const first = parts[0] || '';
      const last = parts[parts.length - 1] || '';
      keys.push(normalizeNameKey(`${first} ${row.preferred_name}`));
      keys.push(normalizeNameKey(`${row.preferred_name} ${last}`));
    }
    if (/joshua kropf/i.test(row.full_name || '')) {
      keys.push('josh kropf', 'joshua josh kropf', 'joshua kropf');
    }
    if (/david summiel/i.test(row.full_name || '')) {
      keys.push('david summiel', 'david summiel iv');
    }
    return [...new Set(keys.filter(Boolean))];
  }

  function nameKeysMatch(candidate, key) {
    if (!candidate || !key) return false;
    if (candidate === key) return true;
    const ct = candidate.split(' ').filter(Boolean);
    const kt = key.split(' ').filter(Boolean);
    if (ct.length < 2 || kt.length < 2) return false;
    // Same last name + overlapping given name (covers Josh/Joshua Kropf)
    if (ct[ct.length - 1] !== kt[kt.length - 1]) return false;
    const cGiven = new Set(ct.slice(0, -1));
    const kGiven = new Set(kt.slice(0, -1));
    for (const g of kGiven) {
      if (cGiven.has(g)) return true;
    }
    return false;
  }

  function hireMatchesKeepList(emp) {
    const keys = KEEP_ACTIVE_COHORT.flatMap(cohortAliasKeys);
    const candidates = [
      emp.full_name,
      emp.preferred_name && emp.full_name
        ? `${parseGoesByFromFullName(emp.full_name).full_name.split(/\s+/)[0] || ''} ${emp.preferred_name}`
        : '',
      displayHireName(emp),
      parseGoesByFromFullName(emp.full_name || '').full_name
    ].map(normalizeNameKey).filter(Boolean);
    return candidates.some((c) => keys.some((k) => nameKeysMatch(c, k)));
  }

  function findEmployeeForCohortRow(row) {
    const keys = cohortAliasKeys(row);
    return employees.find((e) => {
      const candidates = [
        e.full_name,
        e.preferred_name && e.full_name
          ? `${parseGoesByFromFullName(e.full_name).full_name.split(/\s+/)[0] || ''} ${e.preferred_name}`
          : '',
        displayHireName(e),
        parseGoesByFromFullName(e.full_name || '').full_name
      ].map(normalizeNameKey).filter(Boolean);
      return candidates.some((c) => keys.some((k) => nameKeysMatch(c, k)));
    });
  }

  function markHireProgressComplete(empId) {
    ensureData();
    const p = progressOf(empId);
    (data.items || []).forEach((item) => {
      const steps = normalizeSteps(item);
      if (steps.length) {
        if (!p.checklists[item.id]) p.checklists[item.id] = {};
        steps.forEach((s) => { p.checklists[item.id][s.id] = true; });
        p.values[item.id] = true;
        return;
      }
      if (item.inputType === 'checkbox') {
        p.values[item.id] = true;
        return;
      }
      if (isFilled(item, p.values[item.id])) return;
      if (item.inputType === 'date') {
        p.values[item.id] = fmtDate(new Date());
      } else {
        p.values[item.id] = 'Done';
      }
    });
  }

  async function ensureCohortEmployees() {
    const supabase = client();
    if (!supabase) throw new Error('Not signed in');
    let created = 0;
    let reactivated = 0;
    const errors = [];
    for (const row of KEEP_ACTIVE_COHORT) {
      let emp = findEmployeeForCohortRow(row);
      if (!emp) {
        const payload = {
          full_name: row.preferred_name
            ? `${row.full_name} (Goes by ${row.preferred_name})`
            : row.full_name,
          preferred_name: row.preferred_name || null,
          region: 'National',
          employee_type: 'technician',
          city_center: null,
          start_date: row.start_date,
          work_start_date: null,
          bootcamp_start_date: null,
          status: 'active',
          status_note: `${row.cohort} cohort`
        };
        const omit = new Set(missingEmpCols);
        let inserted = null;
        let error = null;
        for (let attempt = 0; attempt < OPTIONAL_EMP_COLS.length + 2; attempt++) {
          const body = omitEmpCols(payload, omit);
          const cols = selectColsWithout(omit);
          ({ data: inserted, error } = await supabase.from('employees').insert(body).select(cols).single());
          if (!error) {
            if (inserted) {
              inserted.preferred_name = inserted.preferred_name ?? payload.preferred_name;
              inserted.city_center = inserted.city_center ?? null;
              inserted.work_start_date = inserted.work_start_date ?? null;
            }
            break;
          }
          if (rememberMissingEmpCols(error)) {
            OPTIONAL_EMP_COLS.forEach((k) => { if (missingEmpCols.has(k)) omit.add(k); });
            continue;
          }
          break;
        }
        if (error) {
          errors.push(`Add ${row.full_name}: ${error.message}`);
          continue;
        }
        employees.unshift(inserted);
        emp = inserted;
        created += 1;
      } else {
        const patch = {};
        if ((emp.status || 'active') !== 'active') {
          patch.status = 'active';
          patch.status_note = `${row.cohort} cohort — reactivated`;
          reactivated += 1;
        } else {
          patch.status_note = `${row.cohort} cohort`;
        }
        // August cohort: force orientation date from spreadsheet
        if (row.start_date && emp.start_date !== row.start_date) patch.start_date = row.start_date;
        if (row.preferred_name && !emp.preferred_name) patch.preferred_name = row.preferred_name;
        if (Object.keys(patch).length) {
          try {
            await syncEmployeePatch(emp.id, patch);
            Object.assign(emp, patch);
          } catch (e) {
            errors.push(`Update ${row.full_name}: ${e.message || e}`);
          }
        }
      }
    }
    return { created, reactivated, errors };
  }

  async function archiveOlderHiresKeepNew(opts) {
    const auto = !!(opts && opts.auto);
    ensureData();
    if (!employees.length) {
      try { await loadEmployees(); } catch (e) { /* ignore */ }
    }
    if (!employees.length) {
      if (!auto) alert('No employees loaded yet. Open New Hire Checklist first, then try again.');
      return { archived: 0, kept: 0, cancelled: true };
    }

    let ensureResult = { created: 0, reactivated: 0, errors: [] };
    try {
      ensureResult = await ensureCohortEmployees();
    } catch (e) {
      if (!auto) alert('Could not sync cohort employees: ' + (e.message || e));
      return { archived: 0, kept: 0, cancelled: true, errors: [String(e.message || e)] };
    }

    const toArchive = employees.filter((e) => (e.status || 'active') === 'active' && !hireMatchesKeepList(e));
    const kept = employees.filter((e) => hireMatchesKeepList(e));
    if (!auto) {
      const ok = confirm(
        `Sync Jul/Aug 2026 cohort?\n\n` +
        `• Add missing: ${ensureResult.created} already created this run (or 0 if all present)\n` +
        `• Keep / reactivate Active (${kept.length}):\n` +
        kept.map((e) => `  • ${displayHireName(e)}`).join('\n') +
        `\n\n• Archive everyone else currently Active (${toArchive.length}) at 100% complete` +
        `\n\nAngel Leon Pagan is NOT on the keep list and will be archived if Active.`
      );
      if (!ok) return { archived: 0, kept: kept.length, created: ensureResult.created, cancelled: true };
    }

    let archived = 0;
    const errors = [...(ensureResult.errors || [])];
    for (const emp of toArchive) {
      const prev = emp.status;
      emp.status = 'archived';
      markHireProgressComplete(emp.id);
      try {
        await syncEmployeePatch(emp.id, {
          status: 'archived',
          status_note: emp.status_note || 'Archived — not on Jul/Aug 2026 cohort list'
        });
        archived += 1;
      } catch (e) {
        emp.status = prev;
        errors.push(`${displayHireName(emp)}: ${e.message || e}`);
      }
    }
    persist();
    try { await loadEmployees(); } catch (e) { /* ignore */ }
    render();
    const msg =
      `Cohort synced.\n` +
      `Added ${ensureResult.created}, reactivated ${ensureResult.reactivated}, ` +
      `archived ${archived}, kept Active ${kept.length}.`;
    if (errors.length) alert(msg + '\n\nSome updates failed:\n' + errors.slice(0, 10).join('\n'));
    else if (!auto || archived || ensureResult.created) alert(msg);
    return { archived, kept: kept.length, created: ensureResult.created, reactivated: ensureResult.reactivated, errors, cancelled: false };
  }

  function refreshAfterProcessChange() {
    const adminRoot = document.getElementById('nh-process-admin-root');
    if (adminRoot) renderProcessAdmin(adminRoot);
    if (document.getElementById('page-checklist')?.classList.contains('active')) render();
  }

  function renderTemplate(root) {
    setPageTitle('Edit process');
    setPageSub(canManageAllTasks()
      ? 'Admin: see and manage everyone’s process tasks. Non-admins only see and edit their own.'
      : 'Your process tasks only — add, edit, or delete work assigned to you. Admins manage everyone’s tasks under Admin.');
    (data.sections || []).forEach((s) => {
      if (processAdminOpen[s.id] === undefined) processAdminOpen[s.id] = true;
    });
    root.innerHTML = `
      <div class="nh-detail-top">
        <button class="btn-secondary" type="button" id="nh-back-t">← Back</button>
        <div class="nh-detail-actions">
          <button class="btn-primary" type="button" id="nh-add-item">+ Add my task</button>
        </div>
      </div>
      <div class="nh-role-legend" aria-hidden="true">
        <span class="nh-role-chip nh-role-hr">HR</span>
        <span class="nh-role-chip nh-role-admin">Admin</span>
        <span class="nh-role-chip nh-role-logistics">Logistics</span>
        <span class="nh-role-chip nh-role-training">Training</span>
      </div>
      ${processSectionsHtml({ adminMode: canManageAllTasks() })}`;
    root.querySelector('#nh-back-t').addEventListener('click', () => { view = 'dashboard'; render(); });
    root.querySelector('#nh-add-item').addEventListener('click', () => openItemModal(null, null, { forSelf: true }));
    bindProcessEditor(root, { adminMode: canManageAllTasks(), onRefresh: () => renderTemplate(root) });
  }

  function openHireModal(id) {
    ensureData();
    document.getElementById('nh-hire-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'nh-hire-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
        <div class="modal" style="width:560px">
          <div class="modal-head"><span class="modal-title" id="nh-hire-title">Add new hire</span><button class="modal-close" type="button" id="nh-hire-x">×</button></div>
          <div class="modal-body">
            <input type="hidden" id="nh-hire-id">
            <div class="form-row"><label class="form-label">Full name *</label><input id="nh-hire-name" class="form-input" type="text"></div>
            <div class="form-row">
              <label class="form-label">Goes By</label>
              <input id="nh-hire-goes-by" class="form-input" type="text" placeholder="Name they go by (shown in parentheses)">
            </div>
            <div class="form-row-2">
              <div><label class="form-label">Position *</label>
                <select id="nh-hire-role" class="form-input">
                  <option value="">— Select position —</option>
                  <option value="technician">TAB Technician</option>
                  <option value="kes_installer">KES Installer</option>
                  <option value="office_staff">Office Staff</option>
                </select>
              </div>
              <div><label class="form-label">Region *</label>
                <select id="nh-hire-division" class="form-input">
                  <option value="">— Select region —</option>
                  ${REGION_OPTIONS.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-row">
              <label class="form-label">City center</label>
              <input id="nh-hire-city" class="form-input" type="text" list="nh-city-dl" placeholder="e.g. Boston, Dallas, Denver…">
              <datalist id="nh-city-dl"></datalist>
            </div>
            <div class="form-row">
              <label class="form-label">Orientation date *</label>
              <input id="nh-hire-start" class="form-input" type="date">
              <label class="nh-check-label" style="margin-top:8px;white-space:normal">
                <input type="checkbox" id="nh-hire-diff-start">
                Different start date
              </label>
              <div id="nh-hire-work-start-wrap" hidden style="margin-top:10px">
                <label class="form-label">Start date</label>
                <input id="nh-hire-work-start" class="form-input" type="date" title="Work start when it is not the orientation date">
              </div>
            </div>
            <div class="form-row">
              <label class="form-label">Bootcamp date</label>
              <input id="nh-hire-boot" class="form-input" type="date">
            </div>
            <div class="form-row-2">
              <div><label class="form-label">Status</label>
                <select id="nh-hire-status" class="form-input">
                  <option value="active">Active</option>
                  <option value="archived">Archive</option>
                  <option value="terminated">Terminated</option>
                  <option value="quit">Quit</option>
                  <option value="rescinded">Rescinded</option>
                  <option value="resigned">Resigned</option>
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
    const emp = id ? employees.find((e) => e.id === id) : null;
    const cityOpts = [...new Set([...CITY_CENTER_OPTIONS, ...employees.map((e) => e.city_center).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
    document.getElementById('nh-city-dl').innerHTML = cityOpts.map((c) => `<option value="${esc(c)}">`).join('');
    document.getElementById('nh-hire-title').textContent = emp ? 'Edit hire' : 'Add new hire';
    document.getElementById('nh-hire-id').value = emp?.id || '';
    const parsedName = parseGoesByFromFullName(emp?.full_name || '');
    const fullForForm = emp?.preferred_name
      ? (/\(\s*Goes\s+by\s+/i.test(emp.full_name || '') ? parsedName.full_name : (emp.full_name || ''))
      : (parsedName.preferred_name ? parsedName.full_name : (emp?.full_name || ''));
    const goesForForm = emp?.preferred_name || parsedName.preferred_name || '';
    document.getElementById('nh-hire-name').value = fullForForm;
    document.getElementById('nh-hire-goes-by').value = goesForForm;
    document.getElementById('nh-hire-division').value = normalizeRegion(emp?.region) || emp?.region || '';
    document.getElementById('nh-hire-role').value = emp ? normalizePosition(emp.employee_type) : '';
    document.getElementById('nh-hire-city').value = emp?.city_center || '';
    document.getElementById('nh-hire-start').value = (emp?.start_date || '').slice(0, 10);
    const orient = (emp?.start_date || '').slice(0, 10);
    const work = (emp?.work_start_date || '').slice(0, 10);
    const differentStart = !!(work && orient && work !== orient);
    document.getElementById('nh-hire-work-start').value = differentStart ? work : '';
    document.getElementById('nh-hire-diff-start').checked = differentStart;
    document.getElementById('nh-hire-work-start-wrap').hidden = !differentStart;
    document.getElementById('nh-hire-diff-start').addEventListener('change', syncHireWorkStartUi);
    document.getElementById('nh-hire-boot').value = (emp?.bootcamp_start_date || '').slice(0, 10);
    document.getElementById('nh-hire-status').value = emp?.status || 'active';
    document.getElementById('nh-hire-note').value = emp?.status_note || '';
    modal.classList.add('open');
  }

  function syncHireWorkStartUi() {
    const on = document.getElementById('nh-hire-diff-start')?.checked;
    const wrap = document.getElementById('nh-hire-work-start-wrap');
    const work = document.getElementById('nh-hire-work-start');
    const orient = document.getElementById('nh-hire-start')?.value || '';
    if (!wrap || !work) return;
    wrap.hidden = !on;
    if (on && !work.value && orient) work.value = orient;
  }

  function closeHireModal() {
    document.getElementById('nh-hire-modal')?.classList.remove('open');
  }

  async function saveHireModal() {
    const id = document.getElementById('nh-hire-id').value;
    let full_name = document.getElementById('nh-hire-name').value.trim();
    let preferred_name = document.getElementById('nh-hire-goes-by').value.trim() || null;
    // If full name still contains legacy "(Goes by …)", split it cleanly
    const embedded = parseGoesByFromFullName(full_name);
    if (embedded.preferred_name) {
      full_name = embedded.full_name;
      if (!preferred_name) preferred_name = embedded.preferred_name;
    }
    const region = normalizeRegion(document.getElementById('nh-hire-division').value.trim());
    const roleRaw = document.getElementById('nh-hire-role').value.trim();
    const employee_type = normalizePosition(roleRaw);
    const city_center = document.getElementById('nh-hire-city').value.trim() || null;
    const start_date = document.getElementById('nh-hire-start').value || null; // Orientation date
    const differentStart = !!document.getElementById('nh-hire-diff-start')?.checked;
    let work_start_date = document.getElementById('nh-hire-work-start').value || null;
    if (!differentStart) work_start_date = start_date;
    else if (!work_start_date) {
      alert('Pick a start date, or uncheck Different start date.');
      return;
    }
    const bootcamp_start_date = document.getElementById('nh-hire-boot').value || null;
    const status = document.getElementById('nh-hire-status').value;
    const status_note = document.getElementById('nh-hire-note').value.trim() || null;
    if (!full_name || !roleRaw || !region || !start_date) {
      alert('Name, position, region, and Orientation date are required.');
      return;
    }
    const supabase = client();
    const payload = { full_name, preferred_name, region, employee_type, city_center, start_date, work_start_date, bootcamp_start_date, status, status_note };
    async function writeEmp(kind) {
      // Always omit columns we already know are missing in this project
      const omit = new Set(missingEmpCols);
      for (let attempt = 0; attempt < OPTIONAL_EMP_COLS.length + 2; attempt++) {
        const body = omitEmpCols(payload, omit);
        const cols = selectColsWithout(omit);
        if (kind === 'update') {
          const { error } = await supabase.from('employees').update(body).eq('id', id);
          if (!error) return null;
          if (rememberMissingEmpCols(error)) {
            OPTIONAL_EMP_COLS.forEach((k) => { if (missingEmpCols.has(k)) omit.add(k); });
            continue;
          }
          return error;
        }
        const { data: created, error } = await supabase.from('employees').insert(body).select(cols).single();
        if (!error) {
          if (created) {
            created.city_center = created.city_center ?? city_center;
            created.work_start_date = created.work_start_date ?? work_start_date;
            created.preferred_name = created.preferred_name ?? preferred_name;
          }
          return { created, error: null };
        }
        if (rememberMissingEmpCols(error)) {
          OPTIONAL_EMP_COLS.forEach((k) => { if (missingEmpCols.has(k)) omit.add(k); });
          continue;
        }
        return { created: null, error };
      }
      return kind === 'update'
        ? { message: 'Could not update employee after stripping optional columns.' }
        : { created: null, error: { message: 'Could not create employee after stripping optional columns.' } };
    }
    if (id) {
      const error = await writeEmp('update');
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
      const { created, error } = await writeEmp('insert');
      if (error) { alert('Could not create employee: ' + error.message); return; }
      employees.unshift(created);
      const regionItem = data.items.find((i) => i.label === 'Region');
      const startItem = data.items.find((i) => /START DATE/i.test(i.label));
      const bootItem = data.items.find((i) => /First Day of BOOTCAMP/i.test(i.label));
      const p = progressOf(created.id);
      if (regionItem) p.values[regionItem.id] = region;
      if (startItem) p.values[startItem.id] = start_date;
      if (bootItem && bootcamp_start_date) p.values[bootItem.id] = bootcamp_start_date;
      persist();
      closeHireModal();
      openHireDetail(created.id);
      return;
    }
    closeHireModal();
    render();
  }

  function renderItemStepsEditor(steps) {
    const root = document.getElementById('nh-item-steps');
    if (!root) return;
    const list = (steps && steps.length) ? steps : [];
    root.innerHTML = list.length
      ? list.map((s, idx) => `
          <div class="nh-step-edit-row" data-step-idx="${idx}" data-step-id="${esc(s.id || '')}">
            <span class="nh-step-num">${idx + 1}.</span>
            <input class="form-input nh-step-label" type="text" value="${esc(s.label)}" placeholder="Step to check off…">
            <button type="button" class="btn-xs danger" data-remove-step="${idx}">Remove</button>
          </div>
        `).join('')
      : '<p class="nh-muted" style="margin:0">No check-off steps yet. Add steps only if this task needs a multi-item list (e.g. RingCentral setup).</p>';

    root.querySelectorAll('[data-remove-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rows = collectItemStepsFromEditor();
        rows.splice(+btn.getAttribute('data-remove-step'), 1);
        renderItemStepsEditor(rows);
      });
    });
  }

  function collectItemStepsFromEditor() {
    const root = document.getElementById('nh-item-steps');
    if (!root) return [];
    return [...root.querySelectorAll('.nh-step-edit-row')].map((row, i) => {
      const label = row.querySelector('.nh-step-label')?.value.trim() || '';
      const prevId = row.getAttribute('data-step-id');
      return { id: prevId || uid('s'), label };
    }).filter((s) => s.label);
  }

  function openItemModal(id, defaultSectionId, opts) {
    ensureData();
    const forSelf = !!(opts && opts.forSelf);
    const it = id ? data.items.find((i) => i.id === id) : null;
    if (it && !ownsProcessItem(it)) {
      alert('You can only edit tasks assigned to you.');
      return;
    }
    let modal = document.getElementById('nh-item-modal');
    if (modal) modal.remove(); // rebuild so Edit card always has checklist editor
    modal = document.createElement('div');
    modal.id = 'nh-item-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="width:600px;max-height:90vh;overflow:auto">
        <div class="modal-head"><span class="modal-title" id="nh-item-title">Add task</span><button class="modal-close" type="button" id="nh-item-x">×</button></div>
        <div class="modal-body">
          <input type="hidden" id="nh-item-id">
          <div class="form-row"><label class="form-label">Category *</label><select id="nh-item-section" class="form-input"></select></div>
          <div class="form-row"><label class="form-label">Task label *</label><input id="nh-item-label" class="form-input" type="text" placeholder="e.g. RingCentral account creation"></div>
          <div class="form-row-2">
            <div><label class="form-label">Role *</label>
              <select id="nh-item-role" class="form-input">
                <option>HR</option><option>Admin</option><option>Logistics</option><option>Training</option>
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
            <div><label class="form-label">Dropdown options (comma-sep)</label><input id="nh-item-options" class="form-input" type="text" placeholder="Yes, No, N/A"></div>
          </div>
          <div class="form-row-2">
            <div><label class="form-label">Due date based on</label>
              <select id="nh-item-anchor" class="form-input">
                <option value="orientation" selected>Orientation date</option>
                <option value="work_start">Start date</option>
                <option value="bootcamp">Bootcamp date</option>
              </select>
            </div>
            <div><label class="form-label">Days before that date</label>
              <input id="nh-item-days-before" class="form-input" type="number" min="0" step="1" value="0">
              <p class="nh-muted" style="margin:6px 0 0">Default is 0 days before Orientation (due on Orientation day).</p>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">Link (optional)</label>
            <input id="nh-item-link" class="form-input" type="url" placeholder="https://…">
            <p class="nh-muted" style="margin:6px 0 0">Only shown on the task when a URL is saved. Leave blank for no link.</p>
          </div>
          <div class="form-row nh-item-steps-block">
            <label class="form-label">Check-off list (optional)</label>
            <p class="nh-muted" style="margin:0 0 8px">Add steps only when this task needs a multi-item check-off (e.g. RingCentral). On the hire, clicking the task opens this list.</p>
            <div id="nh-item-steps"></div>
            <button type="button" class="btn-secondary" id="nh-item-add-step" style="margin-top:8px">+ Add check-off step</button>
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
    document.getElementById('nh-item-add-step').addEventListener('click', () => {
      const rows = collectItemStepsFromEditor();
      rows.push({ id: uid('s'), label: '' });
      renderItemStepsEditor(rows);
      const inputs = document.querySelectorAll('#nh-item-steps .nh-step-label');
      inputs[inputs.length - 1]?.focus();
    });

    document.getElementById('nh-item-section').innerHTML = data.sections.map((s) =>
      `<option value="${s.id}">${esc(s.id)}. ${esc(s.title)}</option>`
    ).join('');
    const allPeople = [...new Set((data.roles || []).flatMap((r) => r.people))];
    document.getElementById('nh-people-dl').innerHTML = allPeople.map((p) => `<option value="${esc(p)}">`).join('');
    document.getElementById('nh-item-title').textContent = it ? 'Edit task' : 'Add task';
    document.getElementById('nh-item-id').value = it?.id || '';
    document.getElementById('nh-item-section').value = it?.sectionId || defaultSectionId || 'A';
    document.getElementById('nh-item-label').value = it?.label || '';
    const meName = viewerChecklistName();
    const defaultRole = meName !== 'all'
      ? (primaryRoleForPerson(meName) || mapAppUserToChecklistRole(window.hubCurrentUser) || 'HR')
      : (mapAppUserToChecklistRole(window.hubCurrentUser) || 'HR');
    document.getElementById('nh-item-role').value = it?.role || (defaultRole === 'all' ? 'HR' : defaultRole);
    const defaultAssignee = meName !== 'all' ? meName : (window.hubCurrentUser?.full_name || '');
    document.getElementById('nh-item-assignee').value = it?.assignee || defaultAssignee;
    if (!canManageAllTasks() && (forSelf || !it)) {
      // Non-admins add as themselves; can still reassign when editing their own task
      if (!it || forSelf) {
        document.getElementById('nh-item-assignee').value = defaultAssignee || document.getElementById('nh-item-assignee').value;
      }
    }
    document.getElementById('nh-item-type').value = it?.inputType || 'checkbox';
    if (it) normalizeItemDue(it);
    document.getElementById('nh-item-anchor').value = normalizeDueAnchor(it?.dueAnchor || 'orientation');
    document.getElementById('nh-item-days-before').value = it ? daysBeforeOf(it) : 0;
    document.getElementById('nh-item-options').value = (it?.options || []).join(', ');
    document.getElementById('nh-item-link').value = it?.link || '';
    const steps = normalizeSteps(it || {});
    renderItemStepsEditor(steps.length ? steps : []);
    [...document.querySelectorAll('#nh-item-steps .nh-step-edit-row')].forEach((row, i) => {
      if (steps[i]) row.setAttribute('data-step-id', steps[i].id);
    });
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
    let assignee = document.getElementById('nh-item-assignee').value.trim();
    const inputType = document.getElementById('nh-item-type').value;
    const dueAnchor = normalizeDueAnchor(document.getElementById('nh-item-anchor').value);
    const dueDaysBefore = Math.max(0, parseInt(document.getElementById('nh-item-days-before').value, 10) || 0);
    const dueOffsetDays = -dueDaysBefore;
    const options = document.getElementById('nh-item-options').value.split(',').map((s) => s.trim()).filter(Boolean);
    const link = document.getElementById('nh-item-link').value.trim();
    const checklistSteps = collectItemStepsFromEditor().map((s, i) => ({
      id: s.id || ('s' + i),
      label: s.label
    }));
    if (!label || !assignee) { alert('Label and assignee are required.'); return; }
    if (id) {
      const existing = data.items.find((i) => i.id === id);
      if (!existing || !ownsProcessItem(existing)) {
        alert('You can only edit tasks assigned to you.');
        return;
      }
    } else if (!canManageAllTasks()) {
      // New tasks from non-admins default to themselves if blank / mismatched
      const me = viewerChecklistName();
      if (me !== 'all') assignee = me;
      else if (!assignee && window.hubCurrentUser?.full_name) assignee = window.hubCurrentUser.full_name;
    }
    if (id) {
      const it = data.items.find((i) => i.id === id);
      Object.assign(it, {
        sectionId, label, role, assignee, owner: assignee, inputType, options,
        dueOffsetDays, dueDaysBefore, dueAnchor, checklistSteps, link
      });
      normalizeItemDue(it);
    } else {
      const maxOrder = data.items.reduce((m, i) => Math.max(m, i.order || 0), 0);
      data.items.push(normalizeItemDue({
        id: uid('t'), sectionId, label, role, assignee, owner: assignee,
        inputType, options, dueOffsetDays, dueDaysBefore, dueAnchor, order: maxOrder + 1,
        sensitive: false, dependsOnPrior: false, dependsOnTaskId: null,
        checklistSteps, link
      }));
      processAdminOpen[sectionId] = true;
    }
    persist();
    closeItemModal();
    refreshAfterProcessChange();
    if (view === 'template' || view === 'detail') render();
  }

  function findItemByLabel(re) {
    ensureData();
    return (data.items || []).find((i) => re.test(i.label || ''));
  }

  function resumeItem() {
    return findItemByLabel(/^LINK to resume/i) || findItemByLabel(/resume/i);
  }

  function isHttpUrl(s) {
    return /^https?:\/\//i.test(String(s || '').trim());
  }

  function resumeValue(hire) {
    const it = resumeItem();
    if (!it) return '';
    return String(hire.values?.[it.id] || '').trim();
  }

  function resumeCellHtml(hire) {
    const it = resumeItem();
    const val = resumeValue(hire);
    if (!it) return '<span class="nh-muted">—</span>';
    if (isHttpUrl(val)) {
      return `<a class="nh-resume-link" href="${esc(val)}" target="_blank" rel="noopener">Open</a>`;
    }
    if (val) {
      return `<span class="nh-muted" title="${esc(val)}">On file</span>`;
    }
    return `<button type="button" class="btn-xs" data-open-hire="${esc(hire.id)}" title="Add resume link in hire checklist">Add link</button>`;
  }

  function displayProgressValue(hire, item, { sensitiveMask } = {}) {
    if (!item) return '—';
    const raw = hire.values?.[item.id];
    if (item.sensitive && !revealSensitive) {
      if (raw) return sensitiveMask === false ? String(raw) : '••••••••';
      return '—';
    }
    if (item.inputType === 'checkbox') return isFilled(item, raw, hire) ? 'Yes' : '—';
    const v = String(raw ?? '').trim();
    if (!v) return isFilled(item, raw, hire) ? 'Done' : '—';
    return v;
  }

  function statusReceivedLabel(hire, item) {
    if (!item) return '—';
    if (isFilled(item, hire.values?.[item.id], hire)) return 'Received';
    const v = String(hire.values?.[item.id] ?? '').trim();
    return v || 'Pending';
  }

  function orientationCohortDates() {
    const dates = [];
    const seen = new Set();
    employees.filter(isActiveHire).forEach((e) => {
      const d = e.start_date ? String(e.start_date).slice(0, 10) : '';
      if (d && !seen.has(d)) {
        seen.add(d);
        dates.push(d);
      }
    });
    dates.sort();
    return dates;
  }

  function pickDefaultCohort(dates) {
    if (!dates.length) return '';
    const today = todayIso();
    const upcoming = dates.find((d) => d >= today);
    return upcoming || dates[dates.length - 1];
  }

  function hiresForCohort(cohortDate) {
    return hires()
      .filter(isActiveHire)
      .filter((h) => {
        if (!cohortDate) return !h.startDate;
        return String(h.startDate || '').slice(0, 10) === cohortDate;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function meetingInviteValue(hire) {
    const p = progressOf(hire.id);
    return String(p.values._onboard_meeting_invite || '').trim();
  }

  function missingSectionsForHire(hire) {
    ensureData();
    const sections = [];
    let openCount = 0;
    (data.sections || []).forEach((sec) => {
      const items = itemsForSection(sec.id)
        .filter((it) => it.role !== 'PM')
        .filter((it) => !isFilled(it, hire.values?.[it.id], hire));
      if (!items.length) return;
      openCount += items.length;
      sections.push({ section: sec, items });
    });
    const overall = hireProgress(hire, 'all', 'all');
    return { sections, openCount, overall };
  }

  function missingDocHtml(hireList) {
    if (!hireList.length) {
      return '<div class="nh-empty-block">No active hires in this cohort</div>';
    }
    return hireList.map((h) => {
      const miss = missingSectionsForHire(h);
      const doneLine = `${miss.overall.done}/${miss.overall.total} complete · ${miss.openCount} open (all roles)`;
      const body = miss.sections.length
        ? miss.sections.map(({ section, items }) => `
            <div class="nh-missing-sec">
              <div class="nh-missing-sec-title">${esc(section.id)}. ${esc(section.title)} <span class="nh-muted">(${items.length} open)</span></div>
              <ul class="nh-missing-list">
                ${items.map((it) => `
                  <li>
                    <span class="nh-missing-task">${esc(it.label)}</span>
                    <span class="nh-person-role">
                      <span class="nh-owner-chip">${esc(assigneeOf(h, it) || it.assignee || '—')}</span>
                      <span class="nh-role-chip ${roleChipClass(it.role)}">${esc(it.role || '—')}</span>
                    </span>
                  </li>`).join('')}
              </ul>
            </div>`).join('')
        : '<p class="nh-missing-done">Nothing missing — checklist complete for all roles.</p>';
      return `
        <article class="nh-missing-card" data-missing-hire="${esc(h.id)}">
          <header class="nh-missing-head">
            <div>
              <h3 class="nh-missing-name">${esc(h.name)}</h3>
              <div class="nh-muted">${esc(h.division || '—')} · Orient ${esc(h.startDate || '—')} · Bootcamp ${esc(h.bootcampDate || '—')}</div>
              <div class="nh-missing-prog">${esc(doneLine)}</div>
            </div>
            <div class="nh-missing-actions nh-no-print">
              <button type="button" class="btn-xs primary" data-open-hire="${esc(h.id)}">Open checklist</button>
            </div>
          </header>
          ${body}
        </article>`;
    }).join('');
  }

  function renderReports(root) {
    ensureData();
    const dates = orientationCohortDates();
    if (!reportCohort || (reportCohort && !dates.includes(reportCohort) && reportCohort !== '__none__')) {
      reportCohort = pickDefaultCohort(dates);
    }
    const cohort = reportCohort === '__none__' ? '' : reportCohort;
    const cohortHires = hiresForCohort(cohort);

    const hrItem = findItemByLabel(/HR ONBOARDING COMPLETE/i);
    const upsItem = findItemByLabel(/^Tracking for Kit/i) || findItemByLabel(/UPS|Tracking for Kit/i);
    const ipadItem = findItemByLabel(/iPad is received by the new hire/i) || findItemByLabel(/Date iPad is received/i);
    const oshaItem = findItemByLabel(/OSHA-10 certified prior/i) || findItemByLabel(/OSHA/i);
    const diplomaItem = findItemByLabel(/HS Diploma received/i);
    const emailItem = findItemByLabel(/Airadigm\/KES email address/i) || findItemByLabel(/Airadigm.*email address/i);
    const msPassItem = findItemByLabel(/Microsoft\/email password/i);
    const rentalItem = findItemByLabel(/National Rental profile/i);
    const usaUserItem = findItemByLabel(/USABalancer username/i);
    const usaPassItem = findItemByLabel(/USABalancer password/i);

    setPageTitle('Reports');
    setPageSub('Cohort summaries plus a Status / Missing one-pager (all roles) for any hire or the whole cohort — print or save as PDF from the browser.');

    const cohortOpts = [
      ...dates.map((d) => `<option value="${esc(d)}" ${d === reportCohort ? 'selected' : ''}>${esc(d)}</option>`),
      `<option value="__none__" ${reportCohort === '__none__' ? 'selected' : ''}>No orientation date</option>`
    ].join('');

    if (reportMissingHireId !== '__all__' && !cohortHires.some((h) => h.id === reportMissingHireId)) {
      reportMissingHireId = '__all__';
    }
    const missingHires = reportMissingHireId === '__all__'
      ? cohortHires
      : cohortHires.filter((h) => h.id === reportMissingHireId);
    const hireOpts = [
      `<option value="__all__" ${reportMissingHireId === '__all__' ? 'selected' : ''}>All in cohort (${cohortHires.length})</option>`,
      ...cohortHires.map((h) => `<option value="${esc(h.id)}" ${reportMissingHireId === h.id ? 'selected' : ''}>${esc(h.name)}</option>`)
    ].join('');

    let body = '';
    if (reportKind === 'missing') {
      body = `
        <div class="nh-missing-toolbar nh-no-print">
          <label class="nh-report-cohort">
            <span class="nh-filter-label">Hire</span>
            <select id="nh-report-missing-hire" class="form-input nh-role-select">
              ${hireOpts || '<option value="__all__">No hires</option>'}
            </select>
          </label>
          <button type="button" class="btn-secondary" id="nh-missing-print">Print / save PDF</button>
          <span class="nh-muted">General view — incomplete tasks across <strong>all roles</strong>, not only yours.</span>
        </div>
        <div class="nh-missing-print" id="nh-missing-print-root">
          <div class="nh-missing-doc-title">
            <strong>Status / Missing</strong>
            <span class="nh-muted"> · Orientation ${esc(cohort || 'none')} · Generated ${esc(todayIso())}</span>
          </div>
          ${missingDocHtml(missingHires)}
        </div>`;
    } else if (reportKind === 'cohorts') {
      body = `
        <div class="nh-table-wrap nh-report-table">
          <table class="nh-table" data-sort-key="nh-report-cohorts">
            <thead>
              <tr>
                <th>Name</th><th>Region</th><th>City / hometown</th><th>Bootcamp</th><th>Overall</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${cohortHires.length ? cohortHires.map((h) => {
                const pr = hireProgress(h, 'all', 'all');
                const miss = missingSectionsForHire(h);
                return `<tr>
                  <td><button type="button" class="nh-linkish" data-open-hire="${esc(h.id)}">${esc(h.name)}</button></td>
                  <td>${esc(h.division || '—')}</td>
                  <td>${esc(h.cityCenter || '—')}</td>
                  <td>${esc(h.bootcampDate || '—')}</td>
                  <td><span class="nh-pct ${pctClass(pr.pct)}">${pr.done}/${pr.total}</span>
                    <span class="nh-muted" style="margin-left:6px">${miss.openCount} open</span></td>
                  <td class="nh-report-row-actions">
                    <button class="btn-xs" type="button" data-missing-for="${esc(h.id)}">Status / Missing</button>
                    <button class="btn-xs primary" type="button" data-open-hire="${esc(h.id)}">Open</button>
                  </td>
                </tr>`;
              }).join('') : '<tr><td colspan="6" class="nh-empty">No active hires in this cohort</td></tr>'}
            </tbody>
          </table>
        </div>`;
    } else if (reportKind === 'onboard') {
      body = `
        <div class="nh-table-wrap nh-report-table">
          <table class="nh-table" data-sort-key="nh-report-onboard">
            <thead>
              <tr>
                <th>Technician</th><th>Region</th><th>HR Onboarding</th><th>UPS / Kit tracking</th>
                <th>iPad received</th><th>OSHA</th><th>Diploma / GED</th><th>Meeting invite</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${cohortHires.length ? cohortHires.map((h) => {
                const invite = meetingInviteValue(h) || '—';
                return `<tr>
                  <td><button type="button" class="nh-linkish" data-open-hire="${esc(h.id)}">${esc(h.name)}</button></td>
                  <td>${esc(h.division || '—')}</td>
                  <td>${esc(hrItem && isFilled(hrItem, h.values?.[hrItem.id], h) ? 'Complete' : 'Pending')}</td>
                  <td>${esc(displayProgressValue(h, upsItem))}</td>
                  <td>${esc(displayProgressValue(h, ipadItem))}</td>
                  <td>${esc(statusReceivedLabel(h, oshaItem))}</td>
                  <td>${esc(statusReceivedLabel(h, diplomaItem))}</td>
                  <td>
                    <select class="form-input nh-report-select" data-meeting-invite="${esc(h.id)}">
                      <option value="" ${invite === '—' || !meetingInviteValue(h) ? 'selected' : ''}>—</option>
                      <option value="Yes" ${invite === 'Yes' ? 'selected' : ''}>Yes</option>
                      <option value="No" ${invite === 'No' ? 'selected' : ''}>No</option>
                    </select>
                  </td>
                  <td class="nh-report-row-actions">
                    <button class="btn-xs" type="button" data-missing-for="${esc(h.id)}">Status / Missing</button>
                    <button class="btn-xs primary" type="button" data-open-hire="${esc(h.id)}">Open</button>
                  </td>
                </tr>`;
              }).join('') : '<tr><td colspan="9" class="nh-empty">No active hires in this cohort</td></tr>'}
            </tbody>
          </table>
        </div>
        <p class="nh-footnote">Edit checklist fields on the hire. Meeting invite is saved here for the Onboard Status report.</p>`;
    } else {
      body = `
        <div class="nh-toolbar nh-toolbar-plain" style="margin-bottom:10px">
          <label class="nh-check-label"><input type="checkbox" id="nh-report-sensitive" ${revealSensitive ? 'checked' : ''}> Show passwords</label>
          <span class="nh-muted">Sensitive IT fields stay hidden until you check this.</span>
        </div>
        <div class="nh-table-wrap nh-report-table">
          <table class="nh-table" data-sort-key="nh-report-it">
            <thead>
              <tr>
                <th>#</th><th>Technician</th><th>Region</th><th>Airadigm email</th>
                <th>MS / email password</th><th>National Rental</th><th>USABalancer user</th><th>USABalancer password</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${cohortHires.length ? cohortHires.map((h) => `<tr>
                <td class="nh-muted">${esc(h.employeeNumber ?? '—')}</td>
                <td><button type="button" class="nh-linkish" data-open-hire="${esc(h.id)}">${esc(h.name)}</button></td>
                <td>${esc(h.division || '—')}</td>
                <td>${esc(displayProgressValue(h, emailItem, { sensitiveMask: false }))}</td>
                <td>${esc(displayProgressValue(h, msPassItem))}</td>
                <td>${esc(displayProgressValue(h, rentalItem))}</td>
                <td>${esc(displayProgressValue(h, usaUserItem))}</td>
                <td>${esc(displayProgressValue(h, usaPassItem))}</td>
                <td class="nh-report-row-actions">
                  <button class="btn-xs" type="button" data-missing-for="${esc(h.id)}">Status / Missing</button>
                  <button class="btn-xs primary" type="button" data-open-hire="${esc(h.id)}">Open</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="9" class="nh-empty">No active hires in this cohort</td></tr>'}
            </tbody>
          </table>
        </div>`;
    }

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-report-chrome nh-no-print">
        <div class="nh-report-tabs">
          <button type="button" class="wt-filter-btn ${reportKind === 'cohorts' ? 'active' : ''}" data-report="cohorts">Orientation cohorts</button>
          <button type="button" class="wt-filter-btn ${reportKind === 'onboard' ? 'active' : ''}" data-report="onboard">Onboard status</button>
          <button type="button" class="wt-filter-btn ${reportKind === 'it' ? 'active' : ''}" data-report="it">IT summary</button>
          <button type="button" class="wt-filter-btn ${reportKind === 'missing' ? 'active' : ''}" data-report="missing">Status / Missing</button>
        </div>
        <label class="nh-report-cohort">
          <span class="nh-filter-label">Orientation date</span>
          <select id="nh-report-cohort" class="form-input nh-role-select">
            ${cohortOpts || '<option value="">No cohorts yet</option>'}
          </select>
        </label>
        <span class="nh-muted">${cohortHires.length} hire${cohortHires.length === 1 ? '' : 's'}</span>
      </div>
      ${body}`;

    bindRoleBar(root);
    root.querySelectorAll('[data-report]').forEach((btn) => {
      btn.addEventListener('click', () => {
        reportKind = btn.getAttribute('data-report') || 'cohorts';
        render();
      });
    });
    root.querySelector('#nh-report-cohort')?.addEventListener('change', (e) => {
      reportCohort = e.target.value;
      render();
    });
    root.querySelector('#nh-report-missing-hire')?.addEventListener('change', (e) => {
      reportMissingHireId = e.target.value || '__all__';
      render();
    });
    root.querySelector('#nh-missing-print')?.addEventListener('click', () => {
      document.body.classList.add('nh-printing-missing');
      window.print();
      setTimeout(() => document.body.classList.remove('nh-printing-missing'), 300);
    });
    root.querySelector('#nh-report-sensitive')?.addEventListener('change', (e) => {
      revealSensitive = !!e.target.checked;
      render();
    });
    root.querySelectorAll('[data-meeting-invite]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const hireId = sel.getAttribute('data-meeting-invite');
        const p = progressOf(hireId);
        const v = sel.value.trim();
        if (v) p.values._onboard_meeting_invite = v;
        else delete p.values._onboard_meeting_invite;
        persist();
      });
    });
    root.querySelectorAll('[data-missing-for]').forEach((btn) => {
      btn.addEventListener('click', () => {
        reportMissingHireId = btn.getAttribute('data-missing-for') || '__all__';
        reportKind = 'missing';
        render();
      });
    });
    root.querySelectorAll('[data-open-hire]').forEach((btn) => {
      btn.addEventListener('click', () => openHireDetail(btn.getAttribute('data-open-hire')));
    });
    if (window.HubShell && HubShell.enhanceTables) HubShell.enhanceTables(root);
  }

  function render() {
    ensureData();
    const root = document.getElementById('nh-checklist-root');
    if (!root) return;

    if (loading) {
      root.innerHTML = '<p class="nh-status">Loading employees…</p>';
      syncChecklistNav();
      syncHeaderActions();
      return;
    }
    if (loadError) {
      root.innerHTML = `<p class="nh-status nh-error">Failed to load employees: ${esc(loadError)}. Run the New Hire Checklist section of supabase-schema.sql if you have not yet.</p>`;
      syncChecklistNav();
      syncHeaderActions();
      return;
    }

    if (view === 'detail' && selectedHireId) renderDetail(root);
    else if (view === 'template') renderTemplate(root);
    else if (view === 'roster') renderRoster(root);
    else if (view === 'archive') renderArchive(root);
    else if (view === 'todo') renderTodo(root);
    else if (view === 'reports') renderReports(root);
    else renderDashboard(root);
    syncChecklistNav();
    syncHeaderActions();
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
    // Prefer signed-in user's role + name on first open (e.g. Ana → Admin / Ana)
    applySignedInUserDefaults(!mounted);
    bindBrowserNav();
    bindHeaderAdd();

    // Avoid reloading/re-rendering a huge todo list every time the nav tab is clicked
    if (mounted && !forceReload && !loading) {
      render();
      return;
    }
    mounted = true;
    await loadEmployees();
  }

  function applyViewerDefaults() {
    userDefaultsApplied = false;
    applySignedInUserDefaults(true);
    if (mounted) render();
  }

  window.HubChecklist = {
    mount,
    loadEmployees,
    applyRemote,
    render,
    mountProcessAdmin,
    openItemModal,
    applyViewerDefaults,
    setView,
    getView
  };
})();