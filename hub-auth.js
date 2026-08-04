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
    'task_notes'
  ];

  let supabase = null;

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
    if (!email) return null;

    const { data, error } = await supabase
      .from('app_users')
      .select('*')
      .eq('email', email)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      // Table may not exist yet — fail soft so the rest of the hub still works.
      console.warn('app_users lookup skipped:', error.message);
      return null;
    }

    window.hubCurrentUser = data || null;
    setAdminNavVisible(!!data && data.role === 'admin');
    return data;
  }

  async function signInWithMicrosoft() {
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
    showAppShell(session);
    await loadAppUser(session);
    const data = await loadAllHubData();
    if (typeof window.applyHubData === 'function') window.applyHubData(data);
    if (typeof window.startHubApp === 'function') window.startHubApp();
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
      showAuthScreen();
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) await onAuthenticated(session);
      if (event === 'SIGNED_OUT') {
        window.hubCurrentUser = null;
        setAdminNavVisible(false);
        showAuthScreen();
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
