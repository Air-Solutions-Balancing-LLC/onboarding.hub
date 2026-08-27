/**
 * Pure Hub authorization rules. No Supabase clients.
 * Atlas identity + onboarding_hub_access flag, with Hub app_users as grant ledger.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.HubAccess = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const ATLAS_ROLE_LABELS = {
    admin: 'Admin',
    project_manager: 'Project Manager',
    finance: 'Finance',
    general_office: 'General Office',
    social_media: 'Social Media Specialist',
    logistics: 'Logistics',
    bid_coordinator: 'Bid Coordinator',
    estimator: 'Estimator',
    project_engineer: 'Project Engineer',
    technician: 'Technician',
  };

  const LEGACY_HUB_ROLE_TO_ATLAS = {
    admin: 'admin',
    pm: 'project_manager',
    technician: 'technician',
    accounting: 'finance',
    hr: 'general_office',
    logistics: 'logistics',
    training: 'general_office',
    social_media: 'social_media',
  };

  function lower(value) {
    return String(value || '').trim().toLowerCase();
  }

  function roleLabel(role) {
    const key = lower(role);
    return ATLAS_ROLE_LABELS[key] || (role ? String(role) : 'Member');
  }

  function mapLegacyHubRole(role) {
    const key = lower(role);
    return LEGACY_HUB_ROLE_TO_ATLAS[key] || key || null;
  }

  function emailOf(row) {
    return lower(row && row.email);
  }

  function isAtlasAdmin(atlasUser) {
    return !!(atlasUser && lower(atlasUser.role) === 'admin' && !isAtlasInactive(atlasUser));
  }

  function isAtlasInactive(atlasUser) {
    if (!atlasUser) return false;
    if (atlasUser.deleted_at) return true;
    return lower(atlasUser.employment_status) === 'terminated';
  }

  function atlasHasGrant(atlasUser) {
    if (!atlasUser) return false;
    return atlasUser.onboarding_hub_access === true || atlasUser.onboarding_hub_access === 'true';
  }

  /**
   * @param {{ atlasUser?: object|null, hubLedgerRow?: object|null }} input
   * @returns {{ ok: boolean, reason: string, role: string|null, source: string|null, email: string }}
   */
  function decideHubAccess(input) {
    const atlasUser = (input && input.atlasUser) || null;
    const hubLedgerRow = (input && input.hubLedgerRow) || null;
    const email = emailOf(atlasUser) || emailOf(hubLedgerRow);

    if (!email) {
      return { ok: false, reason: 'missing_email', role: null, source: null, email: '' };
    }

    if (atlasUser && isAtlasInactive(atlasUser)) {
      return { ok: false, reason: 'inactive', role: null, source: null, email };
    }

    if (isAtlasAdmin(atlasUser)) {
      return { ok: true, reason: 'ok_admin', role: 'admin', source: 'admin', email };
    }

    if (atlasUser && atlasHasGrant(atlasUser)) {
      return {
        ok: true,
        reason: 'ok_grant',
        role: lower(atlasUser.role) || 'technician',
        source: 'grant',
        email,
      };
    }

    if (hubLedgerRow && !hubLedgerRow.deleted_at) {
      const role = atlasUser
        ? lower(atlasUser.role) || mapLegacyHubRole(hubLedgerRow.role) || 'technician'
        : mapLegacyHubRole(hubLedgerRow.role) || lower(hubLedgerRow.role) || 'technician';
      return {
        ok: true,
        reason: atlasUser ? 'ok_ledger' : 'ok_ledger',
        role,
        source: atlasUser ? 'ledger' : 'ledger_orphan',
        email,
      };
    }

    if (atlasUser) {
      return { ok: false, reason: 'not_allowlisted', role: null, source: null, email };
    }

    return { ok: false, reason: 'not_in_atlas', role: null, source: null, email };
  }

  function isAuthorizedAtlasPerson(atlasUser, hubLedgerByEmail) {
    const email = emailOf(atlasUser);
    const ledger = email && hubLedgerByEmail ? hubLedgerByEmail.get(email) : null;
    return decideHubAccess({ atlasUser, hubLedgerRow: ledger }).ok;
  }

  return {
    ATLAS_ROLE_LABELS,
    LEGACY_HUB_ROLE_TO_ATLAS,
    decideHubAccess,
    isAtlasAdmin,
    isAtlasInactive,
    roleLabel,
    mapLegacyHubRole,
    isAuthorizedAtlasPerson,
  };
});
