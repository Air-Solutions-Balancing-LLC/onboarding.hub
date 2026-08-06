// New Hire Checklist — Brian's employee roster + role-based My To-Do
(function () {
  const STORAGE_KEY = 'new_hire_checklist';
  const ROLE_PREF_KEY = 'nh_role_pref';
  const PERSON_PREF_KEY = 'nh_person_pref';
  // start_date = Orientation date (due-date anchor). work_start_date = Start date (techs for now).
  const SELECT_COLS =
    'id, full_name, preferred_name, employee_number, employee_type, status, status_note, region, city_center, start_date, work_start_date, bootcamp_start_date, company_email, assigned_pm';

  let data = null; // { version, roles, sections, items, progress }
  let employees = [];
  let view = 'dashboard'; // dashboard | todo | roster | archive | detail | template
  const STATUS_OPTIONS = ['active', 'terminated', 'quit', 'rescinded', 'resigned'];
  const ARCHIVE_STATUSES = ['terminated', 'quit', 'rescinded', 'resigned'];
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
  let filters = { q: '', status: 'active', role: 'HR', person: 'all', todoScope: 'week', hireWindow: 'onboarding', archiveStatus: 'all' };
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

  function peopleForRole(roleId) {
    if (roleId === 'all') {
      const all = [];
      (data.roles || []).forEach((r) => {
        (r.people || []).forEach((p) => { if (p && !all.includes(p)) all.push(p); });
      });
      data.items.forEach((i) => {
        if (i.assignee && !all.includes(i.assignee)) all.push(i.assignee);
      });
      return all.filter(Boolean).sort((a, b) => a.localeCompare(b));
    }
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

  function matchesRolePersonFilter(hire, item, roleFilter, personFilter) {
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

  function optionSelect(empId, field, value, options, extraClass) {
    const cur = value || '';
    const vals = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
    const known = vals.some((o) => o.value === cur);
    const opts = known || !cur ? vals : [{ value: cur, label: cur }, ...vals];
    return `<select class="nh-status-select nh-profile-select ${extraClass || ''}" data-emp-field="${esc(field)}" data-emp-id="${esc(empId)}" title="${esc(field)}">
      <option value="">—</option>
      ${opts.map((o) => `<option value="${esc(o.value)}" ${o.value === cur ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>`;
  }

  function positionSelect(empId, type) {
    return optionSelect(empId, 'employee_type', normalizePosition(type), POSITION_OPTIONS);
  }

  function regionSelect(empId, region) {
    // Always show the normalized region so old values like "KES Assistant…" become just KES
    return optionSelect(empId, 'region', normalizeRegion(region) || '', REGION_OPTIONS);
  }

  function cityCenterSelect(empId, city) {
    return `<input class="form-input nh-profile-select nh-city-input" type="text" data-emp-field="city_center" data-emp-id="${esc(empId)}" value="${esc(city || '')}" placeholder="City center" title="City center">`;
  }

  function filteredEmployees() {
    const q = filters.q.trim().toLowerCase();
    return employees.filter((e) => {
      const matchSearch =
        !q ||
        (e.full_name || '').toLowerCase().includes(q) ||
        (e.preferred_name || '').toLowerCase().includes(q) ||
        displayHireName(e).toLowerCase().includes(q) ||
        (e.company_email || '').toLowerCase().includes(q) ||
        String(e.employee_number ?? '').includes(q);
      // Dashboard / Roster: active only (archived hires live in Archive)
      return matchSearch && (e.status || 'active') === 'active';
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
    let selectCols = SELECT_COLS;
    let { data: rows, error } = await supabase
      .from('employees')
      .select(selectCols)
      .order('employee_number', { ascending: false, nullsFirst: false });
    // Older DBs may be missing newer profile columns
    if (error && /(city_center|work_start_date|preferred_name)/i.test(error.message || '')) {
      selectCols = SELECT_COLS
        .replace(', city_center', '')
        .replace(', work_start_date', '')
        .replace(', preferred_name', '');
      ({ data: rows, error } = await supabase
        .from('employees')
        .select(selectCols)
        .order('employee_number', { ascending: false, nullsFirst: false }));
      if (!error && rows) {
        rows = rows.map((r) => Object.assign({ city_center: null, work_start_date: null, preferred_name: null }, r));
      }
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

  function bindProfileSelects(root) {
    root.querySelectorAll('[data-emp-field]').forEach((el) => {
      const commit = async () => {
        const id = el.getAttribute('data-emp-id');
        const field = el.getAttribute('data-emp-field');
        const emp = employees.find((e) => e.id === id);
        if (!emp || !field) return;
        const prev = emp[field];
        let next = (el.value || '').trim() || null;
        if (field === 'employee_type') next = normalizePosition(next || 'technician');
        if (field === 'region') next = normalizeRegion(next) || null;
        if ((prev || null) === next) return;
        emp[field] = next;
        el.classList.add('nh-saving');
        try {
          await syncEmployeePatch(id, { [field]: next });
          if (field === 'region') syncRegionProgress(id, next || '');
        } catch (e) {
          emp[field] = prev;
          el.value = prev || '';
          alert('Could not update ' + field.replace(/_/g, ' ') + ': ' + (e.message || e));
        }
        el.classList.remove('nh-saving');
        if (field !== 'city_center' && (view === 'roster' || view === 'dashboard' || view === 'archive')) render();
      };
      el.addEventListener('change', commit);
      if (el.tagName === 'INPUT') el.addEventListener('blur', commit);
    });
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

  function roleBar() {
    const roles = data.roles || [];
    const people = peopleForRole(filters.role);
    return `
      <div class="nh-rolebar">
        <div class="nh-rolebar-left">
          <label class="nh-check-label">View role
            <select id="nh-role" class="form-input" style="width:140px;margin-left:6px">
              <option value="all" ${filters.role === 'all' ? 'selected' : ''}>All roles</option>
              ${roles.map((r) => `<option value="${esc(r.id)}" ${filters.role === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
            </select>
          </label>
          <label class="nh-check-label">Person
            <select id="nh-person" class="form-input" style="width:150px;margin-left:6px">
              <option value="all">${filters.role === 'all' ? 'Everyone' : 'Everyone in role'}</option>
              ${people.map((p) => `<option value="${esc(p)}" ${filters.person === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="nh-rolebar-right">
          <button class="btn-secondary ${view === 'dashboard' ? 'nh-tab-on' : ''}" type="button" data-view="dashboard">Dashboard</button>
          <button class="btn-secondary ${view === 'todo' ? 'nh-tab-on' : ''}" type="button" data-view="todo">My To-Do</button>
          <button class="btn-secondary ${view === 'roster' ? 'nh-tab-on' : ''}" type="button" data-view="roster">Roster</button>
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
      // Process editing lives in Admin for the whole team
      if (window.HubAuth && HubAuth.canAccessAdmin && HubAuth.canAccessAdmin()) {
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
    setPageSub('Use the role buttons to view any team’s to-do list. Person filter narrows to one assignee. Due dates use Orientation / Bootcamp dates.');
    const entries = todoEntries();
    const overdue = entries.filter((e) => e.bucket === 'overdue').length;
    const week = entries.filter((e) => e.bucket === 'week' || e.bucket === 'overdue').length;
    const open = entries.filter((e) => !e.done).length;
    const shown = entries.slice(0, todoLimit);
    const roles = data.roles || [];

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-stats nh-stats-todo">
        <div class="stat"><div class="stat-num red">${overdue}</div><div class="stat-label">Overdue</div></div>
        <div class="stat"><div class="stat-num amber">${week}</div><div class="stat-label">Due in 7 days</div></div>
        <div class="stat"><div class="stat-num">${open}</div><div class="stat-label">Open for ${esc(filterScopeLabel())}</div></div>
        <div class="stat"><div class="stat-num green">${entries.filter((e) => e.done).length}</div><div class="stat-label">Shown complete</div></div>
      </div>
      <div class="nh-toolbar nh-toolbar-plain">
        <div class="nh-toolbar-left nh-role-filters">
          <span class="nh-muted" style="margin-right:4px">Role:</span>
          <button class="wt-filter-btn ${filters.role === 'all' ? 'active' : ''}" type="button" data-todo-role="all">All roles</button>
          ${roles.map((r) =>
            `<button class="wt-filter-btn ${filters.role === r.id ? 'active' : ''}" type="button" data-todo-role="${esc(r.id)}">${esc(r.label)}</button>`
          ).join('')}
        </div>
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
        </div>
        <div class="nh-muted">Showing ${Math.min(shown.length, entries.length)} of ${entries.length} · ${esc(filterScopeLabel())}</div>
      </div>
      <div class="nh-todo-list">
        ${shown.length ? shown.map(todoRow).join('') : '<div class="nh-empty-block">No tasks for this filter. Try Open, another role, or Roster.</div>'}
      </div>
      ${entries.length > todoLimit ? `<div style="margin-top:12px;text-align:center"><button class="btn-secondary" type="button" id="nh-todo-more">Show more (${entries.length - todoLimit} left)</button></div>` : ''}`;

    bindRoleBar(root);
    root.querySelectorAll('[data-todo-role]').forEach((btn) => {
      btn.addEventListener('click', () => {
        filters.role = btn.getAttribute('data-todo-role') || 'all';
        filters.person = 'all';
        localStorage.setItem(ROLE_PREF_KEY, filters.role);
        localStorage.setItem(PERSON_PREF_KEY, 'all');
        todoLimit = 80;
        render();
      });
    });
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
    const linkHtml = taskLinkHtml(e.item);
    return `
      <div class="nh-todo-row ${e.done ? 'done' : ''} ${dueCls}">
        <div class="nh-todo-main">
          <div class="nh-todo-hire">${esc(e.hire.name)} <span class="nh-muted-inline">· ${esc(e.hire.division || '')}</span></div>
          <div class="nh-todo-task">${esc(e.item.label)}${linkHtml ? ' · ' + linkHtml : ''}</div>
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
    bindProfileSelects(root);
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
        selectedHireId = btn.getAttribute('data-open-hire');
        // Always open a hire with all categories collapsed
        openSections = {};
        (data.sections || []).forEach((s) => { openSections[s.id] = false; });
        view = 'detail';
        render();
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
  }

  function renderDashboard(root) {
    setPageSub(`Progress counts use My role / Person filters — currently showing tasks for ${filterScopeLabel()}. Status changes still move hires to Archive.`);
    ensureData();
    const s = stats();
    const rows = filteredEmployees();
    const sections = data.sections || [];

    root.innerHTML = `
      ${roleBar()}
      <div class="nh-stats">
        <div class="nh-stat"><div class="nh-stat-label">Total Employees</div><div class="nh-stat-num">${s.total}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Active</div><div class="nh-stat-num nh-stat-green">${s.active}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Archived</div><div class="nh-stat-num nh-stat-red">${s.inactive}</div></div>
        <div class="nh-stat"><div class="nh-stat-label">Filter</div><div class="nh-stat-num" style="font-size:14px">${esc(filterScopeLabel())}</div></div>
      </div>
      <div class="nh-toolbar">
        <input type="search" class="nh-search" id="nh-search" placeholder="Search by name, email, or #..." value="${esc(filters.q)}" />
        <div class="nh-filters">
          <span class="nh-muted">Showing active hires · archived are under Archive</span>
        </div>
      </div>
      <div class="nh-sheet-wrap">
        <table class="nh-sheet">
          <thead>
            <tr>
              <th class="nh-sticky">#</th>
              <th class="nh-sticky nh-sticky-2">Name</th>
              <th>Position</th>
              <th>Region</th>
              <th>City center</th>
              <th>Orientation</th>
              <th>Start</th>
              <th>Bootcamp</th>
              <th>Status</th>
              <th>Overall</th>
              ${sections.map((sec) => `<th title="${esc(sec.title)}" class="nh-sec-col">${esc(sec.id)}</th>`).join('')}
              <th></th>
            </tr>
            <tr class="nh-sheet-subhead">
              <th class="nh-sticky"></th>
              <th class="nh-sticky nh-sticky-2"></th>
              <th colspan="8" class="nh-muted">Profile</th>
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
                  <button type="button" class="nh-linkish" data-open-hire="${esc(emp.id)}">${esc(displayHireName(emp))}</button>
                </td>
                <td>${positionSelect(emp.id, emp.employee_type)}</td>
                <td>${regionSelect(emp.id, emp.region)}</td>
                <td>${cityCenterSelect(emp.id, emp.city_center)}</td>
                <td>${esc(emp.start_date || '—')}</td>
                <td>${esc(emp.work_start_date || '—')}</td>
                <td>${esc(emp.bootcamp_start_date || '—')}</td>
                <td>${statusSelect(emp.id, emp.status)}</td>
                <td><span class="nh-pct ${pctClass(overall.pct)}" title="${overall.done}/${overall.total} for ${esc(filterScopeLabel())}">${overall.done}/${overall.total}</span></td>
                ${sections.map((sec) => {
                  const sp = sectionProgress(hire, sec.id);
                  return `<td class="nh-sec-cell">
                    <button type="button" class="nh-pct ${pctClass(sp.pct)}" data-open-hire="${esc(emp.id)}" title="${esc(sec.title)} · ${esc(filterScopeLabel())}: ${sp.done}/${sp.total}">${sp.done}/${sp.total}</button>
                  </td>`;
                }).join('')}
                <td><button class="btn-xs primary" type="button" data-open-hire="${esc(emp.id)}">Open</button></td>
              </tr>`;
            }).join('') : `<tr><td colspan="${11 + sections.length}" class="nh-empty">No employees found</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="nh-footnote">${rows.length} active hires · A–J counts are for ${esc(filterScopeLabel())} · choose All roles to see full totals</p>`;

    bindRosterChrome(root);
  }

  function renderRoster(root) {
    setPageSub('Active employee roster — change Status to move someone to Archive. Open a hire for the full checklist.');
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
          <span class="nh-muted">Showing active hires · archived are under Archive</span>
        </div>
      </div>
      <div class="nh-table-wrap">
        <table class="nh-table">
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
                <td>${positionSelect(emp.id, emp.employee_type)}</td>
                <td>${regionSelect(emp.id, emp.region)}</td>
                <td>${cityCenterSelect(emp.id, emp.city_center)}</td>
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
      <p class="nh-footnote">${rows.length} active employees · use Status to archive · click name/progress to open checklist</p>`;

    bindRosterChrome(root);
  }

  function renderArchive(root) {
    setPageSub('Archived hires (Terminated, Quit, Rescinded, Resigned). Set Status back to Active to restore, or Delete permanently.');
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
            `<button type="button" class="nh-filter-btn${filters.archiveStatus === f ? ' active' : ''}" data-archive-filter="${f}">${f === 'all' ? 'all archived' : f}</button>`
          ).join('')}
        </div>
      </div>
      <div class="nh-table-wrap">
        <table class="nh-table">
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
                <td>${positionSelect(emp.id, emp.employee_type)}</td>
                <td>${regionSelect(emp.id, emp.region)}</td>
                <td>${cityCenterSelect(emp.id, emp.city_center)}</td>
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
    setPageSub(archived
      ? 'Archived hire — set Status back to Active on Archive to restore, or Delete from Archive.'
      : `Showing tasks for ${scoped} (${p.done}/${p.total}). Change My role / Person to widen or narrow the list.`);

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
        <button class="btn-secondary" type="button" id="nh-back">${archived ? '← Archive' : '← Dashboard'}</button>
        <div class="nh-detail-actions">
          <label class="nh-check-label"><input type="checkbox" id="nh-reveal" ${revealSensitive ? 'checked' : ''}> Show sensitive</label>
          <select id="nh-role-d" class="form-input" style="width:140px" title="Filter tasks by role">
            <option value="all" ${filters.role === 'all' ? 'selected' : ''}>Role: all</option>
            ${(data.roles || []).map((r) => `<option value="${esc(r.id)}" ${filters.role === r.id ? 'selected' : ''}>Role: ${esc(r.label)}</option>`).join('')}
          </select>
          <button class="btn-secondary" type="button" id="nh-edit-hire">Edit profile</button>
          ${archived ? `<button class="btn-xs danger" type="button" id="nh-del-hire">Delete</button>` : ''}
        </div>
      </div>
      <div class="nh-profile">
        <div>
          <div class="nh-profile-name">${esc(hire.name)}</div>
          <div class="nh-profile-meta nh-profile-selects">
            <label class="nh-check-label">Position ${positionSelect(hire.id, hire.employeeType)}</label>
            <label class="nh-check-label">Region ${regionSelect(hire.id, hire.division)}</label>
            <label class="nh-check-label">City center ${cityCenterSelect(hire.id, hire.cityCenter)}</label>
          </div>
          <div class="nh-profile-meta nh-date-meta">
            <span><strong>Orientation date</strong> ${esc(hire.startDate || 'TBD')}</span>
            <span><strong>Start date</strong> ${esc(hire.workStartDate || 'TBD')}</span>
            <span><strong>Bootcamp date</strong> ${esc(hire.bootcampDate || 'TBD')}</span>
            ${hire.assignedPm ? `<span>· PM ${esc(hire.assignedPm)}</span>` : ''}
          </div>
        </div>
        <div class="nh-profile-right">
          <span class="${statusBadgeClass(hire.status)}">${esc(hire.status || '—')}</span>
          <div class="nh-prog big">
            <div class="nh-prog-bar"><span style="width:${p.pct}%"></span></div>
            <div class="nh-prog-label">${p.done}/${p.total} for ${esc(scoped)} · ${p.pct}%</div>
          </div>
        </div>
      </div>
      ${sectionsHtml || `<div class="nh-empty-block">No tasks assigned to ${esc(scoped)} for this hire.</div>`}`;

    root.querySelector('#nh-back').addEventListener('click', () => {
      view = archived ? 'archive' : 'dashboard';
      selectedHireId = null;
      render();
    });
    root.querySelector('#nh-edit-hire').addEventListener('click', () => openHireModal(hire.id));
    root.querySelector('#nh-del-hire')?.addEventListener('click', async () => {
      if (await deleteEmployee(hire.id)) {
        view = 'archive';
        render();
      }
    });
    bindProfileSelects(root);
    root.querySelector('#nh-role-d').addEventListener('change', (e) => {
      filters.role = e.target.value;
      filters.person = 'all';
      localStorage.setItem(ROLE_PREF_KEY, filters.role);
      localStorage.setItem(PERSON_PREF_KEY, 'all');
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
        progressOf(hire.id).assignees[itemId] = sel.value;
        persist();
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
    const people = [...new Set([...peopleForRole(it.role), who].filter(Boolean))];
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
    } else {
      let display = raw == null ? '' : String(raw);
      if (it.sensitive && !revealSensitive && display) display = '••••••••';
      control = `<input class="form-input nh-field-input" type="text" data-field="${esc(it.id)}" value="${esc(display)}" ${it.sensitive && !revealSensitive && raw ? 'readonly' : ''} placeholder="Enter value…">`;
    }
    return `
      <div class="nh-task-row ${mine ? 'mine' : ''} ${filled ? 'filled' : 'open'} ${overdue ? 'overdue' : ''}${stepProg ? ' has-checklist' : ''}">
        <div class="nh-task-assignee" title="${esc(who || 'Unassigned')} · ${esc(it.role)}">
          <select class="form-input nh-assignee" data-assignee="${esc(it.id)}" title="Assigned person">
            ${people.map((p) => `<option value="${esc(p)}" ${who === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
          </select>
          <span class="nh-role-chip">${esc(it.role)}</span>
        </div>
        <div class="nh-task-label">
          ${stepProg
            ? `<button type="button" class="nh-linkish" data-open-checklist="${esc(it.id)}">${esc(it.label)}</button>`
            : esc(it.label)}
          ${it.sensitive ? ' <span class="nh-lock">sensitive</span>' : ''}
          ${stepProg ? ` <span class="nh-steps-chip">${stepProg.total} steps</span>` : ''}
          ${linkHtml ? ` <span class="nh-task-link-wrap">${linkHtml}</span>` : ''}
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
    const body = {};
    ['region', 'city_center', 'start_date', 'work_start_date', 'bootcamp_start_date', 'assigned_pm', 'full_name', 'preferred_name', 'status', 'status_note', 'employee_type'].forEach((k) => {
      if (patch[k] !== undefined) body[k] = patch[k] || null;
    });
    if (!Object.keys(body).length) return;
    let { error } = await supabase.from('employees').update(body).eq('id', id);
    if (error && /(city_center|work_start_date|preferred_name)/i.test(error.message || '')) {
      if (/city_center/i.test(error.message || '')) delete body.city_center;
      if (/work_start_date/i.test(error.message || '')) delete body.work_start_date;
      if (/preferred_name/i.test(error.message || '')) delete body.preferred_name;
      if (!Object.keys(body).length) {
        throw new Error('Run the employees column ALTERs in supabase-schema.sql, then try again.');
      }
      ({ error } = await supabase.from('employees').update(body).eq('id', id));
    }
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
                ? 'Due date = selected date minus “days before”. Default is 0 days before Orientation. Set dependency if a task must wait on another.'
                : 'Assignee, role, field type, and due date from Orientation / Start / Bootcamp'}</span>
            </div>
            <div class="nh-template-list">
              ${items.length ? items.map((it) => {
                const depOn = !!(it.dependsOnPrior || it.dependsOnTaskId);
                const depLabel = it.dependsOnTaskId ? taskLabelById(it.dependsOnTaskId) : '';
                const daysBefore = daysBeforeOf(it);
                return `
                <div class="nh-template-row${depOn ? ' nh-has-dependency' : ''}">
                  <div>
                    <div class="nh-field-label" style="font-size:13px;font-weight:600;color:#1e293b">${esc(it.label)}</div>
                    <div class="nh-todo-meta">
                      <span class="nh-person-role"><span class="nh-owner-chip">${esc(it.assignee)}</span><span class="nh-role-chip">${esc(it.role)}</span></span>
                      <span class="nh-type">${esc(it.inputType)}</span>
                      <span class="nh-due">${esc(dueRuleLabel(it))}</span>
                      ${normalizeSteps(it).length ? `<span class="nh-steps-chip">${normalizeSteps(it).length}-step check-off</span>` : ''}
                      ${taskLinkHtml(it) || ''}
                      ${depOn && adminMode ? `<span class="nh-dep-badge">${depLabel ? 'Depends on: ' + esc(depLabel) : 'Pick prerequisite…'}</span>` : ''}
                    </div>
                    ${adminMode ? `
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
    root.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:12px">
        <p class="user-mgmt-subtitle" style="margin:0">${total} tasks across ${(data.sections || []).length} categories. Due date = chosen date minus days before (default: 0 days before Orientation).</p>
        <button type="button" class="btn-secondary" id="nh-reset-dues">Reset all dues → 0 days before Orientation</button>
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
            <div class="form-row-2">
              <div><label class="form-label">Orientation date *</label><input id="nh-hire-start" class="form-input" type="date"></div>
              <div><label class="form-label">Start date</label><input id="nh-hire-work-start" class="form-input" type="date" title="For technicians for now; office start rules later"></div>
            </div>
            <div class="form-row">
              <label class="form-label">Bootcamp date</label>
              <input id="nh-hire-boot" class="form-input" type="date">
            </div>
            <div class="form-row-2">
              <div><label class="form-label">Status</label>
                <select id="nh-hire-status" class="form-input">
                  <option value="active">active</option>
                  <option value="terminated">terminated</option>
                  <option value="quit">quit</option>
                  <option value="rescinded">rescinded</option>
                  <option value="resigned">resigned</option>
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
    document.getElementById('nh-hire-role').value = normalizePosition(emp?.employee_type);
    document.getElementById('nh-hire-city').value = emp?.city_center || '';
    document.getElementById('nh-hire-start').value = (emp?.start_date || '').slice(0, 10);
    document.getElementById('nh-hire-work-start').value = (emp?.work_start_date || '').slice(0, 10);
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
    let full_name = document.getElementById('nh-hire-name').value.trim();
    let preferred_name = document.getElementById('nh-hire-goes-by').value.trim() || null;
    // If full name still contains legacy "(Goes by …)", split it cleanly
    const embedded = parseGoesByFromFullName(full_name);
    if (embedded.preferred_name) {
      full_name = embedded.full_name;
      if (!preferred_name) preferred_name = embedded.preferred_name;
    }
    const region = normalizeRegion(document.getElementById('nh-hire-division').value.trim());
    const employee_type = normalizePosition(document.getElementById('nh-hire-role').value);
    const city_center = document.getElementById('nh-hire-city').value.trim() || null;
    const start_date = document.getElementById('nh-hire-start').value || null; // Orientation date
    const work_start_date = document.getElementById('nh-hire-work-start').value || null;
    const bootcamp_start_date = document.getElementById('nh-hire-boot').value || null;
    const status = document.getElementById('nh-hire-status').value;
    const status_note = document.getElementById('nh-hire-note').value.trim() || null;
    if (!full_name || !region || !start_date) {
      alert('Name, region, and Orientation date are required (task due dates use Orientation date).');
      return;
    }
    const supabase = client();
    const payload = { full_name, preferred_name, region, employee_type, city_center, start_date, work_start_date, bootcamp_start_date, status, status_note };
    function stripMissingCols(errMsg, obj) {
      const next = Object.assign({}, obj);
      if (/city_center/i.test(errMsg || '')) delete next.city_center;
      if (/work_start_date/i.test(errMsg || '')) delete next.work_start_date;
      if (/preferred_name/i.test(errMsg || '')) delete next.preferred_name;
      return next;
    }
    async function writeEmp(kind) {
      if (kind === 'update') {
        let { error } = await supabase.from('employees').update(payload).eq('id', id);
        if (error && /(city_center|work_start_date|preferred_name)/i.test(error.message || '')) {
          ({ error } = await supabase.from('employees').update(stripMissingCols(error.message, payload)).eq('id', id));
        }
        return error;
      }
      let { data: created, error } = await supabase.from('employees').insert(payload).select(SELECT_COLS).single();
      if (error && /(city_center|work_start_date|preferred_name)/i.test(error.message || '')) {
        const rest = stripMissingCols(error.message, payload);
        const cols = SELECT_COLS
          .replace(', city_center', '')
          .replace(', work_start_date', '')
          .replace(', preferred_name', '');
        ({ data: created, error } = await supabase.from('employees').insert(rest).select(cols).single());
        if (created) {
          created.city_center = created.city_center ?? city_center;
          created.work_start_date = created.work_start_date ?? work_start_date;
          created.preferred_name = created.preferred_name ?? preferred_name;
        }
      }
      return { created, error };
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

  function openItemModal(id, defaultSectionId) {
    ensureData();
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
    const it = id ? data.items.find((i) => i.id === id) : null;
    document.getElementById('nh-item-title').textContent = it ? 'Edit task' : 'Add task';
    document.getElementById('nh-item-id').value = it?.id || '';
    document.getElementById('nh-item-section').value = it?.sectionId || defaultSectionId || 'A';
    document.getElementById('nh-item-label').value = it?.label || '';
    document.getElementById('nh-item-role').value = it?.role || 'HR';
    document.getElementById('nh-item-assignee').value = it?.assignee || '';
    document.getElementById('nh-item-type').value = it?.inputType || 'text';
    if (it) normalizeItemDue(it);
    document.getElementById('nh-item-anchor').value = normalizeDueAnchor(it?.dueAnchor || 'orientation');
    document.getElementById('nh-item-days-before').value = it ? daysBeforeOf(it) : 0;
    document.getElementById('nh-item-options').value = (it?.options || []).join(', ');
    document.getElementById('nh-item-link').value = it?.link || '';
    const steps = normalizeSteps(it || {});
    renderItemStepsEditor(steps.length ? steps : []);
    // preserve step ids in DOM
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
    const assignee = document.getElementById('nh-item-assignee').value.trim();
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
    else if (view === 'archive') renderArchive(root);
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
