// Auth + shared Supabase data layer for Onboarding Hub
(function () {
  const HUB_DATA_KEYS = [
    'airadigm_resources',
    'airadigm_responsibilities',
    'resp_checks',
    'orient_notes',
    'orient_groups',
    'orient_extra_templates',
    'bc_extra_templates',
    'bootcamp_groups',
    'bootcamp_checks',
    'airadigm_tasks_v2',
    'task_notes',
    'new_hire_checklist'
  ];

  let supabase = null;
  let accessDenyMessage = '';
  let authGateInProgress = false;
  let hubRealUser = null; // Microsoft-signed-in allowlisted user
  let viewAsUsers = [];

  function getConfig() {
    const cfg = window.HUB_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY === 'REPLACE_WITH_YOUR_ANON_KEY') {
      return null;
    }
    return cfg;
  }

  function effectiveUser() {
    return window.hubCurrentUser || null;
  }

  function realUser() {
    return hubRealUser;
  }

  function isRealAdmin() {
    return !!(hubRealUser && hubRealUser.role === 'admin');
  }

  function isImpersonating() {
    if (!hubRealUser || !window.hubCurrentUser) return false;
    return String(hubRealUser.id) !== String(window.hubCurrentUser.id);
  }

  async function hubLoad(key) {
    const { data, error } = await supabase.from('hub_data').select('value').eq('key', key).maybeSingle();
    if (error) {
      console.error('hubLoad error', key, error);
      return null;
    }
    return data ? data.value : null;
  }

  async function hubSave(key, value) {
    const { error } = await supabase.from('hub_data').upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if (error) console.error('hubSave error', key, error);
  }

  async function migrateLocalStorageToSupabase() {
    for (const key of HUB_DATA_KEYS) {
      const local = localStorage.getItem(key);
      if (!local) continue;
      const remote = await hubLoad(key);
      if (remote !== null && remote !== undefined) continue;
      try {
        await hubSave(key, JSON.parse(local));
      } catch (e) {
        console.warn('migrate skip', key, e);
      }
    }
  }

  async function loadAllHubData() {
    await migrateLocalStorageToSupabase();
    const out = {};
    for (const key of HUB_DATA_KEYS) {
      out[key] = await hubLoad(key);
    }
    return out;
  }

  function showAuthScreen(message) {
    const auth = document.getElementById('auth-screen');
    const app = document.getElementById('app-shell');
    if (auth) auth.hidden = false;
    if (app) app.hidden = true;
    const err = document.getElementById('auth-error');
    if (err) {
      err.textContent = message || '';
      err.hidden = !message;
    }
  }

  function showAppShell(session) {
    const auth = document.getElementById('auth-screen');
    const app = document.getElementById('app-shell');
    if (auth) auth.hidden = true;
    if (app) app.hidden = false;
    const emailEl = document.getElementById('nav-user-email');
    if (emailEl && session?.user?.email) emailEl.textContent = session.user.email;
  }

  // Extra Hub tabs (Resources, Responsibilities, Orientation, Weekly) are Paula-only.
  const PAULA_EMAILS = [
    'paula.quintero@airadigmsolutions.com',
    'pquintero@airadigmsolutions.com',
    'paula@airadigmsolutions.com'
  ];

  function isPaulaUser(user) {
    const u = user || window.hubCurrentUser;
    if (!u) return false;
    const email = String(u.email || '').trim().toLowerCase();
    const name = String(u.full_name || '').trim().toLowerCase();
    if (PAULA_EMAILS.includes(email)) return true;
    if (email.startsWith('paula.quintero@') || email.startsWith('pquintero@')) return true;
    if (name.includes('paula') && name.includes('quintero')) return true;
    return false;
  }

  function applyNavVisibility() {
    const signedIn = !!hubRealUser;
    const paula = isPaulaUser(effectiveUser());
    const adminBtn = document.getElementById('nav-admin');
    // Real admins always keep Admin. Other allowlisted users keep current access.
    if (adminBtn) {
      adminBtn.style.display = signedIn ? '' : 'none';
    }
    document.querySelectorAll('[data-paula-only]').forEach((el) => {
      el.style.display = paula ? '' : 'none';
    });
    renderViewAsUi();
  }

  function renderViewAsUi() {
    const wrap = document.getElementById('nav-view-as');
    const banner = document.getElementById('view-as-banner');
    const select = document.getElementById('nav-view-as-select');
    if (!wrap || !select) return;

    if (!isRealAdmin()) {
      wrap.hidden = true;
      if (banner) banner.hidden = true;
      return;
    }

    wrap.hidden = false;
    const currentId = String(effectiveUser()?.id || '');
    const options = [
      `<option value="">Me (${escapeAttr(hubRealUser.full_name || hubRealUser.email)})</option>`,
      ...viewAsUsers
        .filter((u) => String(u.id) !== String(hubRealUser.id))
        .map((u) => {
          const label = `${u.full_name || u.email} (${u.role})`;
          return `<option value="${escapeAttr(u.id)}"${String(u.id) === currentId && isImpersonating() ? ' selected' : ''}>${escapeAttr(label)}</option>`;
        })
    ];
    select.innerHTML = options.join('');
    if (!isImpersonating()) select.value = '';

    if (banner) {
      if (isImpersonating()) {
        const name = effectiveUser().full_name || effectiveUser().email;
        banner.hidden = false;
        banner.innerHTML = `Viewing as <strong>${escapeAttr(name)}</strong> · ${escapeAttr(effectiveUser().role)} — filters and tabs match their access. <button type="button" class="view-as-exit" id="view-as-exit-btn">Exit</button>`;
        document.getElementById('view-as-exit-btn')?.addEventListener('click', () => stopViewAs());
      } else {
        banner.hidden = true;
        banner.innerHTML = '';
      }
    }
  }

  function escapeAttr(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadViewAsUsers() {
    if (!supabase || !isRealAdmin()) {
      viewAsUsers = [];
      return;
    }
    const { data, error } = await supabase
      .from('app_users')
      .select('id, email, full_name, role, region')
      .is('deleted_at', null)
      .order('full_name', { ascending: true });
    if (error) {
      console.warn('view-as users load failed', error);
      viewAsUsers = [];
      return;
    }
    viewAsUsers = data || [];
  }

  function refreshAfterIdentityChange() {
    applyNavVisibility();
    const emailEl = document.getElementById('nav-user-email');
    if (emailEl) {
      if (isImpersonating()) {
        emailEl.textContent = `${effectiveUser()?.full_name || effectiveUser()?.email} (view as)`;
      } else if (hubRealUser) {
        emailEl.textContent = hubRealUser.email || hubRealUser.full_name || '';
      }
    }
    if (window.HubChecklist && typeof HubChecklist.applyViewerDefaults === 'function') {
      HubChecklist.applyViewerDefaults();
    }
    // If on a Paula-only page while viewing as non-Paula, bounce to checklist
    if (!isPaulaUser(effectiveUser())) {
      const active = document.querySelector('.page.active');
      const id = active?.id || '';
      if (/page-(resources|responsibilities|orientation|weekly)/.test(id)) {
        const btn = document.querySelector('.nav-link.nav-checklist');
        if (typeof showPage === 'function') showPage('checklist', btn);
      }
    }
  }

  async function startViewAs(userId) {
    if (!isRealAdmin()) return;
    if (!userId) {
      stopViewAs();
      return;
    }
    let target = viewAsUsers.find((u) => String(u.id) === String(userId));
    if (!target && supabase) {
      const { data } = await supabase
        .from('app_users')
        .select('*')
        .eq('id', userId)
        .is('deleted_at', null)
        .maybeSingle();
      target = data;
    }
    if (!target) {
      alert('Could not find that user.');
      return;
    }
    window.hubCurrentUser = target;
    try { sessionStorage.setItem('hub_view_as_id', String(target.id)); } catch (e) { /* ignore */ }
    refreshAfterIdentityChange();
  }

  function stopViewAs() {
    window.hubCurrentUser = hubRealUser;
    try { sessionStorage.removeItem('hub_view_as_id'); } catch (e) { /* ignore */ }
    refreshAfterIdentityChange();
  }

  async function restoreViewAsIfAny() {
    if (!isRealAdmin()) return;
    let saved = '';
    try { saved = sessionStorage.getItem('hub_view_as_id') || ''; } catch (e) { saved = ''; }
    if (!saved) return;
    await startViewAs(saved);
  }

  async function loadAppUser(session) {
    window.hubCurrentUser = null;
    hubRealUser = null;
    applyNavVisibility();
    const email = (session?.user?.email || '').trim().toLowerCase();
    if (!email) return { ok: false, reason: 'missing_email' };

    const { data, error } = await supabase
      .from('app_users')
      .select('*')
      .eq('email', email)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      console.error('app_users lookup failed:', error.message);
      return { ok: false, reason: 'lookup_failed', message: error.message };
    }

    if (!data) {
      return { ok: false, reason: 'not_allowlisted' };
    }

    hubRealUser = data;
    window.hubCurrentUser = data;
    applyNavVisibility();
    return { ok: true, user: data };
  }

  async function denyAccess(message) {
    window.hubCurrentUser = null;
    hubRealUser = null;
    try { sessionStorage.removeItem('hub_view_as_id'); } catch (e) { /* ignore */ }
    applyNavVisibility();
    accessDenyMessage = message || accessDenyMessage;
    showAuthScreen(accessDenyMessage);
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('signOut after deny failed', e);
    }
    showAuthScreen(accessDenyMessage);
  }

  async function signInWithMicrosoft() {
    accessDenyMessage = '';
    const err = document.getElementById('auth-error');
    if (err) { err.hidden = true; err.textContent = ''; }
    const redirectTo = `${window.location.origin}/`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        redirectTo,
        scopes: 'openid profile email offline_access',
        queryParams: {
          prompt: 'select_account'
        }
      }
    });
    if (error && err) {
      err.textContent = error.message;
      err.hidden = false;
    }
  }

  async function signOut() {
    try { sessionStorage.removeItem('hub_view_as_id'); } catch (e) { /* ignore */ }
    await supabase.auth.signOut();
    window.hubCurrentUser = null;
    hubRealUser = null;
    viewAsUsers = [];
    applyNavVisibility();
    showAuthScreen();
  }

  function bindViewAsControls() {
    const select = document.getElementById('nav-view-as-select');
    if (select && !select._hubBound) {
      select._hubBound = true;
      select.addEventListener('change', () => {
        startViewAs(select.value || '');
      });
    }
  }

  async function onAuthenticated(session) {
    if (authGateInProgress) return;
    authGateInProgress = true;
    try {
      showAuthScreen('Checking access…');

      const access = await loadAppUser(session);
      if (!access.ok) {
        let message =
          'Access denied. Your Microsoft account is not on the approved Hub user list. Ask an Admin to add you under Admin → User Management.';
        if (access.reason === 'missing_email') {
          message = 'Access denied. Your Microsoft sign-in did not return an email address.';
        } else if (access.reason === 'lookup_failed') {
          message =
            'Access denied. Could not verify your account against the approved user list. Try again or contact an Admin.';
        }
        await denyAccess(message);
        return;
      }

      accessDenyMessage = '';
      showAppShell(session);
      bindViewAsControls();
      await loadViewAsUsers();
      await restoreViewAsIfAny();
      applyNavVisibility();
      const data = await loadAllHubData();
      if (typeof window.applyHubData === 'function') window.applyHubData(data);
      if (typeof window.startHubApp === 'function') window.startHubApp();
      refreshAfterIdentityChange();
    } finally {
      authGateInProgress = false;
    }
  }

  async function initHub() {
    const cfg = getConfig();
    if (!cfg) {
      showAuthScreen('Supabase is not configured. Add your anon key to config.js.');
      return;
    }

    supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce'
      }
    });

    // Drop OAuth callback junk from the URL so browser Back stays inside the Hub
    try {
      const u = new URL(window.location.href);
      if (u.hash || u.searchParams.has('code') || u.searchParams.has('error')) {
        window.history.replaceState({ hub: 'home' }, document.title, u.pathname || '/');
      }
    } catch (e) { /* ignore */ }

    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      await onAuthenticated(session);
    } else {
      showAuthScreen(accessDenyMessage);
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) await onAuthenticated(session);
      if (event === 'SIGNED_OUT') {
        window.hubCurrentUser = null;
        hubRealUser = null;
        viewAsUsers = [];
        applyNavVisibility();
        showAuthScreen(accessDenyMessage);
      }
    });
  }

  window.HubAuth = {
    init: initHub,
    save: hubSave,
    signInWithMicrosoft,
    signOut,
    getClient: () => supabase,
    isAdmin: () => isRealAdmin() || !!(effectiveUser() && effectiveUser().role === 'admin'),
    isRealAdmin,
    isImpersonating,
    getRealUser: () => hubRealUser,
    startViewAs,
    stopViewAs,
    // Any allowlisted user can open Admin (user mgmt + checklist process)
    canAccessAdmin: () => !!hubRealUser,
    // Paula-only tabs follow the effective (view-as) user
    isPaula: () => isPaulaUser(effectiveUser()),
    canAccessHubExtras: () => isPaulaUser(effectiveUser()),
    applyNavVisibility
  };
})();