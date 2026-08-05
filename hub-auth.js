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

  function getConfig() {
    const cfg = window.HUB_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY === 'REPLACE_WITH_YOUR_ANON_KEY') {
      return null;
    }
    return cfg;
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

  function setAdminNavVisible(isAdmin) {
    const btn = document.getElementById('nav-admin');
    if (btn) btn.style.display = isAdmin ? '' : 'none';
  }

  async function loadAppUser(session) {
    window.hubCurrentUser = null;
    setAdminNavVisible(false);
    const email = (session?.user?.email || '').trim().toLowerCase();
    if (!email) return { ok: false, reason: 'missing_email' };

    const { data, error } = await supabase
      .from('app_users')
      .select('*')
      .eq('email', email)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      // Fail closed: do not allow Hub access if we cannot verify the allowlist.
      console.error('app_users lookup failed:', error.message);
      return { ok: false, reason: 'lookup_failed', message: error.message };
    }

    if (!data) {
      return { ok: false, reason: 'not_allowlisted' };
    }

    window.hubCurrentUser = data;
    setAdminNavVisible(data.role === 'admin');
    return { ok: true, user: data };
  }

  async function denyAccess(message) {
    window.hubCurrentUser = null;
    setAdminNavVisible(false);
    accessDenyMessage = message || accessDenyMessage;
    showAuthScreen(accessDenyMessage);
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('signOut after deny failed', e);
    }
    // Keep the denial message after SIGNED_OUT handler runs
    showAuthScreen(accessDenyMessage);
  }

  async function signInWithMicrosoft() {
    accessDenyMessage = '';
    const err = document.getElementById('auth-error');
    if (err) { err.hidden = true; err.textContent = ''; }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        scopes: 'email openid profile'
      }
    });
    if (error && err) {
      err.textContent = error.message;
      err.hidden = false;
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.hubCurrentUser = null;
    setAdminNavVisible(false);
    showAuthScreen();
  }

  async function onAuthenticated(session) {
    if (authGateInProgress) return;
    authGateInProgress = true;
    try {
      // Keep shell hidden until the user is confirmed on the Admin User Management list.
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
      const data = await loadAllHubData();
      if (typeof window.applyHubData === 'function') window.applyHubData(data);
      if (typeof window.startHubApp === 'function') window.startHubApp();
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
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

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
        setAdminNavVisible(false);
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
    isAdmin: () => !!(window.hubCurrentUser && window.hubCurrentUser.role === 'admin'),
  };
})();
