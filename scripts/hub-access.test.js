const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  decideHubAccess,
  isAtlasAdmin,
  isAtlasInactive,
  mapLegacyHubRole,
  roleLabel,
} = require('../js/hub-access.js');

function atlas(overrides) {
  return {
    email: 'person@airadigmsolutions.com',
    role: 'technician',
    onboarding_hub_access: false,
    deleted_at: null,
    employment_status: 'active',
    ...overrides,
  };
}

describe('decideHubAccess', () => {
  it('AE1: Atlas Admin with no flag and no ledger is allowed as admin', () => {
    const result = decideHubAccess({
      atlasUser: atlas({ email: 'alex@airadigmsolutions.com', role: 'admin' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'ok_admin');
    assert.equal(result.role, 'admin');
    assert.equal(result.source, 'admin');
  });

  it('AE2: active technician with no flag and no ledger is denied', () => {
    const result = decideHubAccess({
      atlasUser: atlas({ email: 'sam@airadigmsolutions.com', role: 'technician' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_allowlisted');
  });

  it('AE4: Atlas finance wins over Hub ledger accounting role', () => {
    const result = decideHubAccess({
      atlasUser: atlas({
        email: 'riley@airadigmsolutions.com',
        role: 'finance',
        onboarding_hub_access: false,
      }),
      hubLedgerRow: {
        email: 'riley@airadigmsolutions.com',
        role: 'accounting',
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.role, 'finance');
    assert.equal(result.source, 'ledger');
  });

  it('AE5: demoted PM with no flag and no ledger is denied', () => {
    const result = decideHubAccess({
      atlasUser: atlas({ email: 'casey@airadigmsolutions.com', role: 'project_manager' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_allowlisted');
  });

  it('AE6: demoted general_office with ledger stays in at Atlas role', () => {
    const result = decideHubAccess({
      atlasUser: atlas({
        email: 'morgan@airadigmsolutions.com',
        role: 'general_office',
      }),
      hubLedgerRow: { email: 'morgan@airadigmsolutions.com', role: 'admin' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.role, 'general_office');
    assert.notEqual(result.role, 'admin');
  });

  it('AE7: terminated Atlas person is denied even with grant flag', () => {
    const result = decideHubAccess({
      atlasUser: atlas({
        email: 'taylor@airadigmsolutions.com',
        onboarding_hub_access: true,
        employment_status: 'terminated',
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'inactive');
  });

  it('R13: ledger orphan with no Atlas row is allowed at mapped role', () => {
    const result = decideHubAccess({
      atlasUser: null,
      hubLedgerRow: { email: 'orphan@airadigmsolutions.com', role: 'hr' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'ok_ledger');
    assert.equal(result.role, 'general_office');
    assert.equal(result.source, 'ledger_orphan');
  });

  it('deleted_at is inactive', () => {
    const result = decideHubAccess({
      atlasUser: atlas({
        onboarding_hub_access: true,
        deleted_at: '2026-08-01T00:00:00Z',
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'inactive');
  });

  it('grant flag allows non-admin at Atlas role', () => {
    const result = decideHubAccess({
      atlasUser: atlas({
        role: 'logistics',
        onboarding_hub_access: true,
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'ok_grant');
    assert.equal(result.role, 'logistics');
  });

  it('grant flag allows social_media at Atlas role', () => {
    const result = decideHubAccess({
      atlasUser: atlas({
        role: 'social_media',
        onboarding_hub_access: true,
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'ok_grant');
    assert.equal(result.role, 'social_media');
  });

  it('missing both rows is missing_email', () => {
    const result = decideHubAccess({});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_email');
  });

  it('leave employment is not inactive', () => {
    assert.equal(isAtlasInactive(atlas({ employment_status: 'leave' })), false);
    const result = decideHubAccess({
      atlasUser: atlas({ role: 'admin', employment_status: 'leave' }),
    });
    assert.equal(result.ok, true);
  });
});

describe('helpers', () => {
  it('isAtlasAdmin requires active admin role', () => {
    assert.equal(isAtlasAdmin(atlas({ role: 'admin' })), true);
    assert.equal(isAtlasAdmin(atlas({ role: 'technician' })), false);
    assert.equal(isAtlasAdmin(atlas({ role: 'admin', employment_status: 'terminated' })), false);
  });

  it('maps legacy Hub roles onto Atlas roles', () => {
    assert.equal(mapLegacyHubRole('accounting'), 'finance');
    assert.equal(mapLegacyHubRole('pm'), 'project_manager');
    assert.equal(mapLegacyHubRole('HR'), 'general_office');
    assert.equal(mapLegacyHubRole('social_media'), 'social_media');
  });

  it('labels social_media as Social Media Specialist', () => {
    assert.equal(roleLabel('social_media'), 'Social Media Specialist');
  });
});
