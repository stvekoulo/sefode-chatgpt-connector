import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export function authDirectory() {
  return path.resolve(process.env.SEFODE_AUTH_DIR || path.join(os.homedir(), '.sefode-chatgpt'));
}

export function prepareDirectory(directory = authDirectory()) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Auth directory must not be a symlink');
  if (process.platform === 'win32') {
    const account = execFileSync('whoami.exe', [], {encoding: 'utf8'}).trim();
    execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`],
      {stdio: 'ignore'});
  } else fs.chmodSync(directory, 0o700);
  return directory;
}

export function savePrivate(name, value, directory = authDirectory()) {
  const target = path.join(prepareDirectory(directory), name);
  const temporary = target + '.' + randomUUID() + '.tmp';
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Symlink refused');
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(temporary, target);
}

export function readPrivate(name, directory = authDirectory()) {
  const target = path.join(directory, name);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid credential file');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Credential permissions must be 0600');
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

export function hostId(directory = authDirectory()) {
  prepareDirectory(directory);
  const target = path.join(directory, 'host.private.json');
  if (!fs.existsSync(target)) savePrivate('host.private.json', {ext_agent_host_id: 'urn:uuid:' + randomUUID()}, directory);
  return readPrivate('host.private.json', directory).ext_agent_host_id;
}
