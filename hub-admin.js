// Onboarding Hub User Management — read-only Atlas people list
(function () {
  const state = {
    atlasPeople: [],
    ledgerRows: [],
    authorized: [],
    leftovers: [],
    loading: true,
    filterQuery: '',
    bound: false,
  };

  function accessApi() {
    return window.HubAccess || {};
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

  function accessLabel(user) {
    if (user._leftover) return 'Hub leftover';
    if (String(user.role) === 'admin' && user.source === 'admin') return 'Automatic Hub Admin';
    if (accessApi().isAtlasAdmin && accessApi().isAtlasAdmin(user)) return 'Automatic Hub Admin';
    return 'Granted in Atlas';
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

    authorized.sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
    leftovers.sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));

    state.authorized = authorized;
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
    rebuildLists();
  }

  function allPeople() {
    return [
      ...state.authorized.map((user) => Object.assign({}, user, { _leftover: false })),
      ...state.leftovers.map((user) => Object.assign({}, user, { _leftover: true })),
    ];
  }

  function matchesFilter(user, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const hay = [user.full_name, user.email, roleLabel(user.role), user.region, accessLabel(user)]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  }

  function renderUserRow(user) {
    return `<tr data-email="${escapeHtml(user.email)}">
      <td>${escapeHtml(user.full_name || '—')}</td>
      <td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(roleLabel(user.role))}</td>
      <td>${escapeHtml(user.region || '—')}</td>
      <td>${user._leftover ? 'Hub leftover' : 'Atlas'}</td>
      <td><span class="user-mgmt-footnote" style="font-style:normal;margin:0;">${escapeHtml(accessLabel(user))}</span></td>
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
            <th>Access</th>
          </tr>
        </thead>
        <tbody>
          ${users.map((user) => renderUserRow(user)).join('')}
        </tbody>
      </table>
    </div>`;
  }

  function render() {
    const root = document.getElementById('userMgmtRoot');
    if (!root) return;
    if (!isRealAdmin()) {
      root.innerHTML =
        '<p class="user-mgmt-footnote" style="font-style:normal;">Only Hub Admins (Atlas Admins) can view Hub people.</p>';
      return;
    }
    if (state.loading) {
      root.innerHTML = '<p class="login-status">Loading Atlas roster…</p>';
      return;
    }

    const people = allPeople();
    const visible = people.filter((user) => matchesFilter(user, state.filterQuery));
    const q = String(state.filterQuery || '').trim();

    let tableHtml = renderPeopleTable(visible, 'hub-users');
    if (!people.length) {
      tableHtml = '<p class="user-mgmt-footnote">No authorized Hub people yet.</p>';
    } else if (!visible.length) {
      tableHtml = `<p class="user-mgmt-footnote">No people match “${escapeHtml(q)}”.</p>`;
    }

    root.innerHTML = `
      <p class="user-mgmt-footnote" style="font-style:normal;margin:0 0 1rem;">
        People and roles come from <a href="${escapeHtml(atlasAdminUrl())}" target="_blank" rel="noopener">Atlas Admin</a>.
        Grant or revoke Onboarding Hub access there. Atlas Admins always have Hub Admin.
      </p>
      <div class="user-mgmt-filter-row">
        <input class="user-mgmt-input" id="hubUserSearch" type="search" placeholder="Search people…" value="${escapeHtml(state.filterQuery)}" autocomplete="off" />
      </div>
      ${tableHtml}
      ${state.leftovers.length ? '<p class="user-mgmt-footnote">Hub leftover rows are emails already on Hub that are not an active Atlas person. Resolve them in Atlas.</p>' : ''}
    `;
    if (window.HubShell && HubShell.enhanceTables) HubShell.enhanceTables(root);
  }

  function restoreSearchFocus() {
    const search = document.getElementById('hubUserSearch');
    if (!search) return;
    search.focus();
    const end = search.value.length;
    try { search.setSelectionRange(end, end); } catch (e) { /* search inputs may ignore */ }
  }

  function bindEvents() {
    if (state.bound) return;
    state.bound = true;
    const root = document.getElementById('userMgmtRoot');
    if (!root) return;
    root.addEventListener('input', (e) => {
      if (e.target.id !== 'hubUserSearch') return;
      state.filterQuery = e.target.value;
      render();
      restoreSearchFocus();
    });
  }

  async function mount() {
    bindEvents();
    state.loading = true;
    render();
    try {
      await loadDirectory();
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
