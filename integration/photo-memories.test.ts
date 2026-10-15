import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { PhotoDateBackfillRepository } from '../src/domain/photos/photo-date-backfill.repository';

function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  return url.toString();
}
type MemoryItem = {
  photo: {
    id: string;
    groupId: string;
    albumId: string;
    effectiveDate: string;
    dateSource: string;
    canEditCaptureDate: boolean;
  };
  albumTitle: string;
  effectiveDate: string;
  dateSource: 'USER' | 'EXIF' | 'UPLOAD';
  yearsAgo: number;
};
type MemoryPage = {
  asOf: string;
  timeZone: string;
  kind: 'today' | 'month' | 'hidden';
  items: MemoryItem[];
  nextCursor: string | null;
};

test('isolated PostgreSQL: capture dates and private memories enforce current membership', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
  });
  const app = await createApp();
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  const suffix = randomBytes(4).toString('hex');
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const signup = async (label: string) => {
      const agent = request.agent(app.getHttpServer());
      const result = await mutate(agent.post('/v1/auth/signup'))
        .send({
          username: `${label}_${suffix}`,
          displayName: label,
          email: `${label}_${suffix}@example.test`,
          password: 'memory-integration-password-2026',
        })
        .expect(201);
      await admin.query(
        'UPDATE woori.users SET "verifiedAt"=now() WHERE id=$1',
        [result.body.user.id]
      );
      return { agent, id: result.body.user.id as string };
    };
    const owner = await signup('m_owner'),
      member = await signup('m_member'),
      outsider = await signup('m_outside');
    const group = async (name: string) =>
      (await mutate(owner.agent.post('/v1/groups')).send({ name }).expect(201))
        .body.group.id as string;
    const join = async (groupId: string) => {
      const inv = (
        await mutate(owner.agent.post(`/v1/groups/${groupId}/invitations`))
          .send({ expiresInHours: 72, maxUses: 10 })
          .expect(201)
      ).body;
      await mutate(member.agent.post('/v1/invitations/join'))
        .send({ code: inv.code })
        .expect(200);
    };
    const album = async (groupId: string, title = '추억 사진') =>
      (
        await mutate(owner.agent.post(`/v1/groups/${groupId}/albums`))
          .send({ title })
          .expect(201)
      ).body.album.id as string;
    const g = await group('촬영일과 추억');
    await join(g);
    const a = await album(g);
    const otherGroup = await group('다른 그룹'),
      otherAlbum = await album(otherGroup);
    const path = (groupId: string, albumId: string, photoId: string) =>
      `/v1/groups/${groupId}/albums/${albumId}/photos/${photoId}`;
    const memories = (groupId = g) => `/v1/groups/${groupId}/memories`;
    const initial = (await owner.agent.get(memories()).expect(200))
      .body as MemoryPage;
    assert.match(initial.asOf, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(initial.timeZone, 'Asia/Seoul');
    assert.deepEqual(initial.items, []);
    const [year, month, day] = initial.asOf.split('-').map(Number);
    const date = (y: number, m = month, d = day) =>
      `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const past = date(year - 4),
      monthly = date(year - 4, month, day === 1 ? 2 : 1);
    const unrelated = date(year - 4, month === 12 ? 1 : month + 1, 10);
    const photo = async (
      opts: {
        groupId?: string;
        albumId?: string;
        uploaderId?: string;
        uploadDate?: string;
        exifDate?: string;
        manualDate?: string;
      } = {}
    ) => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,bytes,width,height,"createdAt","capturedAt","captureDateSource","manualCapturedDate")
         VALUES($1,$2,$3,$4,'READY',1,1,1,$5,$6,$7,$8)`,
        [
          id,
          opts.groupId ?? g,
          opts.albumId ?? a,
          opts.uploaderId ?? member.id,
          `${opts.uploadDate ?? initial.asOf}T00:00:00+09:00`,
          opts.exifDate ? `${opts.exifDate}T00:00:00+09:00` : null,
          opts.exifDate ? 'EXIF' : null,
          opts.manualDate ?? null,
        ]
      );
      await admin.query(
        'UPDATE woori.groups SET "usedBytes"="usedBytes"+1 WHERE id=$1',
        [opts.groupId ?? g]
      );
      return id;
    };
    const userPhoto = await photo({ manualDate: past, exifDate: unrelated });
    const exifPhoto = await photo({ exifDate: past });
    const uploadPhoto = await photo({ uploadDate: past });
    const monthPhoto = await photo({ exifDate: monthly });
    const recentPhoto = await photo();
    const unrelatedPhoto = await photo({ exifDate: unrelated });
    const foreignPhoto = await photo({
      groupId: otherGroup,
      albumId: otherAlbum,
      uploaderId: owner.id,
      exifDate: past,
    });
    const ownPhoto = await photo({ uploaderId: owner.id, exifDate: unrelated });

    await t.test(
      'today/month use effective date priority and paginate without exposing foreign identifiers',
      async () => {
        const today = (
          await member.agent.get(`${memories()}?kind=today`).expect(200)
        ).body as MemoryPage;
        assert.equal(today.kind, 'today');
        assert.deepEqual(
          new Set(today.items.map((i) => i.photo.id)),
          new Set([userPhoto, exifPhoto, uploadPhoto])
        );
        for (const [id, source] of [
          [userPhoto, 'USER'],
          [exifPhoto, 'EXIF'],
          [uploadPhoto, 'UPLOAD'],
        ]) {
          const item = today.items.find((i) => i.photo.id === id)!;
          assert.equal(item.dateSource, source);
          assert.equal(item.effectiveDate, past);
          assert.equal(item.photo.effectiveDate, past);
          assert.equal(item.photo.dateSource, source);
          assert.equal(item.photo.canEditCaptureDate, true);
          assert.equal(item.yearsAgo, 4);
          assert.equal(item.albumTitle, '추억 사진');
        }
        const monthlyPage = (
          await member.agent.get(`${memories()}?kind=month`).expect(200)
        ).body as MemoryPage;
        assert.deepEqual(
          monthlyPage.items.map((i) => i.photo.id),
          [monthPhoto]
        );
        const paged: string[] = [];
        let cursor: string | null = null;
        do {
          const page = (
            await member.agent
              .get(
                `${memories()}?kind=today&limit=1${cursor ? `&cursor=${cursor}` : ''}`
              )
              .expect(200)
          ).body as MemoryPage;
          assert.equal(page.items.length, 1);
          assert.ok(!paged.includes(page.items[0].photo.id));
          paged.push(page.items[0].photo.id);
          cursor = page.nextCursor;
          assert.ok(paged.length <= 3);
        } while (cursor);
        assert.deepEqual(
          new Set(paged),
          new Set([userPhoto, exifPhoto, uploadPhoto])
        );
        await api.get(memories()).expect(401);
        await outsider.agent.get(memories()).expect(404);
        await member.agent.get(memories(otherGroup)).expect(404);
        for (const query of [
          'limit=0',
          'limit=31',
          'cursor=not-a-uuid',
          'kind=all',
          `userId=${owner.id}`,
        ]) {
          await member.agent.get(`${memories()}?${query}`).expect(400);
        }
        await member.agent
          .get(`${memories()}?cursor=${foreignPhoto}`)
          .expect(404);
        await member.agent
          .get(`${memories()}?kind=today&cursor=${monthPhoto}`)
          .expect(404);
      }
    );

    await t.test(
      'manual dates are owner/uploader-only, validated strictly, and clearing restores EXIF/upload fallback',
      async () => {
        const change = (who: typeof owner, id: string, value: unknown) =>
          mutate(who.agent.patch(`${path(g, a, id)}/capture-date`)).send({
            date: value,
          });
        await mutate(api.patch(`${path(g, a, userPhoto)}/capture-date`))
          .send({ date: past })
          .expect(401);
        await change(outsider, userPhoto, past).expect(404);
        await change(member, ownPhoto, past).expect(404);
        await mutate(
          member.agent.patch(
            `${path(otherGroup, otherAlbum, userPhoto)}/capture-date`
          )
        )
          .send({ date: past })
          .expect(404);
        await mutate(
          owner.agent.patch(`${path(g, otherAlbum, userPhoto)}/capture-date`)
        )
          .send({ date: past })
          .expect(404);
        for (const invalid of [
          '2025-02-29',
          '2024-02-30',
          '2024-13-01',
          '2024-00-10',
          '1799-12-31',
          `${year + 1}-01-01`,
          '2024-1-01',
          '2024-01-01T00:00:00Z',
          '',
          20240101,
        ]) {
          await change(member, userPhoto, invalid).expect(400);
        }
        await mutate(
          member.agent.patch(`${path(g, a, userPhoto)}/capture-date`)
        )
          .send({})
          .expect(400);
        await mutate(
          member.agent.patch(`${path(g, a, userPhoto)}/capture-date`)
        )
          .send({ date: past, userId: owner.id })
          .expect(400);
        const edit = await change(member, exifPhoto, monthly).expect(200);
        assert.equal(edit.body.photo.id, exifPhoto);
        assert.equal(edit.body.photo.effectiveDate, monthly);
        assert.equal(edit.body.photo.dateSource, 'USER');
        let page = (
          await member.agent.get(`${memories()}?kind=month`).expect(200)
        ).body as MemoryPage;
        assert.equal(
          page.items.find((i) => i.photo.id === exifPhoto)?.dateSource,
          'USER'
        );
        await change(owner, exifPhoto, null).expect(200);
        page = (await member.agent.get(memories()).expect(200))
          .body as MemoryPage;
        assert.equal(
          page.items.find((i) => i.photo.id === exifPhoto)?.dateSource,
          'EXIF'
        );
        await change(member, uploadPhoto, unrelated).expect(200);
        await change(member, uploadPhoto, null).expect(200);
        page = (await member.agent.get(memories()).expect(200))
          .body as MemoryPage;
        assert.equal(
          page.items.find((i) => i.photo.id === uploadPhoto)?.dateSource,
          'UPLOAD'
        );
        await change(owner, ownPhoto, '1800-01-01').expect(200);
        await change(owner, ownPhoto, null).expect(200);
        await change(member, recentPhoto, initial.asOf).expect(200);
      }
    );

    await t.test(
      'hiding/restoring is personal, idempotent under parallel requests, and spans all dates',
      async () => {
        const hide = (who: typeof owner, id: string, groupId = g) =>
          mutate(who.agent.put(`${memories(groupId)}/${id}/hidden`));
        const show = (who: typeof owner, id: string, groupId = g) =>
          mutate(who.agent.delete(`${memories(groupId)}/${id}/hidden`));
        await mutate(api.put(`${memories()}/${userPhoto}/hidden`)).expect(401);
        await hide(outsider, userPhoto).expect(404);
        await hide(member, foreignPhoto).expect(404);
        await hide(member, userPhoto, otherGroup).expect(404);
        await hide(member, userPhoto).send({ userId: owner.id }).expect(400);
        await Promise.all([
          hide(member, userPhoto).expect(204),
          hide(member, userPhoto).expect(204),
        ]);
        await hide(member, unrelatedPhoto).expect(204);
        await hide(member, recentPhoto).expect(204);
        const own = (await member.agent.get(memories()).expect(200))
          .body as MemoryPage;
        assert.equal(
          own.items.some((i) => i.photo.id === userPhoto),
          false
        );
        const other = (await owner.agent.get(memories()).expect(200))
          .body as MemoryPage;
        assert.equal(
          other.items.some((i) => i.photo.id === userPhoto),
          true
        );
        const hidden = (
          await member.agent.get(`${memories()}?kind=hidden`).expect(200)
        ).body as MemoryPage;
        assert.deepEqual(
          new Set(hidden.items.map((i) => i.photo.id)),
          new Set([userPhoto, unrelatedPhoto, recentPhoto])
        );
        assert.equal(
          (await owner.agent.get(`${memories()}?kind=hidden`).expect(200)).body
            .items.length,
          0
        );
        const hiddenIds: string[] = [];
        let hiddenCursor: string | null = null;
        do {
          const hiddenPage = (
            await member.agent
              .get(
                `${memories()}?kind=hidden&limit=1${hiddenCursor ? `&cursor=${hiddenCursor}` : ''}`
              )
              .expect(200)
          ).body as MemoryPage;
          assert.equal(hiddenPage.items.length, 1);
          assert.ok(!hiddenIds.includes(hiddenPage.items[0].photo.id));
          hiddenIds.push(hiddenPage.items[0].photo.id);
          hiddenCursor = hiddenPage.nextCursor;
          assert.ok(hiddenIds.length <= 3);
        } while (hiddenCursor);
        assert.deepEqual(
          hiddenIds,
          hidden.items.map((i) => i.photo.id)
        );
        await Promise.all([
          show(member, userPhoto).expect(204),
          show(member, userPhoto).expect(204),
        ]);
        assert.ok(
          (
            (await member.agent.get(memories()).expect(200)).body
              .items as MemoryItem[]
          ).some((i) => i.photo.id === userPhoto)
        );
        await show(member, unrelatedPhoto).expect(204);
        await show(member, recentPhoto).expect(204);
        assert.equal(
          (await member.agent.get(`${memories()}?kind=hidden`).expect(200)).body
            .items.length,
          0
        );
      }
    );

    await t.test(
      'deleted photos/albums/groups are excluded and cannot be hidden or date-edited',
      async () => {
        const hiddenAlbum = await album(g, '삭제할 앨범');
        const hiddenPhoto = await photo({
          albumId: hiddenAlbum,
          exifDate: past,
        });
        await mutate(
          member.agent.put(`${memories()}/${hiddenPhoto}/hidden`)
        ).expect(204);
        await mutate(
          owner.agent.delete(`/v1/groups/${g}/albums/${hiddenAlbum}`)
        ).expect(204);
        assert.equal(
          (
            (await member.agent.get(`${memories()}?kind=hidden`).expect(200))
              .body.items as MemoryItem[]
          ).some((i) => i.photo.id === hiddenPhoto),
          false
        );
        await mutate(
          member.agent.patch(
            `${path(g, hiddenAlbum, hiddenPhoto)}/capture-date`
          )
        )
          .send({ date: past })
          .expect(404);
        await mutate(
          member.agent.delete(`${memories()}/${hiddenPhoto}/hidden`)
        ).expect(404);
        const deletedPhoto = await photo({ exifDate: past });
        await mutate(member.agent.delete(path(g, a, deletedPhoto))).expect(204);
        assert.equal(
          (
            (await member.agent.get(memories()).expect(200)).body
              .items as MemoryItem[]
          ).some((i) => i.photo.id === deletedPhoto),
          false
        );
        await mutate(
          member.agent.put(`${memories()}/${deletedPhoto}/hidden`)
        ).expect(404);
        await mutate(
          member.agent.patch(`${path(g, a, deletedPhoto)}/capture-date`)
        )
          .send({ date: past })
          .expect(404);
        await mutate(owner.agent.delete(`/v1/groups/${otherGroup}`))
          .send({ name: '다른 그룹' })
          .expect(202);
        await owner.agent.get(memories(otherGroup)).expect(404);
        await mutate(
          owner.agent.patch(
            `${path(otherGroup, otherAlbum, foreignPhoto)}/capture-date`
          )
        )
          .send({ date: past })
          .expect(404);
      }
    );

    await t.test(
      'parallel deletion and capture-date changes serialize without reviving deleted content',
      async () => {
        const racePhoto = await photo({ exifDate: past });
        const results = await Promise.all([
          mutate(owner.agent.delete(path(g, a, racePhoto))),
          mutate(
            member.agent.patch(`${path(g, a, racePhoto)}/capture-date`)
          ).send({ date: monthly }),
          mutate(member.agent.put(`${memories()}/${racePhoto}/hidden`)),
        ]);
        assert.equal(results[0].status, 204);
        assert.ok(
          [200, 404].includes(results[1].status),
          `Date update returned ${results[1].status}`
        );
        assert.ok(
          [204, 404].includes(results[2].status),
          `Hide returned ${results[2].status}`
        );
        for (const kind of ['today', 'month', 'hidden']) {
          const page = (
            await member.agent.get(`${memories()}?kind=${kind}`).expect(200)
          ).body as MemoryPage;
          assert.equal(
            page.items.some((i) => i.photo.id === racePhoto),
            false
          );
        }
        const persisted = (
          await admin.query(
            'SELECT status,"deletedAt" FROM woori.photos WHERE id=$1',
            [racePhoto]
          )
        ).rows[0];
        assert.equal(persisted.status, 'DELETING');
        assert.ok(persisted.deletedAt);
      }
    );

    await t.test(
      'backfill keeps concurrent manual edits and cannot publish metadata after photo deletion',
      async () => {
        const backfill = new PhotoDateBackfillRepository(
          app.get(PrismaService)
        );
        const candidate = async () => {
          const id = await photo();
          const objectKey = `photos/${id}/fixture/original`;
          await admin.query(
            'INSERT INTO woori.photo_variants(id,"photoId",kind,"objectKey",mime,width,height,bytes) VALUES($1,$2,\'original\',$3,\'image/jpeg\',1,1,1)',
            [randomUUID(), id, objectKey]
          );
          return { id, groupId: g, albumId: a, objectKey, bytes: 1n };
        };
        const concurrent = await candidate();
        assert.equal(await backfill.eligible(concurrent), true);
        assert.ok(
          (await backfill.candidates(100)).some((p) => p.id === concurrent.id)
        );
        const result = await Promise.all([
          backfill.save(concurrent, new Date(`${past}T00:00:00+09:00`)),
          mutate(
            member.agent.patch(`${path(g, a, concurrent.id)}/capture-date`)
          )
            .send({ date: monthly })
            .expect(200),
        ]);
        assert.equal(result[0], true);
        const stored = (
          await admin.query(
            'SELECT "manualCapturedDate"::text AS manual,"capturedAt","captureDateSource","captureMetadataCheckedAt" FROM woori.photos WHERE id=$1',
            [concurrent.id]
          )
        ).rows[0];
        assert.equal(stored.manual, monthly);
        assert.equal(
          stored.capturedAt.toISOString(),
          new Date(`${past}T00:00:00+09:00`).toISOString()
        );
        assert.equal(stored.captureDateSource, 'EXIF');
        assert.ok(stored.captureMetadataCheckedAt);
        assert.equal(await backfill.eligible(concurrent), false);
        assert.equal(await backfill.save(concurrent, null), false);
        const page = (
          await member.agent.get(`${memories()}?kind=month`).expect(200)
        ).body as MemoryPage;
        assert.equal(
          page.items.find((p) => p.photo.id === concurrent.id)?.dateSource,
          'USER'
        );
        const removed = await candidate();
        assert.equal(await backfill.eligible(removed), true);
        await mutate(owner.agent.delete(path(g, a, removed.id))).expect(204);
        assert.equal(await backfill.eligible(removed), false);
        assert.equal(
          await backfill.save(removed, new Date(`${past}T00:00:00+09:00`)),
          false
        );
        assert.equal(
          (
            await admin.query(
              'SELECT "captureMetadataCheckedAt" FROM woori.photos WHERE id=$1',
              [removed.id]
            )
          ).rows[0].captureMetadataCheckedAt,
          null
        );
      }
    );

    await t.test(
      'leaving or removal revokes memories, hidden lists, and uploader date permissions immediately',
      async () => {
        await mutate(
          member.agent.put(`${memories()}/${userPhoto}/hidden`)
        ).expect(204);
        await mutate(member.agent.post(`/v1/groups/${g}/leave`)).expect(204);
        for (const kind of ['today', 'month', 'hidden'])
          await member.agent.get(`${memories()}?kind=${kind}`).expect(404);
        await mutate(
          member.agent.patch(`${path(g, a, userPhoto)}/capture-date`)
        )
          .send({ date: past })
          .expect(404);
        await mutate(
          member.agent.put(`${memories()}/${userPhoto}/hidden`)
        ).expect(404);
        await mutate(
          member.agent.delete(`${memories()}/${userPhoto}/hidden`)
        ).expect(404);
        assert.ok(
          (
            (await owner.agent.get(memories()).expect(200)).body
              .items as MemoryItem[]
          ).some((i) => i.photo.id === userPhoto)
        );
        await join(g);
        await mutate(
          owner.agent.delete(`/v1/groups/${g}/members/${member.id}`)
        ).expect(204);
        await member.agent.get(memories()).expect(404);
        await member.agent.get(`${memories()}?kind=hidden`).expect(404);
        await mutate(
          member.agent.patch(`${path(g, a, userPhoto)}/capture-date`)
        )
          .send({ date: past })
          .expect(404);
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
