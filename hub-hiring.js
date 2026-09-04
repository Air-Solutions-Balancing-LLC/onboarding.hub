// Shared hiring needs — one listing per role + location, with qty.
(function () {
  const STORAGE_KEY = 'hiring_strategy';
  const FALLBACK_DEPARTMENTS = [
    'Admin',
    'Project Manager',
    'Finance',
    'General Office',
    'Social Media Specialist',
    'Logistics',
    'Bid Coordinator',
    'Estimator',
    'Project Engineer',
    'Technician'
  ];
  const DIVISIONS = [
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
  const DIVISION_DEPARTMENTS = [
    'Project Manager',
    'Technician',
    'Project Engineer',
    'Estimator',
    'Bid Coordinator',
    'Logistics'
  ];
  const POSITIONS = [
    { value: 'technician', label: 'TAB Technician' },
    { value: 'kes_installer', label: 'KES Installer' },
    { value: 'office_staff', label: 'Office Staff' }
  ];

  function atlasDepartments() {
    const labels = window.HubAccess && HubAccess.ATLAS_ROLE_LABELS;
    if (!labels || typeof labels !== 'object') return FALLBACK_DEPARTMENTS.slice();
    const fromAtlas = Object.keys(labels).map((key) => labels[key]).filter(Boolean);
    return fromAtlas.length ? fromAtlas : FALLBACK_DEPARTMENTS.slice();
  }

  function needsDivision(department) {
    return DIVISION_DEPARTMENTS.includes(department);
  }

  function defaultDepartment(position) {
    return position === 'office_staff' ? 'General Office' : 'Technician';
  }

  function splitOrg(raw) {
    const depts = atlasDepartments();
    const storedDept = String((raw && raw.department) || '').trim();
    const storedDiv = String((raw && raw.division) || '').trim();
    let department = storedDept;
    let division = storedDiv;
    if (!department && depts.includes(storedDiv)) {
      department = storedDiv;
      division = '';
    }
    if (!department) department = defaultDepartment(raw && raw.position);
    if (depts.includes(division) && !DIVISIONS.includes(division)) {
      if (!storedDept) department = division;
      division = '';
    }
    if (!needsDivision(department)) division = '';
    else if (division && depts.includes(division) && !DIVISIONS.includes(division)) division = '';
    return { department, division };
  }

  function listingKey(o) {
    return [
      o.position || '',
      o.department || '',
      o.division || '',
      String(o.area || '').trim().toLowerCase()
    ].join('\u0000');
  }

  function normalizeUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    return 'https://' + s;
  }

  let data = emptyData();
  let saveTimer = null;
  let draft = emptyDraft();

  function emptyData() {
    return { version: 4, openings: [] };
  }

  function emptyDraft() {
    return {
      count: 1,
      position: 'technician',
      department: 'Technician',
      division: 'New England',
      area: '',
      postingUrl: '',
      notes: ''
    };
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function positionLabel(value) {
    const hit = POSITIONS.find((p) => p.value === value);
    return hit ? hit.label : 'TAB Technician';
  }

  function listingFrom(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const pos = POSITIONS.some((p) => p.value === raw.position) ? raw.position : 'technician';
    const org = splitOrg(raw);
    const qty = Math.max(1, parseInt(raw.qty != null ? raw.qty : raw.count, 10) || 1);
    return {
      id: String(raw.id || uid('ho')),
      qty,
      position: pos,
      department: org.department,
      division: org.division,
      area: needsDivision(org.department) ? String(raw.area || '').trim() : '',
      postingUrl: String(raw.postingUrl || '').trim(),
      notes: String(raw.notes || '')
    };
  }

  function collapse(openings) {
    const order = [];
    const index = new Map();
    openings.forEach((o) => {
      const key = listingKey(o);
      const existing = index.get(key);
      if (!existing) {
        index.set(key, o);
        order.push(o);
        return;
      }
      existing.qty += o.qty;
      if (!existing.notes && o.notes) existing.notes = o.notes;
      if (!existing.postingUrl && o.postingUrl) existing.postingUrl = o.postingUrl;
    });
    return order;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return { data: emptyData(), changed: false };
    const incoming = (Array.isArray(raw.openings) ? raw.openings : []).map(listingFrom).filter(Boolean);
    const openings = collapse(incoming);
    const changed = openings.length !== incoming.length || !raw.version || raw.version < 4;
    return { data: { version: 4, openings }, changed };
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.HubAuth && HubAuth.save) {
        HubAuth.save(STORAGE_KEY, {
          version: 4,
          openings: data.openings
        });
      }
    }, 250);
  }

  function totals() {
    const byPos = { technician: 0, kes_installer: 0, office_staff: 0 };
    const departments = new Set();
    let total = 0;
    data.openings.forEach((o) => {
      const n = Number(o.qty) || 0;
      total += n;
      if (byPos[o.position] != null) byPos[o.position] += n;
      if (o.department) departments.add(o.department);
    });
    return { total, byPos, departments: departments.size, listings: data.openings.length };
  }

  function sortedOpenings() {
    const deptOrder = atlasDepartments();
    const divOrder = DIVISIONS;
    return data.openings.slice().sort((a, b) => {
      const ad = deptOrder.indexOf(a.department);
      const bd = deptOrder.indexOf(b.department);
      const as = ad === -1 ? deptOrder.length : ad;
      const bs = bd === -1 ? deptOrder.length : bd;
      if (as !== bs) return as - bs;
      const av = divOrder.indexOf(a.division);
      const bv = divOrder.indexOf(b.division);
      if (av !== bv) return (av === -1 ? divOrder.length : av) - (bv === -1 ? divOrder.length : bv);
      return String(a.area || '').localeCompare(String(b.area || ''));
    });
  }

  function positionOptions(selected) {
    return POSITIONS.map((p) =>
      `<option value="${esc(p.value)}"${p.value === selected ? ' selected' : ''}>${esc(p.label)}</option>`
    ).join('');
  }

  function optionList(names, selected) {
    return names.map((d) =>
      `<option value="${esc(d)}"${d === selected ? ' selected' : ''}>${esc(d)}</option>`
    ).join('');
  }

  function departmentOptions(selected) {
    const departments = atlasDepartments();
    const extras = selected && !departments.includes(selected)
      ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>`
      : '';
    return extras + optionList(departments, selected);
  }

  function divisionOptions(selected) {
    const extras = selected && !DIVISIONS.includes(selected)
      ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>`
      : '';
    return extras + optionList(DIVISIONS, selected);
  }

  function listingRow(o) {
    const href = o.postingUrl ? normalizeUrl(o.postingUrl) : '';
    return `
      <tr class="hs-row" data-opening-id="${esc(o.id)}">
        <td>
          <input class="form-input hs-qty" type="number" min="1" max="99" step="1" data-field="qty" value="${esc(o.qty)}" aria-label="Quantity">
        </td>
        <td>${esc(positionLabel(o.position))}</td>
        <td>${esc(o.department || '—')}</td>
        <td>${esc(o.division || '—')}</td>
        <td>${esc(o.area || '—')}</td>
        <td class="hs-posting-cell">
          <input class="form-input" type="url" data-field="postingUrl" value="${esc(o.postingUrl)}" placeholder="https://" aria-label="Job posting link">
          ${href ? `<a class="hs-posting-link" href="${esc(href)}" target="_blank" rel="noopener">Open</a>` : ''}
        </td>
        <td>
          <input class="form-input" type="text" data-field="notes" value="${esc(o.notes)}" placeholder="Notes" aria-label="Hiring notes">
        </td>
        <td class="hs-row-actions">
          <button type="button" class="hs-remove" data-action="remove">Remove</button>
        </td>
      </tr>`;
  }

  function renderStats() {
    const root = document.getElementById('hiring-root');
    if (!root) return;
    const t = totals();
    const set = (sel, n) => {
      const el = root.querySelector(sel);
      if (el) el.textContent = String(n);
    };
    set('[data-hs-stat="total"]', t.total);
    set('[data-hs-stat="technician"]', t.byPos.technician);
    set('[data-hs-stat="kes_installer"]', t.byPos.kes_installer);
    set('[data-hs-stat="office_staff"]', t.byPos.office_staff);
    set('[data-hs-stat="listings"]', t.listings);
  }

  function syncDraftOrg() {
    if (!needsDivision(draft.department)) {
      draft.division = '';
      draft.area = '';
      return;
    }
    if (!draft.division) draft.division = 'New England';
  }

  function render() {
    const root = document.getElementById('hiring-root');
    if (!root) return;
    const geo = needsDivision(draft.department);
    const rows = sortedOpenings();
    const body = !rows.length
      ? `<div class="hs-empty">No open positions yet. Add a qty, role, and location above.</div>`
      : `<div class="hs-table-wrap">
          <table class="hs-table">
            <thead>
              <tr>
                <th class="hs-qty-col">Qty</th>
                <th>Who</th>
                <th>Department</th>
                <th>Division</th>
                <th>Area</th>
                <th>Job posting</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(listingRow).join('')}
            </tbody>
          </table>
        </div>`;

    root.innerHTML = `
      <div class="hs-wrap">
        <div class="hs-stats">
          <div class="hs-stat">
            <div class="hs-stat-label">People needed</div>
            <div class="hs-stat-num" data-hs-stat="total">0</div>
          </div>
          <div class="hs-stat">
            <div class="hs-stat-label">TAB Technicians</div>
            <div class="hs-stat-num" data-hs-stat="technician">0</div>
          </div>
          <div class="hs-stat">
            <div class="hs-stat-label">KES Installers</div>
            <div class="hs-stat-num" data-hs-stat="kes_installer">0</div>
          </div>
          <div class="hs-stat">
            <div class="hs-stat-label">Office Staff</div>
            <div class="hs-stat-num" data-hs-stat="office_staff">0</div>
          </div>
          <div class="hs-stat">
            <div class="hs-stat-label">Listings</div>
            <div class="hs-stat-num" data-hs-stat="listings">0</div>
          </div>
        </div>
        <section class="hs-composer" aria-label="Add a hiring need">
          <div class="hs-composer-kicker">Add a position</div>
          <p class="hs-lede">Same role and area stays one listing with a qty. A different area — North of Boston vs Worcester — is a new listing. Division only shows for regional departments.</p>
          <div class="hs-grid ${geo ? 'is-geo' : 'is-hq'}">
            <label class="hs-field">
              <span class="form-label">Qty</span>
              <input class="form-input" type="number" min="1" max="50" step="1" data-draft="count" value="${esc(draft.count)}" aria-label="How many to hire">
            </label>
            <label class="hs-field">
              <span class="form-label">Who</span>
              <select class="form-input" data-draft="position" aria-label="Position">${positionOptions(draft.position)}</select>
            </label>
            <label class="hs-field">
              <span class="form-label">Department</span>
              <select class="form-input" data-draft="department" aria-label="Department">${departmentOptions(draft.department)}</select>
            </label>
            <label class="hs-field hs-field-geo">
              <span class="form-label">Division</span>
              <select class="form-input" data-draft="division" aria-label="Division">${divisionOptions(draft.division)}</select>
            </label>
            <label class="hs-field hs-field-geo">
              <span class="form-label">Area</span>
              <input class="form-input" type="text" data-draft="area" value="${esc(draft.area)}" placeholder="e.g. North of Boston, DFW" aria-label="Area">
            </label>
          </div>
          <label class="hs-notes">
            <span class="form-label">Job posting link</span>
            <input class="form-input" type="url" data-draft="postingUrl" value="${esc(draft.postingUrl)}" placeholder="https://indeed.com/…">
          </label>
          <label class="hs-notes">
            <span class="form-label">Hiring notes</span>
            <textarea class="form-input" data-draft="notes" rows="3" placeholder="Priorities, start window, recruiter notes…">${esc(draft.notes)}</textarea>
          </label>
          <div class="hs-composer-actions">
            <button type="button" class="btn-primary" data-action="create">Add position</button>
          </div>
        </section>
        <div class="hs-list-head">Open positions</div>
        <div class="hs-list">${body}</div>
      </div>`;
    renderStats();
  }

  function readDraft() {
    const root = document.getElementById('hiring-root');
    if (!root) return draft;
    const val = (name) => {
      const el = root.querySelector(`[data-draft="${name}"]`);
      return el ? el.value : draft[name];
    };
    draft.count = val('count');
    draft.position = val('position');
    draft.department = val('department');
    draft.division = val('division');
    draft.area = val('area');
    draft.postingUrl = val('postingUrl');
    draft.notes = val('notes');
    return draft;
  }

  function findByKey(key) {
    return data.openings.find((o) => listingKey(o) === key) || null;
  }

  function createListing() {
    const d = readDraft();
    const n = Math.max(1, parseInt(d.count, 10) || 1);
    if (n > 50) {
      alert('Add 50 or fewer at a time.');
      return;
    }
    const position = POSITIONS.some((p) => p.value === d.position) ? d.position : 'technician';
    const org = splitOrg({ department: d.department, division: d.division, position });
    const area = needsDivision(org.department) ? String(d.area || '').trim() : '';
    const notes = String(d.notes || '');
    const postingUrl = String(d.postingUrl || '').trim();
    const next = {
      id: uid('ho'),
      qty: n,
      position,
      department: org.department,
      division: org.division,
      area,
      postingUrl,
      notes
    };
    const existing = findByKey(listingKey(next));
    if (existing) {
      existing.qty += n;
      if (notes) existing.notes = notes;
      if (postingUrl) existing.postingUrl = postingUrl;
    } else {
      data.openings.push(next);
    }
    draft.position = position;
    draft.department = org.department;
    draft.division = org.division;
    draft.area = area;
    draft.postingUrl = postingUrl;
    draft.count = 1;
    persist();
    render();
  }

  function findOpening(id) {
    return data.openings.find((o) => o.id === id) || null;
  }

  function openingLabel(o) {
    if (!o) return '';
    const base = [positionLabel(o.position), o.department, o.division, o.area].filter(Boolean);
    const unique = [];
    base.forEach((part) => {
      if (!unique.includes(part)) unique.push(part);
    });
    const qty = Number(o.qty) || 0;
    return unique.join(' · ') + (qty ? ` · ${qty} open` : '');
  }

  function listOpenings() {
    return data.openings.map((o) => ({
      id: o.id,
      qty: o.qty,
      position: o.position,
      department: o.department,
      division: o.division,
      area: o.area,
      postingUrl: o.postingUrl,
      notes: o.notes,
      label: openingLabel(o)
    }));
  }

  function fillOpening(id) {
    const o = findOpening(id);
    if (!o) return false;
    o.qty = Math.max(0, (Number(o.qty) || 1) - 1);
    if (o.qty < 1) data.openings = data.openings.filter((x) => x.id !== id);
    persist();
    const page = document.getElementById('page-hiring');
    if (page && page.classList.contains('active')) render();
    return true;
  }

  function removeOpening(id) {
    const o = findOpening(id);
    if (!o) return;
    const label = openingLabel(o) || positionLabel(o.position);
    if (!confirm(`Remove this listing?\n\n${label}`)) return;
    data.openings = data.openings.filter((x) => x.id !== id);
    persist();
    render();
  }

  function patchListing(id, field, value) {
    const o = findOpening(id);
    if (!o) return;
    if (field === 'qty') {
      o.qty = Math.max(1, parseInt(value, 10) || 1);
      persist();
      renderStats();
      return;
    }
    if (field === 'notes') o.notes = String(value || '');
    else if (field === 'postingUrl') o.postingUrl = String(value || '').trim();
    else return;
    persist();
  }

  function bind(root) {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || !root.contains(btn)) return;
      const action = btn.getAttribute('data-action');
      if (action === 'create') {
        createListing();
        return;
      }
      if (action === 'remove') {
        const row = btn.closest('[data-opening-id]');
        if (row) removeOpening(row.getAttribute('data-opening-id'));
      }
    });
    root.addEventListener('input', (e) => {
      if (e.target.getAttribute && e.target.hasAttribute('data-draft')) {
        readDraft();
        return;
      }
      const field = e.target.getAttribute && e.target.getAttribute('data-field');
      if (!field) return;
      const row = e.target.closest('[data-opening-id]');
      if (!row) return;
      patchListing(row.getAttribute('data-opening-id'), field, e.target.value);
    });
    root.addEventListener('change', (e) => {
      if (e.target.getAttribute && e.target.getAttribute('data-field') === 'postingUrl') {
        const row = e.target.closest('[data-opening-id]');
        if (row) render();
        return;
      }
      if (!(e.target.getAttribute && e.target.hasAttribute('data-draft'))) return;
      const field = e.target.getAttribute('data-draft');
      readDraft();
      if (field === 'position') {
        draft.department = defaultDepartment(draft.position);
        syncDraftOrg();
        render();
        return;
      }
      if (field === 'department') {
        syncDraftOrg();
        render();
      }
    });
  }

  function applyRemote(raw) {
    const next = normalize(raw);
    data = next.data;
    if (next.changed) persist();
    const page = document.getElementById('page-hiring');
    if (page && page.classList.contains('active')) render();
  }

  function mount() {
    const root = document.getElementById('hiring-root');
    if (root && !root.dataset.hsBound) {
      bind(root);
      root.dataset.hsBound = '1';
    }
    render();
  }

  window.HubHiring = {
    applyRemote,
    mount,
    listOpenings,
    fillOpening,
    openingLabel
  };
})();
