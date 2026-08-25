// Atlas-style User Management for Onboarding Hub
(function () {
  const APP_USER_REGIONS = [
    'Intermountain',
    'International',
    'KES',
    'Mid Atlantic',
    'Midwest',
    'National',
    'New England',
    'Pacific Coast',
    'Rocky Mountain',
    'Southeast',
    'Southwest',
  ];

  const APP_USER_ROLES = [
    { value: 'admin', label: 'Admin' },
    { value: 'technician', label: 'Technician' },
    { value: 'accounting', label: 'Accounting' },
    { value: 'hr', label: 'HR' },
    { value: 'logistics', label: 'Logistics' },
    { value: 'training', label: 'Training' },
  ];

  const SECTIONS = [
    { role: 'admin', title: 'Admins' },
    { role: 'technician', title: 'Technicians' },
    { role: 'accounting', title: 'Accounting' },
    { role: 'hr', title: 'HR' },
    { role: 'logistics', title: 'Logistics' },
    { role: 'training', title: 'Training' },
  ];

  function emptyDraft(role = 'technician') {
    return { full_name: '', email: '', role: role || 'technician', region: '' };
  }

  const state = {
    users: [],
    deletedUsers: [],
    loading: true,
    saving: false,
    drafts: Object.fromEntries(SECTIONS.map((s) => [s.role, emptyDraft(s.role)])),
    editingId: null,
    editDraft: { full_name: '', email: '', role: 'technician', region: '' },
    deletedSectionOpen: false,
    bound: false,
  };

  function client() {
    return window.HubAuth && HubAuth.getClient ? HubAuth.getClient() : null;
  }

  function currentUser() {
    return window.hubCurrentUser || null;
  }

  function realAdminUser() {
    if (window.HubAuth && typeof HubAuth.getRealUser === 'function') {
      return HubAuth.getRealUser() || currentUser();
    }
    return currentUser();
  }

  function canViewAs() {
    return !!(window.HubAuth && HubAuth.isRealAdmin && HubAuth.isRealAdmin());
  }

  async function requireAdminSession() {
    const supabase = client();
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!data?.session) {
      throw new Error(
        'Your Microsoft sign-in session is missing or expired. Sign out and sign back in, then try again.'
      );
    }
    return data.session;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function regionOptions(selected) {
    const sel = String(selected || '').trim();
    const opts = [...APP_USER_REGIONS];
    if (sel && !opts.includes(sel)) opts.unshift(sel);
    return [
      `<option value="">Select region...</option>`,
      ...opts.map(
        (r) =>
          `<option value="${escapeHtml(r)}"${r === sel ? ' selected' : ''}>${escapeHtml(r)}</option>`
      ),
    ].join('');
  }

  function roleOptions(selected) {
    return APP_USER_ROLES.map(
      (r) =>
        `<option value="${escapeHtml(r.value)}"${r.value === selected ? ' selected' : ''}>${escapeHtml(r.label)}</option>`
    ).join('');
  }

  async function loadUsers() {
    const supabase = client();
    const root = document.getElementById('userMgmtRoot');
    if (!supabase || !root) return;

    const [{ data: active, error: activeError }, { data: deleted, error: deletedError }] =
      await Promise.all([
        supabase.from('app_users').select('*').is('deleted_at', null).order('full_name', { ascending: true }),
        supabase
          .from('app_users')
          .select('*')
          .not('deleted_at', 'is', null)
          .order('full_name', { ascending: true }),
      ]);

    if (activeError || deletedError) {
      state.loading = false;
      root.innerHTML = `<p class="login-status">Failed to load users: ${escapeHtml(
        (activeError || deletedError).message
      )}. Run the app_users section of supabase-schema.sql in Supabase if you have not yet.</p>`;
      return;
    }

    state.users = active || [];
    state.deletedUsers = deleted || [];
    state.loading = false;
    render();
  }

  function usersForRole(role) {
    return state.users.filter((user) => user.role === role);
  }

  async function handleAdd(sectionRole) {
    const section = document.querySelector(`.user-mgmt-section[data-role="${sectionRole}"]`);
    const addRow = section?.querySelector('.user-mgmt-add-row');
    const nameInput = addRow?.querySelector('[data-draft-field="full_name"]');
    const emailInput = addRow?.querySelector('[data-draft-field="email"]');
    const regionInput = addRow?.querySelector('[data-draft-field="region"]');
    const roleInput = addRow?.querySelector('[data-draft-field="role"]');
    const full_name = (nameInput?.value || state.drafts[sectionRole]?.full_name || '').trim();
    const email = (emailInput?.value || state.drafts[sectionRole]?.email || '').trim().toLowerCase();
    const region = (regionInput?.value || state.drafts[sectionRole]?.region || '').trim();
    const role = (roleInput?.value || state.drafts[sectionRole]?.role || sectionRole || 'technician').trim();

    if (!full_name || !email) {
      alert('Enter a full name and email.');
      return;
    }
    if (!email.includes('@')) {
      alert('Enter a valid email address.');
      return;
    }
    if (!APP_USER_ROLES.some((r) => r.value === role)) {
      alert('Select a valid position.');
      return;
    }

    state.drafts[sectionRole] = { full_name, email, role, region };
    state.saving = true;
    render();
    try {
      await requireAdminSession();
      const { error } = await client().from('app_users').insert({
        full_name,
        email,
        role,
        region: region || null,
      });
      if (error) {
        alert(error.message || 'Could not add user.');
        return;
      }
      state.drafts[sectionRole] = emptyDraft(sectionRole);
      await loadUsers();
    } catch (err) {
      alert(err.message || 'Could not add user.');
    } finally {
      state.saving = false;
      if (!state.loading) render();
    }
  }

  function startEdit(user) {
    state.editingId = user.id;
    state.editDraft = {
      full_name: user.full_name || '',
      email: user.email,
      role: user.role,
      region: user.region || '',
    };
    render();
  }

  function cancelEdit() {
    state.editingId = null;
    state.editDraft = { full_name: '', email: '', role: 'technician', region: '' };
    render();
  }

  async function handleSaveEdit() {
    if (!state.editingId) return;
    const full_name = state.editDraft.full_name.trim();
    const email = state.editDraft.email.trim().toLowerCase();
    if (!full_name || !email) {
      alert('Enter a full name and email.');
      return;
    }
    state.saving = true;
    render();
    try {
      await requireAdminSession();
      const { error } = await client()
        .from('app_users')
        .update({
          full_name,
          email,
          role: state.editDraft.role,
          region: state.editDraft.region.trim() || null,
        })
        .eq('id', state.editingId);
      if (error) {
        alert(error.message || 'Could not save user.');
        return;
      }
      cancelEdit();
      await loadUsers();
    } catch (err) {
      alert(err.message || 'Could not save user.');
    } finally {
      state.saving = false;
      if (!state.loading) render();
    }
  }

  async function handleDelete(user) {
    const me = currentUser();
    if (me && user.id === me.id) {
      alert('You cannot delete your own admin account.');
      return;
    }
    if (!window.confirm(`Remove ${user.full_name || user.email} from Onboarding Hub access roles?`)) {
      return;
    }
    state.saving = true;
    render();
    try {
      await requireAdminSession();
      const { error } = await client()
        .from('app_users')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', user.id);
      if (error) {
        alert(error.message || 'Could not remove user.');
        return;
      }
      await loadUsers();
    } catch (err) {
      alert(err.message || 'Could not remove user.');
    } finally {
      state.saving = false;
      if (!state.loading) render();
    }
  }

  async function handleRestore(user) {
    state.saving = true;
    render();
    try {
      await requireAdminSession();
      const { error } = await client().from('app_users').update({ deleted_at: null }).eq('id', user.id);
      if (error) {
        alert(error.message || 'Could not restore user.');
        return;
      }
      await loadUsers();
    } catch (err) {
      alert(err.message || 'Could not restore user.');
    } finally {
      state.saving = false;
      if (!state.loading) render();
    }
  }

  async function handlePermanentDelete(user) {
    if (
      !window.confirm(`Permanently delete ${user.full_name || user.email}? This cannot be undone.`)
    ) {
      return;
    }
    state.saving = true;
    render();
    try {
      await requireAdminSession();
      const { error } = await client().from('app_users').delete().eq('id', user.id);
      if (error) {
        alert(error.message || 'Could not delete user.');
        return;
      }
      await loadUsers();
    } catch (err) {
      alert(err.message || 'Could not delete user.');
    } finally {
      state.saving = false;
      if (!state.loading) render();
    }
  }

  function renderUserRow(user) {
    const me = realAdminUser();
    if (state.editingId === user.id) {
      return `<div class="user-mgmt-row user-mgmt-row-edit" data-user-id="${escapeHtml(user.id)}">
        <input class="user-mgmt-input" placeholder="Full name" data-edit-field="full_name" value="${escapeHtml(state.editDraft.full_name)}" />
        <input class="user-mgmt-input" placeholder="name@airadigmsolutions.com" data-edit-field="email" value="${escapeHtml(state.editDraft.email)}" />
        <select class="user-mgmt-input" data-edit-field="region" aria-label="Region">${regionOptions(state.editDraft.region)}</select>
        <select class="user-mgmt-input" data-edit-field="role" aria-label="Position">${roleOptions(state.editDraft.role)}</select>
        <div class="user-mgmt-actions">
          <button type="button" class="btn btn-primary" data-action="save-edit"${state.saving ? ' disabled' : ''}>Save</button>
          <button type="button" class="btn btn-secondary" data-action="cancel-edit">Cancel</button>
        </div>
      </div>`;
    }

    const viewAsBtn = canViewAs() && me && user.id !== me.id
      ? `<button type="button" class="btn btn-secondary" data-action="view-as" title="Preview the Hub as this user">View as</button>`
      : '';

    return `<div class="user-mgmt-row" data-user-id="${escapeHtml(user.id)}">
      <div class="user-mgmt-person">
        <div class="user-mgmt-name">${escapeHtml(user.full_name || '—')}</div>
        <div class="user-mgmt-email">${escapeHtml(user.email)}</div>
        ${user.region ? `<div class="user-mgmt-region">${escapeHtml(user.region)}</div>` : ''}
      </div>
      <div class="user-mgmt-actions">
        ${viewAsBtn}
        <button type="button" class="btn btn-secondary" data-action="edit">Edit</button>
        <button type="button" class="btn btn-secondary btn-danger" data-action="delete"${
          state.saving || (me && user.id === me.id) ? ' disabled' : ''
        }>Delete</button>
      </div>
    </div>`;
  }

  function render() {
    const root = document.getElementById('userMgmtRoot');
    if (!root) return;
    if (state.loading) {
      root.innerHTML = '<p class="login-status">Loading users…</p>';
      return;
    }

    const sectionsHtml = SECTIONS.map(({ role, title }) => {
      const sectionUsers = usersForRole(role);
      const draft = state.drafts[role] || emptyDraft(role);
      return `<section class="user-mgmt-section" data-role="${role}">
        <div class="user-mgmt-section-head">
          <h2>${title}</h2>
          <span class="user-mgmt-count">${sectionUsers.length}</span>
        </div>
        <div class="user-mgmt-list">
          ${sectionUsers.map((user) => renderUserRow(user)).join('')}
        </div>
        <div class="user-mgmt-add-row">
          <input class="user-mgmt-input" placeholder="Full name" data-draft-field="full_name" value="${escapeHtml(draft.full_name)}" />
          <input class="user-mgmt-input" placeholder="name@airadigmsolutions.com" data-draft-field="email" value="${escapeHtml(draft.email)}" />
          <select class="user-mgmt-input" data-draft-field="region" aria-label="Region">${regionOptions(draft.region)}</select>
          <select class="user-mgmt-input" data-draft-field="role" aria-label="Position">${roleOptions(draft.role || role)}</select>
          <button type="button" class="btn btn-primary" data-action="add"${state.saving ? ' disabled' : ''}>Add</button>
        </div>
      </section>`;
    }).join('');

    const deletedHtml =
      state.deletedUsers.length > 0
        ? `<section class="user-mgmt-section">
            <button type="button" class="user-mgmt-section-toggle" data-action="toggle-deleted" aria-expanded="${state.deletedSectionOpen}">
              <h2>Deleted Users</h2>
              <span class="user-mgmt-count">${state.deletedUsers.length}</span>
              <span class="user-mgmt-section-chevron" aria-hidden>${state.deletedSectionOpen ? '▾' : '▸'}</span>
            </button>
            ${
              state.deletedSectionOpen
                ? `<div class="user-mgmt-list">
                    ${state.deletedUsers
                      .map(
                        (user) => `<div class="user-mgmt-row" data-user-id="${escapeHtml(user.id)}">
                          <div class="user-mgmt-person">
                            <div class="user-mgmt-name">${escapeHtml(user.full_name || '—')}</div>
                            <div class="user-mgmt-email">${escapeHtml(user.email)}</div>
                            ${user.region ? `<div class="user-mgmt-region">${escapeHtml(user.region)}</div>` : ''}
                          </div>
                          <div class="user-mgmt-actions">
                            <button type="button" class="btn btn-secondary btn-success" data-action="restore"${state.saving ? ' disabled' : ''}>Restore</button>
                            <button type="button" class="btn btn-secondary btn-danger" data-action="permanent-delete"${state.saving ? ' disabled' : ''}>Delete permanently</button>
                          </div>
                        </div>`
                      )
                      .join('')}
                  </div>
                  <p class="user-mgmt-footnote">
                    Restore brings back their role. Permanent delete removes the user record entirely.
                  </p>`
                : ''
            }
          </section>`
        : '';

    root.innerHTML = sectionsHtml + deletedHtml;
  }

  function bindEvents() {
    if (state.bound) return;
    const root = document.getElementById('userMgmtRoot');
    if (!root) return;
    state.bound = true;

    root.addEventListener('input', (e) => {
      const draftField = e.target.getAttribute('data-draft-field');
      if (draftField) {
        const section = e.target.closest('.user-mgmt-section[data-role]');
        if (!section) return;
        const key = section.getAttribute('data-role');
        if (!state.drafts[key]) state.drafts[key] = emptyDraft(key);
        state.drafts[key][draftField] = e.target.value;
        return;
      }
      const editField = e.target.getAttribute('data-edit-field');
      if (editField) state.editDraft[editField] = e.target.value;
    });

    root.addEventListener('change', (e) => {
      const draftField = e.target.getAttribute('data-draft-field');
      if (draftField) {
        const section = e.target.closest('.user-mgmt-section[data-role]');
        if (!section) return;
        const key = section.getAttribute('data-role');
        if (!state.drafts[key]) state.drafts[key] = emptyDraft(key);
        state.drafts[key][draftField] = e.target.value;
        return;
      }
      const editField = e.target.getAttribute('data-edit-field');
      if (editField) state.editDraft[editField] = e.target.value;
    });

    root.addEventListener('click', (e) => {
      const button = e.target.closest('[data-action]');
      if (!button) return;
      const action = button.getAttribute('data-action');
      const row = button.closest('[data-user-id]');
      const userId = row?.getAttribute('data-user-id');
      const user =
        state.users.find((u) => u.id === userId) ||
        state.deletedUsers.find((u) => u.id === userId);

      if (action === 'add') {
        const section = button.closest('.user-mgmt-section[data-role]');
        if (!section) {
          alert('Could not find user section for Add.');
          return;
        }
        void handleAdd(section.getAttribute('data-role'));
      } else if (action === 'edit' && user) {
        startEdit(user);
      } else if (action === 'view-as' && user) {
        if (window.HubAuth && typeof HubAuth.startViewAs === 'function') {
          void HubAuth.startViewAs(user.id).then(() => {
            const btn = document.querySelector('.nav-link.nav-checklist');
            if (typeof showPage === 'function') showPage('checklist', btn);
          });
        }
      } else if (action === 'save-edit') {
        void handleSaveEdit();
      } else if (action === 'cancel-edit') {
        cancelEdit();
      } else if (action === 'delete' && user) {
        void handleDelete(user);
      } else if (action === 'restore' && user) {
        void handleRestore(user);
      } else if (action === 'permanent-delete' && user) {
        void handlePermanentDelete(user);
      } else if (action === 'toggle-deleted') {
        state.deletedSectionOpen = !state.deletedSectionOpen;
        render();
      }
    });
  }

  function resolveImportRole(raw) {
    const s = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const map = {
      admin: 'admin',
      technician: 'technician',
      tech: 'technician',
      accounting: 'accounting',
      hr: 'hr',
      human_resources: 'hr',
      logistics: 'logistics',
      training: 'training',
    };
    return map[s] || null;
  }

  function resolveImportRegion(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    return APP_USER_REGIONS.find((r) => r.toLowerCase() === s.toLowerCase()) || null;
  }

  function showUserImportSummary(html) {
    const el = document.getElementById('userImportSummary');
    if (!el) return;
    el.hidden = false;
    el.innerHTML = html;
  }

  function downloadUserImportTemplate() {
    if (typeof XLSX === 'undefined') {
      alert('Spreadsheet library failed to load. Refresh and try again.');
      return;
    }
    const template = [
      {
        'Full Name': 'Alex Rivera',
        Email: 'alex.rivera@airadigmsolutions.com',
        Position: 'Training',
        Region: 'Southwest',
      },
      {
        'Full Name': 'Jordan Lee',
        Email: 'jordan.lee@airadigmsolutions.com',
        Position: 'Technician',
        Region: 'Intermountain',
      },
    ];
    const ws = XLSX.utils.json_to_sheet(template);
    ws['!cols'] = [{ wch: 22 }, { wch: 36 }, { wch: 14 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    const help = XLSX.utils.aoa_to_sheet([
      ['Position values'],
      ...APP_USER_ROLES.map((r) => [r.label]),
      [],
      ['Region values'],
      ...APP_USER_REGIONS.map((r) => [r]),
    ]);
    help['!cols'] = [{ wch: 22 }];
    XLSX.utils.book_append_sheet(wb, help, 'Allowed values');
    XLSX.writeFile(wb, 'Onboarding_Hub_Users_Template.xlsx');
  }

  async function handleUserImportFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    const okExt = name.endsWith('.csv') || name.endsWith('.xls') || name.endsWith('.xlsx');
    if (!okExt) {
      alert('Please upload a .csv, .xls, or .xlsx file.');
      event.target.value = '';
      return;
    }
    if (typeof XLSX === 'undefined') {
      alert('Spreadsheet library failed to load. Refresh and try again.');
      event.target.value = '';
      return;
    }

    const btn = document.getElementById('userImportBtn');
    if (btn) btn.disabled = true;
    showUserImportSummary('<div class="ok">Reading file…</div>');

    const reader = new FileReader();
    reader.onload = async function (e) {
      try {
        let workbook;
        if (name.endsWith('.csv')) {
          const text =
            typeof e.target.result === 'string'
              ? e.target.result
              : new TextDecoder('utf-8').decode(new Uint8Array(e.target.result));
          workbook = XLSX.read(text, { type: 'string' });
        } else {
          workbook = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        }
        const sheetName =
          workbook.SheetNames.find((n) => String(n).toLowerCase() === 'users') ||
          workbook.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
        if (!rows.length) {
          showUserImportSummary('<div class="err">Empty file.</div>');
          return;
        }

        function getField(row, keys) {
          for (const k of keys) {
            for (const rk of Object.keys(row)) {
              if (rk.toLowerCase().trim() === k.toLowerCase()) return row[rk];
            }
          }
          return '';
        }

        const existingEmails = new Set(
          [...state.users, ...state.deletedUsers].map((u) =>
            String(u.email || '').toLowerCase().trim()
          )
        );
        const seenInFile = new Set();
        const toInsert = [];
        const skipped = [];
        const invalid = [];

        rows.forEach((r, i) => {
          const full_name = String(
            getField(r, ['Full Name', 'Name', 'full_name', 'fullname']) || ''
          ).trim();
          const email = String(getField(r, ['Email', 'email', 'E-mail']) || '')
            .trim()
            .toLowerCase();
          const roleRaw = String(
            getField(r, ['Position', 'Role', 'position', 'role']) || ''
          ).trim();
          const regionRaw = String(
            getField(r, ['Region', 'Division', 'region', 'division']) || ''
          ).trim();
          if (!full_name && !email && !roleRaw && !regionRaw) return;

          const role = resolveImportRole(roleRaw);
          const region = resolveImportRegion(regionRaw);
          const rowLabel = email || full_name || `Row ${i + 2}`;

          if (!full_name || !email || !email.includes('@')) {
            invalid.push(`${rowLabel}: needs Full Name and a valid Email`);
            return;
          }
          if (!role) {
            invalid.push(`${rowLabel}: invalid Position "${roleRaw || '(blank)'}"`);
            return;
          }
          if (regionRaw && !region) {
            invalid.push(`${rowLabel}: unrecognized Region "${regionRaw}"`);
            return;
          }
          if (existingEmails.has(email) || seenInFile.has(email)) {
            skipped.push(email);
            return;
          }
          seenInFile.add(email);
          toInsert.push({ full_name, email, role, region: region || null });
        });

        if (!toInsert.length) {
          showUserImportSummary(`
            <div class="warn">No new users to import.</div>
            ${skipped.length ? `<div class="warn"><strong>Skipped ${skipped.length} existing email(s).</strong></div>` : ''}
            ${invalid.length ? `<div class="err"><strong>Invalid rows:</strong><ul>${invalid.slice(0, 30).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>` : ''}
          `);
          return;
        }

        if (
          !confirm(
            `Import ${toInsert.length} new user(s)?${
              skipped.length ? `\n(${skipped.length} existing email(s) will be skipped.)` : ''
            }${invalid.length ? `\n(${invalid.length} invalid row(s) will be skipped.)` : ''}`
          )
        ) {
          showUserImportSummary('<div class="warn">Import cancelled.</div>');
          return;
        }

        showUserImportSummary('<div class="ok">Importing users…</div>');
        await requireAdminSession();
        const { error } = await client().from('app_users').insert(toInsert);
        if (error) throw error;
        await loadUsers();
        showUserImportSummary(`
          <div class="ok">✅ Imported <strong>${toInsert.length}</strong> new user(s).</div>
          ${skipped.length ? `<div class="warn"><strong>Skipped ${skipped.length} existing email(s):</strong><ul>${skipped.slice(0, 20).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>` : ''}
          ${invalid.length ? `<div class="err"><strong>Skipped ${invalid.length} invalid row(s):</strong><ul>${invalid.slice(0, 20).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>` : ''}
        `);
      } catch (err) {
        showUserImportSummary(`<div class="err">Error: ${escapeHtml(err.message || err)}</div>`);
      } finally {
        if (btn) btn.disabled = false;
        event.target.value = '';
      }
    };
    reader.onerror = () => {
      showUserImportSummary('<div class="err">Could not read the file.</div>');
      if (btn) btn.disabled = false;
      event.target.value = '';
    };
    if (name.endsWith('.csv')) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  }

  async function mount() {
    bindEvents();
    state.loading = true;
    render();
    await loadUsers();
  }

  window.HubAdmin = {
    mount,
    downloadUserImportTemplate,
    handleUserImportFile,
    APP_USER_REGIONS,
    APP_USER_ROLES,
  };
})();
