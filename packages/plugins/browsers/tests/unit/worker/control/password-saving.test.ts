import { describe, it } from 'bun:test';
import should from 'should';
import { PASSWORD_SAVING_OFF, passwordSavingOff } from '../../../../src/lib/browser/control/profile.ts';

describe('passwordSavingOff', () => {
  it('should force every password-saving switch off and keep every other preference', () => {
    const merged = passwordSavingOff({
      credentials_enable_service: true,
      credentials_enable_autosignin: true,
      profile: { password_manager_enabled: true, name: 'Ferretry' },
      browser: { has_seen_welcome_page: true },
    });

    should(merged).eql({
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      profile: { password_manager_enabled: false, name: 'Ferretry' },
      browser: { has_seen_welcome_page: true },
    });
  });

  it('should start a fresh file with only the switches from anything that is not a preferences object', () => {
    const fresh = {
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      profile: { password_manager_enabled: false },
    };

    for (const existing of [undefined, null, 'not json', [1, 2], 7]) should(passwordSavingOff(existing)).eql(fresh);
    should(passwordSavingOff({ profile: 'damaged' })).eql(fresh);
    should(PASSWORD_SAVING_OFF.profile.password_manager_enabled).be.false();
  });
});
