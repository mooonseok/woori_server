// Reuse verified archives, never an unverified Docker tag. prepare independently
// checks the archive again and each host verifies the loaded image revision.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { assert } from './common.mjs';

export async function verifyRelease(dir, head) {
  const m = JSON.parse(await readFile(join(dir, 'release.json'), 'utf8'));
  if (m.release !== head) return false;
  const name = m.image?.split(':')[1];
  assert(
    m.schemaVersion === 1 &&
      m.deployable === true &&
      m.platform === 'linux/amd64' &&
      /^woori-server:\d{8}-[a-f0-9]{7}$/.test(m.image) &&
      name.endsWith(`-${head.slice(0, 7)}`) &&
      m.source?.kind === 'commit' &&
      m.source.commit === head &&
      ['origin/develop', 'origin/main'].includes(m.source.branch) &&
      m.checks?.architecture === 'amd64' &&
      m.checks.user === 'node' &&
      m.checks.revisionLabel === head &&
      m.checks.smoke?.smoke === 'pass' &&
      m.checks.smoke.release === head &&
      m.checks.worker?.release === head &&
      m.checks.worker.videoReady === true &&
      m.checks.worker.jobsReady === true &&
      m.checks.worker.libx264 === true &&
      m.checks.worker.aac === true &&
      m.checks.worker.preset === true,
    `기존 릴리스 검증 기록 불일치: ${dir}`
  );
  const a = m.archive;
  assert(
    a?.file === `woori-server-${name}-amd64.tar.gz` &&
      /^[a-f0-9]{64}$/.test(a.sha256) &&
      Number.isSafeInteger(a.bytes) &&
      a.bytes > 0,
    `기존 릴리스 압축 파일 정보 오류: ${dir}`
  );
  const path = join(dir, a.file);
  const stat = await lstat(path);
  assert(
    stat.isFile() && stat.size === a.bytes,
    `기존 릴리스 크기 불일치: ${dir}`
  );
  const sums = await readFile(join(dir, 'SHA256SUMS'), 'utf8');
  assert(
    sums.split('\n').includes(`${a.sha256}  ${a.file}`),
    `SHA256SUMS 불일치: ${dir}`
  );
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assert(hash.digest('hex') === a.sha256, `기존 릴리스 SHA256 불일치: ${dir}`);
  return true;
}

export async function findRelease(roots, head) {
  assert(/^[a-f0-9]{40}$/.test(head), '배포 커밋 형식 오류');
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      // An incomplete build has no final manifest and is never reusable.
      try {
        await lstat(join(dir, 'release.json'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (await verifyRelease(dir, head)) return dir;
    }
  }
  return null;
}
