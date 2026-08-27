// Onboarding Hub User Management — Atlas roster picker + revoke
(function () {
  const ATLAS_ROLE_SECTIONS = [
    { role: 'admin', title: 'Admins' },
    { role: 'project_manager', title: 'Project Managers' },
    { role: 'finance', title: 'Finance' },
    { role: 'general_office', title: 'General Office' },
    { role: 'social_media', title: 'Social Media Specialists' },
    { role: 'logistics', title: 'Logistics' },
    { role: 'bid_coordinator', title: 'Bid Coordinators' },
    { role: 'estimator', title: 'Estimators' },
    { role: 'project_engineer', title: 'Project Engineers' },
    { role: 'technician', title: 'Technicians' },
  ];

  const state = {
    atlasPeople: [],
    ledgerRows: [],
    authorized: [],
    pickerPeople: [],
    leftovers: [],
    loading: true,
    saving: false,
    pickerQuery: '',
    leftoverOpen: false,
    atlasWriteReady: false,
    bound: false,
    status: '',
  };

  function accessApi() {
    return window.HubAccess || {};
  }

  function hubClient() {
    return window.HubAuth && HubAuth.getClient ? HubAuth.getClient() : null;
  }

  function atlasClient() {
    return window.HubAuth && HubAuth.getAtlasClient ? HubAuth.getAtlasClient() : null;
  }

  function emailKey(value) {
    return window.HubAuth && HubAuth.emailKey
      ? HubAuth.emailKey(value)
      : String(value || '').trim().toLowerCase();
  }

  function roleLabel(role) {
    return accessApi().roleLabel ? accessApi().roleLabel(role) : role || '';
  }

  function isRealAdmin() {
    return !!(window.HubAuth && HubAuth.isRealAdmin && HubAuth.isRealAdmin());
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function atlasAdminUrl() {
    return (window.HUB_CONFIG && window.HUB_CONFIG.ATLAS_ADMIN_URL) || 'https://atlasops.netlify.app/admin.html';
  }

  function ledgerByEmail() {
    return new Map((state.ledgerRows || []).map((row) => [emailKey(row.email), row]));
  }

  function rebuildLists() {
    const decide = accessApi().decideHubAccess;
    const ledgerMap = ledgerByEmail();
    const authorized = [];
    const seen = new Set();

    for (const atlasUser of state.atlasPeople) {
      const ledger = ledgerMap.get(emailKey(atlasUser.email)) || null;
      const decision = decide ? decide({ atlasUser, hubLedgerRow: ledger }) : { ok: false };
      if (!decision.ok) continue;
      authorized.push(
        window.HubAuth.toStaffUser
          ? HubAuth.toStaffUser(atlasUser, ledger, decision)
          : { ...atlasUser, role: decision.role }
      );
      seen.add(emailKey(atlasUser.email));
    }

    const leftovers = [];
    for (const ledger of state.ledgerRows) {
      const email = emailKey(ledger.email);
      if (seen.has(email)) continue;
      const decision = decide ? decide({ atlasUser: null, hubLedgerRow: ledger }) : { ok: false };
      if (!decision.ok) continue;
      leftovers.push(
        window.HubAuth.toStaffUser
          ? HubAuth.toStaffUser(null, ledger, decision)
          : ledger
      );
    }

    const authorizedEmails = new Set([
      ...authorized.map((u) => emailKey(u.email)),
      ...leftovers.map((u) => emailKey(u.email)),
    ]);

    const pickerPeople = state.atlasPeople.filter((person) => {
      if (person.deleted_at) return false;
      if (String(person.employment_status || 'active').toLowerCase() === 'terminated') return false;
      if (authorizedEmails.has(emailKey(person.email))) return false;
      return true;
    });

    authorized.sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
    pickerPeople.sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
    leftovers.sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));

    state.authorized = authorized;
    state.pickerPeople = pickerPeople;
    state.leftovers = leftovers;
  }

  async function loadDirectory() {
    if (!window.HubAuth) throw new Error('Hub auth is not loaded.');
    const [atlasPeople, ledgerRows] = await Promise.all([
      HubAuth.listAtlasUsers(),
      HubAuth.listHubLedgerRows(),
    ]);
    state.atlasPeople = atlasPeople;
    state.ledgerRows = ledgerRows;
    state.atlasWriteReady = !!(HubAuth.isAtlasWriteReady && HubAuth.isAtlasWriteReady());
    rebuildLists();
  }

  async function backfillAtlasFlags() {
    if (!state.atlasWriteReady) return;
    const atlas = atlasClient();
    if (!atlas) return;
    const ledgerMap = ledgerByEmail();
    const toGrant = state.atlasPeople.filter((person) => {
      if (String(person.role) === 'admin') return false;
      if (person.onboarding_hub_access) return false;
      return ledgerMap.has(emailKey(person.email));
    });
    for (const person of toGrant) {
      const { error } = await atlas
        .from('app_users')
        .update({ onboarding_hub_access: true })
        .eq('id', person.id);
      if (error) {
        console.warn('Hub access backfill failed', person.email, error.message);
        return;
      }
    }
    if (toGrant.length) await loadDirectory();
  }

  async function upsertLedger(person) {
    const supabase = hubClient();
    if (!supabase) throw new Error('Hub session is missing.');
    const email = emailKey(person.email);
    const { data: existing, error: lookupError } = await supabase
      .from('app_users')
      .select('*')
      .eq('email', email)
      .maybeSingle();
    if (lookupError) throw lookupError;
    const payload = {
      email,
      full_name: person.full_name || existing?.full_name || email,
      role: existing?.role || 'technician',
      region: person.region || existing?.region || null,
      deleted_at: null,
    };
    if (existing) {
      const { error } = await supabase.from('app_users').update(payload).eq('id', existing.id);
      if (error) throw error;
      return;
    }
    const { error } = await supabase.from('app_users').insert(payload);
    if (error) throw error;
  }

  async function removeLedger(email) {
    const supabase = hubClient();
    const existing = ledgerByEmail().get(emailKey(email));
    if (!supabase || !existing) return;
    const { error } = await supabase
      .from('app_users')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) throw error;
  }

  async function setAtlasGrant(person, granted) {
    const atlas = atlasClient();
    if (!atlas || !state.atlasWriteReady || !person?.id) return { wrote: false };
    const { error } = await atlas
      .from('app_users')
      .update({ onboarding_hub_access: !!granted })
      .eq('id', person.id);
    if (error) throw error;
    return { wrote: true };
  }

  async function handleGrant(email) {
    const person = state.atlasPeople.find((p) => emailKey(p.email) === emailKey(email));
    if (!person) {
      alert('That person is not on the Atlas roster.');
      return;
    }
    state.saving = true;
    state.status = '';
    render();
    try {
      await upsertLedger(person);
      const atlasResult = await setAtlasGrant(person, true);
      await loadDirectory();
      state.status = atlasResult.wrote
        ? `Granted Hub access to ${person.full_name || person.email}.`
        : `Granted Hub access to ${person.full_name || person.email}. Atlas flag will sync when an Atlas Admin session is available — confirm the Onboarding Hub box in Atlas if needed.`;
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      state.saving = false;
      render();
    }
  }

  async function handleRevoke(user) {
    if (!user) return;
    if (String(user.role) === 'admin' && user.source === 'admin') {
      alert('Atlas Admins cannot be removed from Hub while they remain Admin.');
      return;
    }
    if (accessApi().isAtlasAdmin && accessApi().isAtlasAdmin(user) && user.atlas_id) {
      alert('Atlas Admins cannot be removed from Hub while they remain Admin.');
      return;
    }
    const atlasPerson = state.atlasPeople.find((p) => emailKey(p.email) === emailKey(user.email));
    if (atlasPerson && String(atlasPerson.role) === 'admin') {
      alert('Atlas Admins cannot be removed from Hub while they remain Admin.');
      return;
    }
    if (!window.confirm(`Remove Hub access for ${user.full_name || user.email}?`)) return;
    state.saving = true;
    state.status = '';
    render();
    try {
      if (atlasPerson) await setAtlasGrant(atlasPerson, false);
      await removeLedger(user.email);
      await loadDirectory();
      state.status = `Removed Hub access for ${user.full_name || user.email}.`;
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      state.saving = false;
      render();
    }
  }

  function filteredPicker() {
    const q = String(state.pickerQuery || '').trim().toLowerCase();
    if (!q) return state.pickerPeople;
    return state.pickerPeople.filter((person) => {
      const hay = [person.full_name, person.email, person.role, person.region]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function usersForRole(role) {
    return state.authorized.filter((user) => String(user.role) === role);
  }

  function roleBadgeClass(role) {
    const key = String(role || '').toLowerCase().trim();
    if (key === 'admin') return 'hub-role-badge hub-role-admin';
    if (key === 'hr' || key === 'finance' || key === 'accounting' || key === 'general_office') return 'hub-role-badge hub-role-hr';
    if (key === 'social_media') return 'hub-role-badge hub-role-social';
    if (key === 'logistics') return 'hub-role-badge hub-role-logistics';
    if (key === 'training') return 'hub-role-badge hub-role-training';
    return 'hub-role-badge hub-role-other';
  }

  function renderUserRow(user, { leftover = false } = {}) {
    const canRevoke = String(user.role) !== 'admin' || leftover;
    const atlasAdminLocked = !leftover && String(user.role) === 'admin';
    return `<tr data-email="${escapeHtml(user.email)}">
      <td>${escapeHtml(user.full_name || '—')}</td>
      <td>${escapeHtml(user.email)}</td>
      <td><span class="${roleBadgeClass(user.role)}">${escapeHtml(roleLabel(user.role))}</span></td>
      <td>${escapeHtml(user.region || '—')}</td>
      <td>${leftover ? 'Hub leftover' : 'Atlas'}</td>
      <td>${
        atlasAdminLocked
          ? `<span class="user-mgmt-footnote" style="font-style:normal;margin:0;">Automatic Hub Admin</span>`
          : `<button type="button" class="btn btn-secondary btn-danger" data-action="revoke"${
              state.saving || !canRevoke ? ' disabled' : ''
            }>Revoke</button>`
      }</td>
    </tr>`;
  }

  function renderPeopleTable(users, sortKey) {
    if (!users.length) return '';
    return `<div class="nh-table-wrap">
      <table class="data-table" data-sort-key="${escapeHtml(sortKey)}">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Region</th>
            <th>Source</th>
            <th class="no-sort">Access</th>
          </tr>
        </thead>
        <tbody>
          ${users.map((user) => renderUserRow(user, { leftover: !!user._leftover })).join('')}
        </tbody>
      </table>
    </div>`;
  }

  function render() {
    const root = document.getElementById('userMgmtRoot');
    if (!root) return;
    if (!isRealAdmin()) {
      root.innerHTML =
        '<p class="user-mgmt-footnote" style="font-style:normal;">Only Hub Admins (Atlas Admins) can grant or revoke Onboarding Hub access.</p>';
      return;
    }
    if (state.loading) {
      root.innerHTML = '<p class="login-status">Loading Atlas roster…</p>';
      return;
    }

    const picker = filteredPicker();
    const pickerOptions = picker
      .slice(0, 80)
      .map(
        (person) =>
          `<option value="${escapeHtml(emailKey(person.email))}">${escapeHtml(
            `${person.full_name || person.email} · ${roleLabel(person.role)}${person.region ? ` · ${person.region}` : ''}`
          )}</option>`
      )
      .join('');

    const people = [
      ...state.authorized.map((user) => Object.assign({}, user, { _leftover: false })),
      ...state.leftovers.map((user) => Object.assign({}, user, { _leftover: true })),
    ];

    root.innerHTML = `
      <p class="user-mgmt-footnote" style="font-style:normal;margin:0 0 1rem;">
        People and roles come from <a href="${escapeHtml(atlasAdminUrl())}" target="_blank" rel="noopener">Atlas Admin</a>.
        Grant Hub access by picking someone from Atlas. Atlas Admins always have Hub Admin.
        ${state.atlasWriteReady ? '' : ' Atlas write session is not attached — grants still save on Hub and should be confirmed in Atlas.'}
      </p>
      ${state.status ? `<p class="user-mgmt-footnote" style="font-style:normal;color:var(--color-accent);">${escapeHtml(state.status)}</p>` : ''}
      <div class="user-mgmt-add-row" style="margin-bottom:1.25rem;">
        <input class="user-mgmt-input" id="hubGrantSearch" type="search" placeholder="Search Atlas people to grant…" value="${escapeHtml(state.pickerQuery)}" ${state.saving ? 'disabled' : ''} />
        <select class="user-mgmt-input" id="hubGrantSelect" aria-label="Atlas person" ${state.saving ? 'disabled' : ''}>
          <option value="">${picker.length ? 'Select a person…' : 'No remaining Atlas people'}</option>
          ${pickerOptions}
        </select>
        <div class="user-mgmt-actions">
          <button type="button" class="btn btn-primary" data-action="grant" ${state.saving || !picker.length ? 'disabled' : ''}>Grant access</button>
        </div>
      </div>
      ${renderPeopleTable(people, 'hub-users') || '<p class="user-mgmt-footnote">No authorized Hub people yet.</p>'}
      ${state.leftovers.length ? '<p class="user-mgmt-footnote">Hub leftover rows are emails already on Hub that are not an active Atlas person. They stay until revoked or added in Atlas.</p>' : ''}
    `;
    if (window.HubShell && HubShell.enhanceTables) HubShell.enhanceTables(root);
  }

  function bindEvents() {
    if (state.bound) return;
    state.bound = true;
    const root = document.getElementById('userMgmtRoot');
    if (!root) return;
    root.addEventListener('input', (e) => {
      if (e.target.id === 'hubGrantSearch') {
        state.pickerQuery = e.target.value;
        const select = document.getElementById('hubGrantSelect');
        const keep = select?.value || '';
        render();
        const next = document.getElementById('hubGrantSelect');
        if (next && keep) next.value = keep;
        const search = document.getElementById('hubGrantSearch');
        if (search) {
          search.focus();
          const end = search.value.length;
          search.setSelectionRange(end, end);
        }
      }
    });
    root.addEventListener('click', (e) => {
      const button = e.target.closest('[data-action]');
      if (!button) return;
      const action = button.getAttribute('data-action');
      if (action === 'grant') {
        const select = document.getElementById('hubGrantSelect');
        const email = select && select.value;
        if (!email) {
          alert('Select a person from Atlas first.');
          return;
        }
        void handleGrant(email);
      } else if (action === 'revoke') {
        const row = button.closest('[data-email]');
        const email = row?.getAttribute('data-email');
        const user =
          state.authorized.find((u) => emailKey(u.email) === emailKey(email)) ||
          state.leftovers.find((u) => emailKey(u.email) === emailKey(email));
        void handleRevoke(user);
      } else if (action === 'toggle-leftover') {
        state.leftoverOpen = !state.leftoverOpen;
        render();
      }
    });
  }

  async function mount() {
    bindEvents();
    state.loading = true;
    render();
    try {
      await loadDirectory();
      await backfillAtlasFlags();
    } catch (err) {
      const root = document.getElementById('userMgmtRoot');
      if (root) {
        root.innerHTML = `<p class="user-mgmt-footnote" style="font-style:normal;">Could not load Atlas users: ${escapeHtml(
          err.message || err
        )}</p>`;
      }
      return;
    }
    state.loading = false;
    render();
  }

  window.HubAdmin = {
    mount,
  };
})();
