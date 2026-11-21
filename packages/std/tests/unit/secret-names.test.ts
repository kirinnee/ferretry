import { describe, it } from 'bun:test';
import should from 'should';
import {
  foldName,
  holdsSignIn,
  isPrivateFolder,
  isSecretFileName,
  isSecretFolderName,
  PRIVATE_FOLDERS,
  SIGN_IN_FILES,
} from '../../src/secret-names.ts';

describe('foldName', () => {
  it('folds case, compatibility forms, marks and invisible code points to one spelling', () => {
    should(foldName('.SSH')).eql('.ssh');
    should(foldName('.ssh')).eql('.ssh');
    should(foldName('.ssh​')).eql('.ssh');
    should(foldName('ＩＤ_ＲＳＡ')).eql('id_rsa');
  });
});

describe('isSecretFileName', () => {
  it('refuses the names the ferret reader always refused', () => {
    for (const name of ['.env', '.ENV', '.env.production', 'secrets.yaml', 'secret.enc.yml', 'secrets.json']) {
      should(isSecretFileName(name)).be.true();
    }
    for (const name of ['server.PEM', 'tls.key', 'id_rsa', 'id_rsa.pub', 'id_ed25519', 'store.kdbx', '.netrc']) {
      should(isSecretFileName(name)).be.true();
    }
    for (const name of ['.npmrc', '.pypirc', '.pgpass', '.htpasswd', 'a.p12', 'a.pfx', 'a.jks', 'a.keystore']) {
      should(isSecretFileName(name)).be.true();
    }
    should(isSecretFileName('gcp-credentials-prod.json')).be.true();
  });

  it('refuses every sign-in file the folder explorer knew, which the ferret reader did not', () => {
    for (const name of SIGN_IN_FILES) should(isSecretFileName(name)).be.true();
    should(isSecretFileName('hosts.yml')).be.true();
    should(isSecretFileName('Auth.JSON')).be.true();
    should(isSecretFileName('.credentials.json')).be.true();
  });

  it('sees through spellings a case-insensitive or decomposing disk would equate', () => {
    should(isSecretFileName('ID_RSA')).be.true();
    should(isSecretFileName('.env​')).be.true();
  });

  it('leaves ordinary names alone', () => {
    for (const name of [
      'environment.ts',
      'secrets-policy.md',
      'keyboard.ts',
      'authors.json',
      'hosts.yaml',
      'README.md',
    ]) {
      should(isSecretFileName(name)).be.false();
    }
  });
});

describe('holdsSignIn', () => {
  it('marks a folder by its sign-in files only', () => {
    should(holdsSignIn(['a', 'auth.json'])).be.true();
    should(holdsSignIn(['HOSTS.YML'])).be.true();
    should(holdsSignIn(['ID_RSA'])).be.true();
    should(holdsSignIn(['a', 'b'])).be.false();
  });

  it('does not make an ordinary project folder private for holding a .env or an .npmrc', () => {
    should(holdsSignIn(['.env', '.npmrc', 'server.pem', 'package.json'])).be.false();
    should(holdsSignIn(['id_rsa.pub'])).be.false();
  });

  it('agrees with isSecretFileName: every sign-in marker is a secret file name', () => {
    for (const name of SIGN_IN_FILES) {
      should(holdsSignIn([name])).be.true();
      should(isSecretFileName(name)).be.true();
    }
  });
});

describe('isPrivateFolder', () => {
  it('is home-relative, by segment, and folds the spelling', () => {
    should(isPrivateFolder(['.ssh'])).be.true();
    should(isPrivateFolder(['.Config', 'GH', 'x'])).be.true();
    should(isPrivateFolder(['.config'])).be.false();
    should(isPrivateFolder(['code', '.ssh'])).be.false();
  });

  it('names every folder once', () => {
    should(new Set(PRIVATE_FOLDERS.map(folder => folder.join('/'))).size).eql(PRIVATE_FOLDERS.length);
  });
});

describe('isSecretFolderName', () => {
  it('refuses key stores by name at any depth', () => {
    for (const name of ['.ssh', '.SSH', '.gnupg', '.password-store']) should(isSecretFolderName(name)).be.true();
  });

  it('leaves the folders a project keeps for itself', () => {
    for (const name of ['.claude', '.codex', '.docker', '.config', 'ssh']) should(isSecretFolderName(name)).be.false();
  });
});
