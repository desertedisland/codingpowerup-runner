// A product command must not inherit the factory's own .env: a leaked API_PORT, database and JWT
// secret once made tuco-api take over the factory's port and database.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { childEnv, envFileKeys, _ownEnvFilesForTest as ownEnvFiles } from './childEnv';

describe('childEnv', () => {

  it('drops the keys the factory env files define and keeps the rest', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/james', API_PORT: '4800', DB_NAME: 'zenfactory', JWT_SECRET: 'x' };
    const env = childEnv(base, new Set(['API_PORT', 'DB_NAME', 'JWT_SECRET']));
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/james' });
  });

  it('does not change the environment it was given', () => {
    const base = { API_PORT: '4800' };
    childEnv(base, new Set(['API_PORT']));
    expect(base).toEqual({ API_PORT: '4800' });
  });

});

describe('envFileKeys', () => {

  it('reads key names from env files and ignores missing ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'childenv-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, '# comment\nAPI_PORT=4800\nexport DB_NAME=zenfactory\nJWT_SECRET="a=b"\n');
    try {
      expect([...envFileKeys([file, path.join(dir, 'missing.env')])].sort()).toEqual(['API_PORT', 'DB_NAME', 'JWT_SECRET']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});

describe('ownEnvFiles', () => {

  it('finds --env-file in both forms plus the working directory .env, once each', () => {
    const files = ownEnvFiles(['--env-file=/srv/a/.env', '--env-file', 'b.env', '--env-file=/work/.env'], '/work');
    expect(files).toEqual(['/srv/a/.env', '/work/b.env', '/work/.env']);
  });

});
