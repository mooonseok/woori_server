import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { createToken, hashToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';
import { InvitationsRepository } from '../src/domain/invitations/invitations.repository';
import { hashInvitation } from '../src/domain/invitations/invitation-policy';

// Mutations are permitted only in the disposable database created by the
// existing local integration runner. Never accept the development DB itself.
function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  assert.notEqual(process.env.NODE_ENV, 'production');
  return url.toString();
}
type Agent = ReturnType<typeof request.agent>;
type Album = {
  id: string;
  groupId: string;
  title: string;
  createdAt: string;
  photoCount: number;
  videoCount: number;
  coverPhotoId: string | null;
  coverMediaKind: string | null;
  startDate: string | null;
  endDate: string | null;
  canManage: boolean;
};
type Page = { albums: Album[]; nextCursor: string | null };

test('isolated PostgreSQL: album list pages and per-viewer date ranges (W07-2)', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
    max: 2,
  });
  const app = await createApp();
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  const suffix = randomBytes(4).toString('hex');
  try {
    await app.listen(0, '127.0.0.1');
    const passwordHash = await hashPassword('album-integration-password-2026');
    // Repository fixtures keep this suite off the shared IP signup quota.
    const account = async (label: string) => {
      const agent = request.agent(app.getHttpServer());
      const token = createToken();
      const user = await app.get(AuthRepository).createUser(
        {
          username: `${label}_${suffix}`,
          email: `${label}_${suffix}@example.test`,
          displayName: label,
          passwordHash,
          verifiedAt: new Date(),
        },
        hashToken(token)
      );
      agent.set('Cookie', `woori_session=${token}`);
      return { agent, id: user.id };
    };
    const owner = await account('album_owner'),
      member = await account('album_member'),
      outsider = await account('album_outsider');
    const group = async (name: string) => {
      const id = (
        await mutate(owner.agent.post('/v1/groups')).send({ name }).expect(201)
      ).body.group.id as string;
      const invitation = (
        await mutate(owner.agent.post(`/v1/groups/${id}/invitations`))
          .send({ maxUses: 5 })
          .expect(201)
      ).body;
      await app
        .get(InvitationsRepository)
        .join({ codeHash: hashInvitation(invitation.code) }, member.id);
      return id;
    };
    const paged = await group('앨범 페이지');
    const dated = await group('앨범 기간');
    const base = (groupId: string) => `/v1/groups/${groupId}/albums`;
    const page = async (
      agent: Agent,
      groupId: string,
      query: Record<string, string | number> = {}
    ) => (await agent.get(base(groupId)).query(query).expect(200)).body as Page;
    const insertAlbum = async (
      groupId: string,
      createdAt: Date,
      id = randomUUID()
    ) => {
      await admin.query(
        'INSERT INTO woori.albums (id,"groupId","creatorId",title,"createdAt") VALUES ($1,$2,$3,$4,$5)',
        [id, groupId, owner.id, `앨범 ${id.slice(0, 8)}`, createdAt]
      );
      return id;
    };
    const expectedOrder = async (groupId: string) =>
      (
        await admin.query(
          'SELECT id FROM woori.albums WHERE "groupId"=$1 AND "deletedAt" IS NULL ORDER BY "createdAt" DESC,id DESC',
          [groupId]
        )
      ).rows.map((row) => row.id as string);
    const walk = async (agent: Agent, groupId: string) => {
      const ids: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const body: Page = await page(agent, groupId, cursor ? { cursor } : {});
        ids.push(...body.albums.map((album) => album.id));
        sizes.push(body.albums.length);
        cursor = body.nextCursor;
      } while (cursor);
      return { ids, sizes };
    };

    // 61 albums: more than the old silent 50 cap; five share one creation time
    // so the id tie-break is exercised.
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    for (let index = 0; index < 61; index++)
      await insertAlbum(
        paged,
        new Date(start + (index >= 20 && index < 25 ? 20 : index) * 60_000)
      );

    await t.test(
      'pages of 30 (default) reach every album newest first with id tie-breaks',
      async () => {
        const expected = await expectedOrder(paged);
        assert.equal(expected.length, 61);
        const first = await page(owner.agent, paged);
        assert.equal(first.albums.length, 30);
        assert.equal(first.nextCursor, first.albums[29].id);
        const all = await walk(owner.agent, paged);
        assert.deepEqual(all.sizes, [30, 30, 1]);
        assert.deepEqual(all.ids, expected);
        const fifty = await page(owner.agent, paged, { limit: 50 });
        assert.equal(fifty.albums.length, 50);
        assert.deepEqual(
          fifty.albums.map((album) => album.id),
          expected.slice(0, 50)
        );
        const rest = await page(owner.agent, paged, {
          limit: 50,
          cursor: fifty.nextCursor!,
        });
        assert.deepEqual(
          rest.albums.map((album) => album.id),
          expected.slice(50)
        );
        assert.equal(rest.nextCursor, null);
        // Members page the same albums; only the owner can manage them.
        const memberAll = await walk(member.agent, paged);
        assert.deepEqual(memberAll.ids, expected);
        assert.equal(first.albums[0].canManage, true);
        assert.equal(
          (await page(member.agent, paged)).albums[0].canManage,
          false
        );
        for (const limit of [0, 51, 'x'])
          await owner.agent.get(base(paged)).query({ limit }).expect(400);
      }
    );

    await t.test(
      'a cursor stays stable while albums are added or removed elsewhere',
      async () => {
        const before = await expectedOrder(paged);
        const first = await page(owner.agent, paged);
        // New albums (API and direct) are newer than every cursor, and an
        // album on a later page goes away meanwhile.
        const created = (
          await mutate(owner.agent.post(base(paged)))
            .send({ title: '방금 만든 앨범' })
            .expect(201)
        ).body.album as Album;
        const inserted = await insertAlbum(paged, new Date());
        const removed = before[45];
        await mutate(owner.agent.delete(`${base(paged)}/${removed}`)).expect(
          204
        );
        const second = await page(owner.agent, paged, {
          cursor: first.nextCursor!,
        });
        assert.deepEqual(
          second.albums.map((album) => album.id),
          before
            .slice(30, 61)
            .filter((id) => id !== removed)
            .slice(0, 30)
        );
        const rest = second.nextCursor
          ? (await page(owner.agent, paged, { cursor: second.nextCursor }))
              .albums
          : [];
        const seen = [
          ...first.albums.map((album) => album.id),
          ...second.albums.map((album) => album.id),
          ...rest.map((album) => album.id),
        ];
        assert.equal(new Set(seen).size, seen.length, 'No album repeats');
        assert.deepEqual(
          seen,
          before.filter((id) => id !== removed)
        );
        // A fresh first page shows the new albums on top.
        const fresh = (await page(owner.agent, paged)).albums.map(
          (album) => album.id
        );
        assert.deepEqual(
          fresh.slice(0, 2).sort(),
          [created.id, inserted].sort()
        );
      }
    );

    await t.test(
      'malformed, unknown, foreign or stale cursors are 400 ALBUM_CURSOR_INVALID',
      async () => {
        const otherGroupAlbum = await insertAlbum(dated, new Date());
        const stale = await insertAlbum(paged, new Date(start - 60_000));
        await mutate(owner.agent.delete(`${base(paged)}/${stale}`)).expect(204);
        for (const query of [
          'cursor=not-a-uuid',
          'cursor=',
          `cursor=${randomUUID()}`,
          `cursor=${otherGroupAlbum}`,
          `cursor=${stale}`,
          `cursor=${stale.toUpperCase()}x`,
          `cursor=${otherGroupAlbum}&cursor=${otherGroupAlbum}`,
        ]) {
          const response = await owner.agent
            .get(`${base(paged)}?${query}`)
            .expect(400);
          assert.equal(response.body.code, 'ALBUM_CURSOR_INVALID', query);
          assert.match(response.body.code, /_CURSOR_INVALID$/);
        }
        await mutate(
          owner.agent.delete(`${base(dated)}/${otherGroupAlbum}`)
        ).expect(204);
        // Membership is checked first: outsiders learn nothing from cursors.
        const valid = (await page(owner.agent, paged)).nextCursor!;
        for (const cursor of [valid, 'not-a-uuid']) {
          const response = await outsider.agent
            .get(base(paged))
            .query({ cursor })
            .expect(404);
          assert.equal(response.body.code, 'GROUP_NOT_FOUND');
        }
        await owner.agent.get(base(paged)).query({ after: valid }).expect(400);
      }
    );

    const photo = async (
      albumId: string,
      uploaderId: string,
      values: {
        createdAt: string;
        capturedAt?: string | null;
        manual?: string | null;
        status?: string;
        deleted?: boolean;
      }
    ) => {
      const id = randomUUID();
      await admin.query(
        'INSERT INTO woori.photos (id,"groupId","albumId","uploaderId",status,width,height,bytes,"createdAt","capturedAt","manualCapturedDate","deletedAt") VALUES ($1,$2,$3,$4,$5,10,10,1,$6,$7,$8,$9)',
        [
          id,
          dated,
          albumId,
          uploaderId,
          values.status ?? 'READY',
          values.createdAt,
          values.capturedAt ?? null,
          values.manual ?? null,
          values.deleted ? new Date() : null,
        ]
      );
      return id;
    };
    const albumFor = async (agent: Agent, albumId: string) => {
      let cursor: string | null = null;
      do {
        const body: Page = await page(agent, dated, cursor ? { cursor } : {});
        const found = body.albums.find((album) => album.id === albumId);
        if (found) return found;
        cursor = body.nextCursor;
      } while (cursor);
      return undefined;
    };
    const range = (album: Album | undefined) =>
      album && [album.startDate, album.endDate, album.photoCount];

    await t.test(
      'the range uses manual -> EXIF -> upload dates as Korea calendar dates',
      async () => {
        const sources = (
          await mutate(owner.agent.post(base(dated)))
            .send({ title: '출처' })
            .expect(201)
        ).body.album as Album;
        assert.equal(sources.startDate, null);
        assert.equal(sources.endDate, null);
        // Manual wins over its EXIF (2010), EXIF wins over its upload (2024),
        // upload is the fallback.
        await photo(sources.id, owner.id, {
          createdAt: '2023-01-01T00:00:00Z',
          capturedAt: '2010-01-01T00:00:00Z',
          manual: '2020-01-02',
        });
        const exif = await photo(sources.id, member.id, {
          createdAt: '2024-01-01T00:00:00Z',
          capturedAt: '2021-05-05T03:00:00Z',
        });
        await photo(sources.id, owner.id, {
          createdAt: '2022-07-07T01:00:00Z',
        });
        const listed = (await albumFor(owner.agent, sources.id))!;
        assert.deepEqual(range(listed), ['2020-01-02', '2022-07-07', 3]);
        assert.equal(listed.coverPhotoId, exif);
        assert.equal(listed.coverMediaKind, 'PHOTO');
        // Rename responses carry the same fields.
        const renamed = (
          await mutate(owner.agent.patch(`${base(dated)}/${sources.id}`))
            .send({ title: '출처 바뀜' })
            .expect(200)
        ).body.album as Album;
        assert.deepEqual(Object.keys(renamed).sort(), [
          'canManage',
          'coverMediaKind',
          'coverPhotoId',
          'createdAt',
          'endDate',
          'groupId',
          'id',
          'photoCount',
          'startDate',
          'title',
          'videoCount',
        ]);
        assert.deepEqual(range(renamed), ['2020-01-02', '2022-07-07', 3]);
        assert.equal(renamed.coverPhotoId, exif);

        // KST midnight: 14:59:59.999Z is still the 15th in Korea, 15:00Z the 16th.
        const midnight = (
          await mutate(owner.agent.post(base(dated)))
            .send({ title: '자정' })
            .expect(201)
        ).body.album as Album;
        await photo(midnight.id, owner.id, {
          createdAt: '2026-10-16T00:00:00Z',
          capturedAt: '2026-10-15T14:59:59.999Z',
        });
        await photo(midnight.id, owner.id, {
          createdAt: '2026-10-15T15:00:00Z',
        });
        assert.deepEqual(range(await albumFor(owner.agent, midnight.id)), [
          '2026-10-15',
          '2026-10-16',
          2,
        ]);
        const single = (
          await mutate(owner.agent.post(base(dated)))
            .send({ title: '하루' })
            .expect(201)
        ).body.album as Album;
        await photo(single.id, owner.id, {
          createdAt: '2026-10-15T14:59:59Z',
        });
        assert.deepEqual(range(await albumFor(owner.agent, single.id)), [
          '2026-10-15',
          '2026-10-15',
          1,
        ]);
      }
    );

    await t.test(
      'hidden, deleted and unfinished photos never widen the range; empty is null',
      async () => {
        const mixed = (
          await mutate(owner.agent.post(base(dated)))
            .send({ title: '가시성' })
            .expect(201)
        ).body.album as Album;
        for (const status of ['PENDING', 'PROCESSING', 'FAILED'])
          await photo(mixed.id, owner.id, {
            createdAt: '1999-01-01T00:00:00Z',
            status,
          });
        await photo(mixed.id, owner.id, {
          createdAt: '1998-01-01T00:00:00Z',
          deleted: true,
        });
        const memberPhoto = await photo(mixed.id, member.id, {
          createdAt: '2026-01-01T00:00:00Z',
          capturedAt: '2001-01-01T00:00:00Z',
        });
        const ownerPhoto = await photo(mixed.id, owner.id, {
          createdAt: '2005-05-05T00:00:00Z',
        });
        const onlyMember = (
          await mutate(owner.agent.post(base(dated)))
            .send({ title: '회원 사진만' })
            .expect(201)
        ).body.album as Album;
        await photo(onlyMember.id, member.id, {
          createdAt: '2003-03-03T00:00:00Z',
        });
        const empty = (
          await mutate(owner.agent.post(base(dated)))
            .send({ title: '빈 앨범' })
            .expect(201)
        ).body.album as Album;
        assert.deepEqual(Object.keys(empty).sort(), [
          'canManage',
          'coverMediaKind',
          'coverPhotoId',
          'createdAt',
          'endDate',
          'groupId',
          'id',
          'photoCount',
          'startDate',
          'title',
          'videoCount',
        ]);
        assert.deepEqual(range(empty), [null, null, 0]);
        assert.equal(empty.coverMediaKind, null);
        assert.deepEqual(range(await albumFor(owner.agent, empty.id)), [
          null,
          null,
          0,
        ]);
        assert.equal(
          (await albumFor(owner.agent, empty.id))?.coverPhotoId,
          null
        );
        assert.deepEqual(range(await albumFor(owner.agent, mixed.id)), [
          '2001-01-01',
          '2005-05-05',
          2,
        ]);
        // The owner blocks the member: that member's photos leave the owner's
        // count, cover and range (and an album of only theirs reads empty);
        // the member, who blocked no one, still sees everything.
        await mutate(owner.agent.put(`/v1/blocks/${member.id}`)).expect(200);
        const blockedView = (await albumFor(owner.agent, mixed.id))!;
        assert.deepEqual(range(blockedView), ['2005-05-05', '2005-05-05', 1]);
        assert.equal(blockedView.coverPhotoId, ownerPhoto);
        const onlyMemberView = (await albumFor(owner.agent, onlyMember.id))!;
        assert.deepEqual(range(onlyMemberView), [null, null, 0]);
        assert.equal(onlyMemberView.coverPhotoId, null);
        const memberView = (await albumFor(member.agent, mixed.id))!;
        assert.deepEqual(range(memberView), ['2001-01-01', '2005-05-05', 2]);
        assert.equal(memberView.coverPhotoId, memberPhoto);
        await mutate(owner.agent.delete(`/v1/blocks/${member.id}`)).expect(204);
        assert.deepEqual(range(await albumFor(owner.agent, mixed.id)), [
          '2001-01-01',
          '2005-05-05',
          2,
        ]);
      }
    );

    await t.test(
      'one grouped statistics query per page is served by an existing photo index',
      async (explain) => {
        const ids = (
          await admin.query(
            'SELECT id FROM woori.albums WHERE "groupId"=$1 AND "deletedAt" IS NULL',
            [dated]
          )
        ).rows.map((row) => `'${row.id}'::uuid`);
        const sql = `SELECT p."albumId",COUNT(*) FROM woori.photos p WHERE p."groupId"='${dated}'::uuid AND p."albumId" IN (${ids.join(',')}) AND p.status='READY' AND p."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM woori.user_blocks ub WHERE ub."blockerId"='${owner.id}'::uuid AND ub."blockedId"=p."uploaderId") GROUP BY p."albumId"`;
        const client = await admin.connect();
        try {
          explain.diagnostic(
            `default: ${(await client.query(`EXPLAIN ${sql}`)).rows.map((r) => r['QUERY PLAN']).join(' | ')}`
          );
          await client.query('BEGIN');
          await client.query('SET LOCAL enable_seqscan = off');
          const forced = (await client.query(`EXPLAIN ${sql}`)).rows
            .map((r) => r['QUERY PLAN'])
            .join(' | ');
          explain.diagnostic(`forced: ${forced}`);
          // Index-backed (group/memory or album/status photo index): the page
          // aggregate needs no new index and never has to scan all photos.
          assert.match(
            forced,
            /Index (Only )?Scan using \S+ on photos p|Bitmap Index Scan on photos_/
          );
          assert.doesNotMatch(forced, /Seq Scan on photos/);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
