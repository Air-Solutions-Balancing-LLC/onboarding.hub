// New Hire Checklist — employee list dashboard (ported from airadigm-newhire-app)
(function () {
  const SELECT_COLS =
    'id, full_name, employee_number, employee_type, status, region, start_date, company_email';

  const state = {
    employees: [],
    loading: true,
    search: '',
    filter: 'all',
    bound: false,
    error: null,
  };

  function client() {
    return window.HubAuth && HubAuth.getClient ? HubAuth.getClient() : null;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
    const q = state.search.trim().toLowerCase();
    return state.employees.filter((e) => {
      const matchSearch =
        !q ||
        (e.full_name || '').toLowerCase().includes(q) ||
        (e.company_email || '').toLowerCase().includes(q) ||
        String(e.employee_number ?? '').includes(q);
      const matchFilter = state.filter === 'all' || e.status === state.filter;
      return matchSearch && matchFilter;
    });
  }

  function stats() {
    const active = state.employees.filter((e) => e.status === 'active').length;
    return {
      total: state.employees.length,
      active,
      inactive: state.employees.length - active,
      technicians: state.employees.filter((e) => e.employee_type === 'technician').length,
    };
  }

  async function loadEmployees() {
    const supabase = client();
    const root = document.getElementById('nh-checklist-root');
    if (!supabase || !root) return;

    state.loading = true;
    state.error = null;
    render();

    const { data, error } = await supabase
      .from('employees')
      .select(SELECT_COLS)
      .order('employee_number', { ascending: false, nullsFirst: false });

    if (error) {
      state.loading = false;
      state.error = error.message;
      render();
      return;
    }

    state.employees = data || [];
    state.loading = false;
    render();
  }

  function render() {
    const root = document.getElementById('nh-checklist-root');
    if (!root) return;

    if (state.loading) {
      root.innerHTML = '<p class="nh-status">Loading employees…</p>';
      return;
    }

    if (state.error) {
      root.innerHTML = `<p class="nh-status nh-error">Failed to load employees: ${escapeHtml(
        state.error
      )}. Run the New Hire Checklist section of supabase-schema.sql if you have not yet.</p>`;
      return;
    }

    const s = stats();
    const rows = filteredEmployees();
    const filters = ['all', 'active', 'terminated', 'quit', 'rescinded'];

    root.innerHTML = `
      <div class="nh-stats">
        <div class="nh-stat">
          <div class="nh-stat-label">Total Employees</div>
          <div class="nh-stat-num">${s.total}</div>
        </div>
        <div class="nh-stat">
          <div class="nh-stat-label">Active</div>
          <div class="nh-stat-num nh-stat-green">${s.active}</div>
        </div>
        <div class="nh-stat">
          <div class="nh-stat-label">Inactive</div>
          <div class="nh-stat-num nh-stat-red">${s.inactive}</div>
        </div>
        <div class="nh-stat">
          <div class="nh-stat-label">Technicians</div>
          <div class="nh-stat-num nh-stat-amber">${s.technicians}</div>
        </div>
      </div>

      <div class="nh-toolbar">
        <input
          type="search"
          class="nh-search"
          id="nh-search"
          placeholder="Search by name, email, or #..."
          value="${escapeHtml(state.search)}"
        />
        <div class="nh-filters">
          ${filters
            .map(
              (f) =>
                `<button type="button" class="nh-filter-btn${
                  state.filter === f ? ' active' : ''
                }" data-nh-filter="${f}">${f}</button>`
            )
            .join('')}
        </div>
      </div>

      <div class="nh-table-wrap">
        <table class="nh-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Type</th>
              <th>Region</th>
              <th>Start Date</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map(
                      (emp) => `<tr>
                <td class="nh-muted">${escapeHtml(emp.employee_number ?? '—')}</td>
                <td class="nh-name">${escapeHtml(emp.full_name)}</td>
                <td><span class="${typeBadgeClass(emp.employee_type)}">${escapeHtml(
                        formatType(emp.employee_type)
                      )}</span></td>
                <td>${escapeHtml(emp.region || '—')}</td>
                <td>${escapeHtml(emp.start_date || '—')}</td>
                <td><span class="${statusBadgeClass(emp.status)}">${escapeHtml(
                        emp.status || '—'
                      )}</span></td>
              </tr>`
                    )
                    .join('')
                : `<tr><td colspan="6" class="nh-empty">No employees found</td></tr>`
            }
          </tbody>
        </table>
      </div>
      <p class="nh-footnote">${rows.length} employees shown</p>
    `;
  }

  function bindEvents() {
    if (state.bound) return;
    const root = document.getElementById('nh-checklist-root');
    if (!root) return;
    state.bound = true;

    root.addEventListener('input', (e) => {
      if (e.target.id === 'nh-search') {
        state.search = e.target.value;
        render();
        const input = document.getElementById('nh-search');
        if (input) {
          input.focus();
          const len = input.value.length;
          input.setSelectionRange(len, len);
        }
      }
    });

    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-nh-filter]');
      if (!btn) return;
      state.filter = btn.getAttribute('data-nh-filter');
      render();
    });
  }

  async function mount() {
    bindEvents();
    await loadEmployees();
  }

  window.HubChecklist = { mount, loadEmployees };
})();
