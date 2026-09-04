// Light applicant tracker — people in the hiring pipeline.
(function () {
  const STORAGE_KEY = 'hub_applicants';
  const POSITIONS = [
    { value: 'technician', label: 'TAB Technician' },
    { value: 'kes_installer', label: 'KES Installer' },
    { value: 'office_staff', label: 'Office Staff' }
  ];
  const STATUSES = [
    { id: 'applied', label: 'Applied', group: 'open' },
    { id: 'screening', label: 'Screening', group: 'open' },
    { id: 'interview', label: 'Interview', group: 'open' },
    { id: 'offer', label: 'Offer', group: 'open' },
    { id: 'hired', label: 'Hired', group: 'hired' },
    { id: 'declined', label: 'Declined', group: 'closed' },
    { id: 'withdrawn', label: 'Withdrawn', group: 'closed' }
  ];
  const SOURCES = ['Indeed', 'Referral', 'Career site', 'LinkedIn', 'Other'];
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

  let data = emptyData();
  let saveTimer = null;
  let draft = emptyDraft();
  let filter = 'open';
  let openingFilter = 'all';
  let query = '';

  function emptyData() {
    return { version: 1, applicants: [] };
  }

  function emptyDraft() {
    return {
      name: '',
      email: '',
      phone: '',
      position: 'technician',
      department: 'Technician',
      division: 'New England',
      area: '',
      openingId: '',
      source: 'Indeed',
      isReferral: false,
      referee: '',
      status: 'applied',
      notes: ''
    };
  }

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
    return { department, division };
  }

  function syncDraftOrg() {
    if (!needsDivision(draft.department)) {
      draft.division = '';
      draft.area = '';
      return;
    }
    if (!draft.division) draft.division = 'New England';
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

  function statusMeta(id) {
    return STATUSES.find((s) => s.id === id) || STATUSES[0];
  }

  function today() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function normalizePerson(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const status = STATUSES.some((s) => s.id === raw.status) ? raw.status : 'applied';
    const position = POSITIONS.some((p) => p.value === raw.position) ? raw.position : 'technician';
    const org = splitOrg(Object.assign({}, raw, { position }));
    return {
      id: String(raw.id || uid('ap')),
      name: String(raw.name || '').trim(),
      email: String(raw.email || '').trim(),
      phone: String(raw.phone || '').trim(),
      position,
      department: org.department,
      division: org.division,
      area: needsDivision(org.department) ? String(raw.area || '').trim() : '',
      openingId: String(raw.openingId || ''),
      source: SOURCES.includes(raw.source) ? raw.source : String(raw.source || 'Other'),
      isReferral: !!(raw.isReferral || raw.referee || raw.source === 'Referral'),
      referee: String(raw.referee || '').trim(),
      status,
      notes: String(raw.notes || ''),
      appliedAt: String(raw.appliedAt || today())
    };
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return emptyData();
    const applicants = Array.isArray(raw.applicants)
      ? raw.applicants.map(normalizePerson).filter((p) => p && p.name)
      : [];
    return { version: 1, applicants };
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.HubAuth && HubAuth.save) {
        HubAuth.save(STORAGE_KEY, {
          version: 1,
          applicants: data.applicants
        });
      }
    }, 250);
  }

  function openings() {
    return window.HubHiring && HubHiring.listOpenings ? HubHiring.listOpenings() : [];
  }

  function matchesOpening(p) {
    return openingFilter === 'all' || p.openingId === openingFilter;
  }

  function totals() {
    const counts = { applied: 0, screening: 0, interview: 0, offer: 0, hired: 0, open: 0, closed: 0, all: 0 };
    data.applicants.forEach((p) => {
      if (!matchesOpening(p)) return;
      const meta = statusMeta(p.status);
      counts.all += 1;
      if (counts[p.status] != null) counts[p.status] += 1;
      if (meta.group === 'open') counts.open += 1;
      if (meta.group === 'closed') counts.closed += 1;
    });
    return counts;
  }

  function filtered() {
    const q = query.trim().toLowerCase();
    return data.applicants.filter((p) => {
      if (!matchesOpening(p)) return false;
      const meta = statusMeta(p.status);
      if (filter === 'open' && meta.group !== 'open') return false;
      if (filter === 'closed' && meta.group !== 'closed') return false;
      if (filter !== 'all' && filter !== 'open' && filter !== 'closed' && p.status !== filter) return false;
      if (!q) return true;
      return [p.name, p.email, p.phone, p.department, p.division, p.area, positionLabel(p.position), p.source, p.referee, p.notes]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }

  function optionList(items, selected, getValue, getLabel) {
    return items.map((item) => {
      const value = getValue ? getValue(item) : item;
      const label = getLabel ? getLabel(item) : item;
      return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
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

  function openingOptions(selected) {
    const list = openings();
    const extra = selected && !list.some((o) => o.id === selected)
      ? `<option value="${esc(selected)}" selected>Linked opening (filled)</option>`
      : '';
    return `<option value="">No linked opening</option>`
      + extra
      + list.map((o) =>
        `<option value="${esc(o.id)}"${o.id === selected ? ' selected' : ''}>${esc(o.label)}</option>`
      ).join('');
  }

  function sourceText(p) {
    if (p.isReferral && p.referee) return 'Referral · ' + p.referee;
    if (p.isReferral) return p.source && p.source !== 'Referral' ? p.source + ' · Referral' : 'Referral';
    return p.source || '—';
  }

  function applyOpeningToDraft(openingId) {
    draft.openingId = openingId || '';
    const hit = openings().find((o) => o.id === openingId);
    if (!hit) return;
    draft.position = hit.position || draft.position;
    draft.department = hit.department || defaultDepartment(draft.position);
    draft.division = hit.division || '';
    draft.area = hit.area || '';
    syncDraftOrg();
  }

  function renderStats() {
    const root = document.getElementById('applicants-root');
    if (!root) return;
    const t = totals();
    ['open', 'applied', 'screening', 'interview', 'offer', 'hired'].forEach((key) => {
      const el = root.querySelector('[data-ap-stat="' + key + '"]');
      if (el) el.textContent = String(t[key] || 0);
    });
  }

  function applicantRow(p) {
    const where = [p.department, p.division, p.area].filter(Boolean).join(' · ') || '—';
    return `
      <tr class="ap-row" data-applicant-id="${esc(p.id)}">
        <td>
          <div class="ap-name">${esc(p.name)}</div>
          <div class="ap-meta">${esc(p.email || p.phone || p.appliedAt)}</div>
        </td>
        <td>${esc(positionLabel(p.position))}</td>
        <td>${esc(where)}</td>
        <td>
          <select class="form-input ap-status-select ap-status-${esc(p.status)}" data-field="status" aria-label="Status for ${esc(p.name)}">
            ${optionList(STATUSES, p.status, (s) => s.id, (s) => s.label)}
          </select>
        </td>
        <td>${esc(sourceText(p))}</td>
        <td>
          <input class="form-input" type="text" data-field="notes" value="${esc(p.notes)}" placeholder="Notes" aria-label="Notes for ${esc(p.name)}">
        </td>
        <td class="ap-row-actions">
          <button type="button" class="hs-remove" data-action="remove">Remove</button>
        </td>
      </tr>`;
  }

  function render() {
    const root = document.getElementById('applicants-root');
    if (!root) return;
    const rows = filtered();
    const body = !data.applicants.length
      ? `<div class="hs-empty">No applicants yet. Add someone from Indeed, a referral, or an open position.</div>`
      : !rows.length
        ? `<div class="hs-empty">No applicants match this filter.</div>`
        : `<div class="hs-table-wrap">
            <table class="hs-table">
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Who</th>
                  <th>Where</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Notes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${rows.map(applicantRow).join('')}</tbody>
            </table>
          </div>`;

    const counts = totals();
    const filters = [
      ['open', 'Open'],
      ['applied', 'Applied'],
      ['screening', 'Screening'],
      ['interview', 'Interview'],
      ['offer', 'Offer'],
      ['hired', 'Hired'],
      ['closed', 'Closed'],
      ['all', 'All']
    ].map(([id, label]) =>
      `<button type="button" class="nh-filter-btn${filter === id ? ' active' : ''}" data-filter="${id}">${label} <span class="ap-count">${counts[id] || 0}</span></button>`
    ).join('');
    const openList = openings();
    const openingStillListed = openingFilter === 'all' || openList.some((o) => o.id === openingFilter);
    const openingOpts = `<option value="all"${openingFilter === 'all' ? ' selected' : ''}>All openings</option>`
      + (!openingStillListed
        ? `<option value="${esc(openingFilter)}" selected>Linked opening (filled)</option>`
        : '')
      + openList.map((o) =>
        `<option value="${esc(o.id)}"${openingFilter === o.id ? ' selected' : ''}>${esc(o.label)}</option>`
      ).join('');

    root.innerHTML = `
      <div class="hs-wrap ap-wrap">
        <div class="hs-stats ap-stats">
          <div class="hs-stat">
            <div class="hs-stat-label">Open pipeline</div>
            <div class="hs-stat-num" data-ap-stat="open">0</div>
          </div>
          <div class="hs-stat">
            <div class="hs-stat-label">Applied</div>
            <div class="hs-stat-num" data-ap-stat="applied">0</div>
          </div>
          <div class="hs-stat">
            <div class="hs-stat-label">Screening</div>
            <div class="hs-stat-num" data-ap-stat="screening">0</div>
          </div>
          <div class="hs-stat">
            <div class="hs-stat-label">Interview</div>
            <div class="hs-stat-num" data-ap-stat="interview">0</div>
          </div>
          <div class="hs-stat">
            <div class="hs-stat-label">Offer</div>
            <div class="hs-stat-num" data-ap-stat="offer">0</div>
          </div>
          <div class="hs-stat">
            <div class="hs-stat-label">Hired</div>
            <div class="hs-stat-num" data-ap-stat="hired">0</div>
          </div>
        </div>
        <section class="hs-composer" aria-label="Add applicant">
          <div class="hs-composer-kicker">Add applicant</div>
          <p class="hs-lede">Department is the Atlas team. Division only appears for regional roles like Technician or Project Manager.</p>
          <div class="ap-grid ${needsDivision(draft.department) ? 'is-geo' : 'is-hq'}">
            <label class="hs-field">
              <span class="form-label">Name</span>
              <input class="form-input" type="text" data-draft="name" value="${esc(draft.name)}" placeholder="Full name" aria-label="Applicant name">
            </label>
            <label class="hs-field">
              <span class="form-label">Email</span>
              <input class="form-input" type="email" data-draft="email" value="${esc(draft.email)}" placeholder="name@email.com">
            </label>
            <label class="hs-field">
              <span class="form-label">Phone</span>
              <input class="form-input" type="tel" data-draft="phone" value="${esc(draft.phone)}" placeholder="Cell">
            </label>
            <label class="hs-field">
              <span class="form-label">Source</span>
              <select class="form-input" data-draft="source">${optionList(SOURCES, draft.source)}</select>
            </label>
            <label class="hs-field ap-check-field">
              <span class="form-label">Referral</span>
              <label class="ap-check">
                <input type="checkbox" data-draft="isReferral"${draft.isReferral ? ' checked' : ''}>
                <span>This is a referral</span>
              </label>
            </label>
            ${draft.isReferral ? `
            <label class="hs-field">
              <span class="form-label">Referee</span>
              <input class="form-input" type="text" data-draft="referee" value="${esc(draft.referee)}" placeholder="Who referred them?" aria-label="Referee name">
            </label>` : ''}
            <label class="hs-field ap-span-2">
              <span class="form-label">Open position</span>
              <select class="form-input" data-draft="openingId">${openingOptions(draft.openingId)}</select>
            </label>
            <label class="hs-field">
              <span class="form-label">Who</span>
              <select class="form-input" data-draft="position">${optionList(POSITIONS, draft.position, (p) => p.value, (p) => p.label)}</select>
            </label>
            <label class="hs-field">
              <span class="form-label">Department</span>
              <select class="form-input" data-draft="department">${departmentOptions(draft.department)}</select>
            </label>
            <label class="hs-field hs-field-geo">
              <span class="form-label">Division</span>
              <select class="form-input" data-draft="division">${divisionOptions(draft.division)}</select>
            </label>
            <label class="hs-field hs-field-geo">
              <span class="form-label">Area</span>
              <input class="form-input" type="text" data-draft="area" value="${esc(draft.area)}" placeholder="e.g. North of Boston">
            </label>
            <label class="hs-field">
              <span class="form-label">Status</span>
              <select class="form-input" data-draft="status">${optionList(STATUSES, draft.status, (s) => s.id, (s) => s.label)}</select>
            </label>
          </div>
          <label class="hs-notes">
            <span class="form-label">Notes</span>
            <textarea class="form-input" data-draft="notes" rows="2" placeholder="Screen notes, interview times, offer details…">${esc(draft.notes)}</textarea>
          </label>
          <div class="hs-composer-actions">
            <button type="button" class="btn-primary" data-action="add">Add applicant</button>
          </div>
        </section>
        <div class="ap-toolbar">
          <div class="nh-filters">${filters}</div>
          <div class="ap-toolbar-right">
            <select class="form-input ap-pos-filter" data-opening-filter aria-label="Filter by open position">${openingOpts}</select>
            <input class="nh-search" type="search" data-search value="${esc(query)}" placeholder="Search applicants">
          </div>
        </div>
        <div class="hs-list">${body}</div>
      </div>`;
    renderStats();
  }

  function readDraft() {
    const root = document.getElementById('applicants-root');
    if (!root) return draft;
    const val = (name) => {
      const el = root.querySelector(`[data-draft="${name}"]`);
      return el ? el.value : draft[name];
    };
    draft.name = val('name');
    draft.email = val('email');
    draft.phone = val('phone');
    draft.position = val('position');
    draft.department = val('department');
    draft.division = val('division');
    draft.area = val('area');
    draft.source = val('source');
    draft.status = val('status');
    draft.notes = val('notes');
    draft.openingId = val('openingId');
    const refBox = root.querySelector('[data-draft="isReferral"]');
    draft.isReferral = !!(refBox && refBox.checked);
    draft.referee = draft.isReferral ? val('referee') : '';
    return draft;
  }

  function addApplicant() {
    const d = readDraft();
    const name = String(d.name || '').trim();
    if (!name) {
      alert('Enter the applicant’s name.');
      const el = document.querySelector('#applicants-root [data-draft="name"]');
      if (el) el.focus();
      return;
    }
    data.applicants.unshift(normalizePerson({
      id: uid('ap'),
      name,
      email: d.email,
      phone: d.phone,
      position: d.position,
      department: d.department,
      division: d.division,
      area: d.area,
      openingId: d.openingId,
      source: d.source,
      isReferral: !!d.isReferral,
      referee: d.isReferral ? String(d.referee || '').trim() : '',
      status: d.status,
      notes: d.notes,
      appliedAt: today()
    }));
    const keepOpening = d.openingId;
    const keepWhere = { position: d.position, department: d.department, division: d.division, area: d.area };
    draft = emptyDraft();
    draft.openingId = keepOpening;
    draft.position = keepWhere.position;
    draft.department = keepWhere.department;
    draft.division = keepWhere.division;
    draft.area = keepWhere.area;
    syncDraftOrg();
    persist();
    render();
  }

  function findApplicant(id) {
    return data.applicants.find((p) => p.id === id) || null;
  }

  function hireNote(person) {
    const parts = [];
    if (person.isReferral && person.referee) parts.push('Referred by ' + person.referee);
    else if (person.source) parts.push(person.source);
    if (person.notes) parts.push(person.notes);
    return parts.join(' · ');
  }

  function openOnboardingHire(person) {
    const prefill = {
      name: person.name,
      position: person.position,
      division: person.division,
      area: person.area,
      status_note: hireNote(person)
    };
    const go = () => {
      if (window.HubChecklist && HubChecklist.openHireModal) {
        HubChecklist.openHireModal(null, prefill);
      }
    };
    if (typeof window.showChecklistView === 'function') window.showChecklistView('dashboard');
    else if (typeof window.showPage === 'function') window.showPage('checklist');
    const mounted = window.HubChecklist && HubChecklist.mount && HubChecklist.mount();
    if (mounted && typeof mounted.then === 'function') mounted.then(go);
    else setTimeout(go, 0);
  }

  function maybeHireToOnboarding(person) {
    const stillOpen = !!(person.openingId && openings().some((o) => o.id === person.openingId));
    const msg = stillOpen
      ? `Mark ${person.name} hired, fill the linked opening, and add them to Onboarding?`
      : `Mark ${person.name} hired and add them to Onboarding?`;
    if (!confirm(msg)) return false;
    if (stillOpen && window.HubHiring && HubHiring.fillOpening) {
      HubHiring.fillOpening(person.openingId);
    }
    openOnboardingHire(person);
    return true;
  }

  function patchApplicant(id, field, value) {
    const p = findApplicant(id);
    if (!p) return;
    if (field === 'status') {
      const next = STATUSES.some((s) => s.id === value) ? value : p.status;
      if (next === 'hired') {
        if (!maybeHireToOnboarding(p)) {
          render();
          return;
        }
        p.status = 'hired';
        persist();
        return;
      }
      p.status = next;
    } else if (field === 'notes') {
      p.notes = String(value || '');
    } else {
      return;
    }
    persist();
    if (field === 'status') render();
  }

  function removeApplicant(id) {
    const p = findApplicant(id);
    if (!p) return;
    if (!confirm(`Remove ${p.name} from Applicants?`)) return;
    data.applicants = data.applicants.filter((x) => x.id !== id);
    persist();
    render();
  }

  function bind(root) {
    root.addEventListener('click', (e) => {
      const filterBtn = e.target.closest('[data-filter]');
      if (filterBtn && root.contains(filterBtn)) {
        filter = filterBtn.getAttribute('data-filter') || 'open';
        render();
        return;
      }
      const btn = e.target.closest('[data-action]');
      if (!btn || !root.contains(btn)) return;
      if (btn.getAttribute('data-action') === 'add') addApplicant();
      if (btn.getAttribute('data-action') === 'remove') {
        const row = btn.closest('[data-applicant-id]');
        if (row) removeApplicant(row.getAttribute('data-applicant-id'));
      }
    });
    root.addEventListener('input', (e) => {
      if (e.target.hasAttribute && e.target.hasAttribute('data-search')) {
        query = e.target.value || '';
        const list = root.querySelector('.hs-list');
        if (!list) return;
        render();
        const search = root.querySelector('[data-search]');
        if (search) {
          search.focus();
          const len = search.value.length;
          search.setSelectionRange(len, len);
        }
        return;
      }
      if (e.target.hasAttribute && e.target.hasAttribute('data-draft')) {
        readDraft();
        return;
      }
      const field = e.target.getAttribute && e.target.getAttribute('data-field');
      if (field !== 'notes') return;
      const row = e.target.closest('[data-applicant-id]');
      if (row) patchApplicant(row.getAttribute('data-applicant-id'), 'notes', e.target.value);
    });
    root.addEventListener('change', (e) => {
      if (e.target.hasAttribute && e.target.hasAttribute('data-opening-filter')) {
        openingFilter = e.target.value || 'all';
        render();
        return;
      }
      if (e.target.getAttribute && e.target.getAttribute('data-draft') === 'openingId') {
        applyOpeningToDraft(e.target.value);
        render();
        return;
      }
      if (e.target.hasAttribute && e.target.hasAttribute('data-draft')) {
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
          return;
        }
        if (field === 'isReferral') {
          if (!draft.isReferral) draft.referee = '';
          render();
          return;
        }
        if (field === 'source' && draft.source === 'Referral') {
          draft.isReferral = true;
          render();
          return;
        }
        return;
      }
      const field = e.target.getAttribute && e.target.getAttribute('data-field');
      if (field !== 'status') return;
      const row = e.target.closest('[data-applicant-id]');
      if (row) patchApplicant(row.getAttribute('data-applicant-id'), 'status', e.target.value);
    });
  }

  function applyRemote(raw) {
    data = normalize(raw);
    const page = document.getElementById('page-applicants');
    if (page && page.classList.contains('active')) render();
  }

  function mount() {
    const root = document.getElementById('applicants-root');
    if (root && !root.dataset.apBound) {
      bind(root);
      root.dataset.apBound = '1';
    }
    render();
  }

  window.HubApplicants = {
    applyRemote,
    mount
  };
})();
