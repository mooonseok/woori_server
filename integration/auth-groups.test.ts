import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { Readable } from "node:stream";
import { rateLimitKey } from "../src/domain/auth/auth-rate-limit.service";
import { PhotosRepository } from "../src/domain/photos/photos.repository";
import { MediaStorageService } from "../src/common/media/media-storage.service";
import type { MediaVariant } from "../src/common/media/media-storage.service";
import { Pool } from "pg";
import request from "supertest";
import type { Test } from "supertest";
import { createApp } from "../src/bootstrap";
import { hashToken, sessionCookieName } from "../src/domain/auth/auth-token";

// This suite changes data. It is intentionally impossible to run against the
// development/production DB or a remote host, even if a URL is misconfigured.
function requireIsolatedDatabase(key: string): string {
  assert.equal(
    process.env.WOORI_INTEGRATION_TEST,
    "1",
    "Explicit integration-test opt-in is required",
  );
  const value = process.env[key];
  assert.ok(value, `${key} is required`);
  const url = new URL(value);
  assert.match(
    url.pathname,
    /^\/woori_test_[a-f0-9]{12}$/,
    "Integration tests require a disposable woori_test database",
  );
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "Integration tests must use a loopback PostgreSQL host",
  );
  return value;
}

test("real PostgreSQL: authentication, private groups and single-use invitation concurrency", async (t) => {
  requireIsolatedDatabase("DATABASE_URL");
  const admin = new Pool({
    connectionString: requireIsolatedDatabase("MIGRATION_DATABASE_URL"),
    max: 2,
  });
  assert.equal(
    process.env.MAIL_MODE,
    "file",
    "Integration tests never send real email",
  );
  assert.notEqual(process.env.NODE_ENV, "production");
  const mailDirectory = process.env.DEV_MAIL_DIR;
  assert.ok(mailDirectory, "A private temporary outbox directory is required");
  const origin = process.env.WEB_ORIGIN;
  assert.ok(origin);
  const app = await createApp();
  const password = "integration-only-password-2026";
  const suffix = randomBytes(5).toString("hex");
  const mutation = (operation: Test) =>
    operation.set("Origin", origin).set("X-Woori-Request", "1");
  type Agent = ReturnType<typeof request.agent>;
  type Account = {
    agent: Agent;
    id: string;
    username: string;
    email: string;
    cookie: string;
    verificationToken: string;
  };
  try {
    await app.listen(0, "127.0.0.1");
    const api = request(app.getHttpServer());
    const signup = async (name: string): Promise<Account> => {
      const agent = request.agent(app.getHttpServer());
      const username = `${name}_${suffix}`;
      const email = `${username}@example.test`;
      const response = await mutation(agent.post("/v1/auth/signup"))
        .send({ username, email, displayName: name, password })
        .expect(201);
      assert.equal(response.body.user.emailVerified, false);
      assert.equal(response.body.verificationDelivery, "sent");
      assert.equal(response.body.passwordHash, undefined);
      assert.equal(response.body.user.passwordHash, undefined);
      assert.equal(response.headers["cache-control"], "no-store");
      const cookies = response.headers["set-cookie"] as unknown as string[];
      const header = cookies.find((value) =>
        value.startsWith(`${sessionCookieName()}=`),
      );
      assert.ok(header, "Signup must set the session cookie");
      assert.match(header, /HttpOnly/i);
      assert.match(header, /SameSite=Lax/i);
      const cookie = header.split(";")[0];
      let verificationToken: string | undefined;
      for (const file of await readdir(mailDirectory)) {
        if (!file.endsWith(".json")) continue;
        const path = join(mailDirectory, file);
        const mail = JSON.parse(await readFile(path, "utf8")) as {
          to: string;
          text: string;
        };
        if (mail.to !== email) continue;
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const link = mail.text.match(/https?:\/\/[^\s]+/);
        assert.ok(link, "Verification mail must contain a link");
        verificationToken =
          new URL(link[0]).searchParams.get("token") ?? undefined;
      }
      assert.ok(
        verificationToken,
        "Verification token must be delivered only through the private outbox",
      );
      return {
        agent,
        id: response.body.user.id,
        username,
        email,
        cookie,
        verificationToken,
      };
    };
    const owner = await signup("owner");
    const memberA = await signup("member_a");
    const memberB = await signup("member_b");
    const unverified = await signup("new_family");
    const verify = async (account: Account) => {
      const response = await mutation(
        account.agent.post("/v1/auth/email-verification/confirm"),
      )
        .send({ token: account.verificationToken })
        .expect(200);
      assert.equal(response.body.user.emailVerified, true);
    };
    await t.test(
      "signup persists only password/session/token hashes; unverified users cannot create groups",
      async () => {
        const rows = await admin.query(
          'SELECT "passwordHash" FROM woori.users WHERE id=$1',
          [owner.id],
        );
        assert.match(rows.rows[0].passwordHash, /^scrypt\$131072\$8\$1\$/);
        const rawSession = owner.cookie.slice(owner.cookie.indexOf("=") + 1);
        const sessions = await admin.query(
          'SELECT "tokenHash" FROM woori.sessions WHERE "userId"=$1',
          [owner.id],
        );
        assert.equal(sessions.rows[0].tokenHash, hashToken(rawSession));
        const tokens = await admin.query(
          'SELECT "tokenHash" FROM woori.email_tokens WHERE "userId"=$1',
          [owner.id],
        );
        assert.equal(
          tokens.rows[0].tokenHash,
          hashToken(owner.verificationToken),
        );
        const response = await mutation(owner.agent.post("/v1/groups"))
          .send({ name: "가족 앨범" })
          .expect(403);
        assert.equal(response.body.code, "EMAIL_VERIFICATION_REQUIRED");
        await mutation(
          memberA.agent.post("/v1/auth/email-verification/confirm"),
        )
          .send({ token: owner.verificationToken })
          .expect(400);
        await verify(owner);
        await mutation(owner.agent.post("/v1/auth/email-verification/confirm"))
          .send({ token: owner.verificationToken })
          .expect(400);
        await verify(memberA);
        await verify(memberB);
      },
    );
    let groupId = "";
    let invitation: { id: string; code: string; url: string };
    await t.test(
      "only members can read groups and only the owner can issue invitations",
      async () => {
        const created = await mutation(owner.agent.post("/v1/groups"))
          .send({ name: "통합검증 가족" })
          .expect(201);
        groupId = created.body.group.id;
        assert.equal(created.body.group.role, "OWNER");
        assert.equal(created.body.group.members, 1);
        const mine = await owner.agent.get("/v1/groups").expect(200);
        assert.equal(
          mine.body.groups.some(
            (group: { id: string }) => group.id === groupId,
          ),
          true,
        );
        assert.deepEqual(
          (await memberA.agent.get("/v1/groups").expect(200)).body.groups,
          [],
        );
        await memberA.agent.get(`/v1/groups/${groupId}`).expect(404);
        await api.get(`/v1/groups/${groupId}`).expect(401);
        await mutation(memberA.agent.post(`/v1/groups/${groupId}/invitations`))
          .send({ maxUses: 1 })
          .expect(404);
        const response = await mutation(
          owner.agent.post(`/v1/groups/${groupId}/invitations`),
        )
          .send({ maxUses: 1 })
          .expect(201);
        invitation = response.body;
        assert.match(invitation.code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
        const rawToken = new URL(invitation.url).searchParams.get("token");
        assert.ok(rawToken);
        const saved = await admin.query(
          'SELECT "tokenHash", "codeHash" FROM woori.invitations WHERE id=$1',
          [invitation.id],
        );
        assert.equal(saved.rows[0].tokenHash, hashToken(rawToken));
        assert.equal(saved.rows[0].codeHash, hashToken(invitation.code));
        const preview = await mutation(api.post("/v1/invitations/preview"))
          .send({ token: rawToken })
          .expect(200);
        assert.deepEqual(Object.keys(preview.body).sort(), [
          "expiresAt",
          "groupName",
        ]);
        const listed = await owner.agent
          .get(`/v1/groups/${groupId}/invitations`)
          .expect(200);
        assert.equal(listed.body.invitations[0].code, undefined);
        assert.equal(listed.body.invitations[0].tokenHash, undefined);
        await mutation(unverified.agent.post("/v1/invitations/join"))
          .send({ code: invitation.code })
          .expect(403);
      },
    );
    let winner: Account;
    let loser: Account;
    await t.test(
      "concurrent joins cannot exceed maxUses and the successful join is idempotent",
      async () => {
        const outcomes = await Promise.all(
          [memberA, memberB].map((account) =>
            mutation(account.agent.post("/v1/invitations/join")).send({
              code: invitation.code,
            }),
          ),
        );
        assert.deepEqual(
          outcomes.map((response) => response.status).sort(),
          [200, 410],
        );
        winner = outcomes[0].status === 200 ? memberA : memberB;
        loser = winner === memberA ? memberB : memberA;
        const repeat = await mutation(winner.agent.post("/v1/invitations/join"))
          .send({ code: invitation.code })
          .expect(200);
        assert.equal(repeat.body.alreadyMember, true);
        const count = await admin.query(
          'SELECT "useCount" FROM woori.invitations WHERE id=$1',
          [invitation.id],
        );
        assert.equal(count.rows[0].useCount, 1);
        await winner.agent.get(`/v1/groups/${groupId}`).expect(200);
        await loser.agent.get(`/v1/groups/${groupId}`).expect(404);
        await mutation(winner.agent.post(`/v1/groups/${groupId}/invitations`))
          .send({})
          .expect(404);
        await winner.agent.get(`/v1/groups/${groupId}/invitations`).expect(404);
        await mutation(
          winner.agent.delete(
            `/v1/groups/${groupId}/invitations/${invitation.id}`,
          ),
        ).expect(404);
      },
    );
    await t.test(
      "revoked and expired invitations fail; removed membership cannot rejoin",
      async () => {
        const make = async () =>
          (
            await mutation(
              owner.agent.post(`/v1/groups/${groupId}/invitations`),
            )
              .send({ maxUses: 10 })
              .expect(201)
          ).body;
        const revoked = await make();
        await mutation(
          owner.agent.delete(`/v1/groups/${groupId}/invitations/${revoked.id}`),
        ).expect(204);
        await mutation(loser.agent.post("/v1/invitations/join"))
          .send({ code: revoked.code })
          .expect(410);
        await mutation(api.post("/v1/invitations/preview"))
          .send({ code: revoked.code })
          .expect(410);
        const expired = await make();
        await admin.query(
          "UPDATE woori.invitations SET \"expiresAt\" = now() - interval '1 second' WHERE id=$1",
          [expired.id],
        );
        await mutation(loser.agent.post("/v1/invitations/join"))
          .send({ code: expired.code })
          .expect(410);
        const valid = await make();
        await admin.query(
          'UPDATE woori.memberships SET status=\'REMOVED\' WHERE "groupId"=$1 AND "userId"=$2',
          [groupId, winner.id],
        );
        await winner.agent.get(`/v1/groups/${groupId}`).expect(404);
        const denied = await mutation(winner.agent.post("/v1/invitations/join"))
          .send({ code: valid.code })
          .expect(403);
        assert.equal(denied.body.code, "GROUP_JOIN_NOT_ALLOWED");
      },
    );
    await t.test(
      "albums and media enforce current membership, quotas, completion fencing and private reads",
      async () => {
        // Override only this in-process application's storage methods. No runtime fake-storage option exists.
        const storage = app.get(MediaStorageService);
        const objects = new Map<string, Buffer>();
        const staged = new Map<string, string>();
        let configured = false;
        let processCalls = 0;
        Object.assign(storage, {
          enabled: () => configured,
          presign: async (key: string, mime: string) => {
            const id = key.split("/")[1];
            staged.set(id, key);
            return {
              uploadUrl: `https://upload.example.test/${id}`,
              headers: { "Content-Type": mime },
              expiresAt: new Date(Date.now() + 600_000),
            };
          },
          process: async (
            key: string,
            _mime: string,
            _bytes: number,
            prefix: string,
          ): Promise<MediaVariant[]> => {
            processCalls++;
            await new Promise((resolve) => setTimeout(resolve, 30));
            const bytes = objects.get(key);
            if (!bytes?.equals(Buffer.from("synthetic-valid-image")))
              throw new BadRequestException({ code: "INVALID_IMAGE" });
            return (["ORIGINAL", "DISPLAY", "THUMBNAIL"] as const).map(
              (kind) => {
                const objectKey = `${prefix}/${kind}`;
                objects.set(objectKey, Buffer.from("decoded-image"));
                return {
                  kind,
                  objectKey,
                  mime: "image/png",
                  width: 10,
                  height: 10,
                  bytes: 13,
                };
              },
            );
          },
          read: async (key: string) => {
            const bytes = objects.get(key)!;
            return {
              body: Readable.from(bytes),
              contentType: "image/png",
              byteSize: bytes.length,
            };
          },
          cleanup: async (keys: string[]) => {
            for (const key of keys) objects.delete(key);
          },
        });
        const base = `/v1/groups/${groupId}/albums`;
        await mutation(loser.agent.post(base))
          .send({ title: "거부" })
          .expect(404);
        await mutation(owner.agent.post(base))
          .send({ title: "   " })
          .expect(400);
        const created = await mutation(owner.agent.post(base))
          .send({ title: "  새 앨범  " })
          .expect(201);
        const albumId = created.body.album.id;
        assert.equal(created.body.album.title, "새 앨범");
        assert.equal(created.body.album.photoCount, 0);
        assert.equal(created.body.album.coverPhotoId, null);
        const album = `${base}/${albumId}`;
        const payload = {
          filename: "sample.png",
          contentType: "image/png",
          bytes: 21,
        };
        await mutation(owner.agent.post(`${album}/uploads`))
          .send(payload)
          .expect(503);
        configured = true;
        await mutation(owner.agent.post(`${album}/uploads`))
          .send({ ...payload, contentType: "image/svg+xml" })
          .expect(400);
        await mutation(owner.agent.post(`${album}/uploads`))
          .send({ ...payload, bytes: 30 * 1024 * 1024 + 1 })
          .expect(400);
        await mutation(loser.agent.post(`${album}/uploads`))
          .send(payload)
          .expect(404);
        const otherGroup = (
          await mutation(owner.agent.post("/v1/groups"))
            .send({ name: "다른 가족" })
            .expect(201)
        ).body.group.id;
        await owner.agent
          .get(`/v1/groups/${otherGroup}/albums/${albumId}/photos`)
          .expect(404);
        const upload = async (valid = true) => {
          const ticket = (
            await mutation(owner.agent.post(`${album}/uploads`))
              .send(payload)
              .expect(201)
          ).body;
          const key = staged.get(new URL(ticket.uploadUrl).pathname.slice(1))!;
          objects.set(
            key,
            Buffer.from(valid ? "synthetic-valid-image" : "not-an-image"),
          );
          assert.equal(ticket.objectKey, undefined);
          return ticket;
        };
        const bad = await upload(false);
        await mutation(
          owner.agent.post(`${album}/photos/${bad.photoId}/complete`),
        ).expect(400);
        const failed = await admin.query(
          'SELECT status,"reservedBytes" FROM woori.photos WHERE id=$1',
          [bad.photoId],
        );
        assert.equal(failed.rows[0].status, "FAILED");
        assert.equal(failed.rows[0].reservedBytes, "0");
        const ticket = await upload();
        const complete = `${album}/photos/${ticket.photoId}/complete`;
        await mutation(loser.agent.post(complete)).expect(404);
        const results = await Promise.all([
          mutation(owner.agent.post(complete)),
          mutation(owner.agent.post(complete)),
        ]);
        assert.equal(
          results.filter((result) => result.status === 200).length >= 1,
          true,
          JSON.stringify(
            results.map((r) => ({ status: r.status, body: r.body })),
          ),
        );
        assert.equal(
          results.every((result) => [200, 409].includes(result.status)),
          true,
        );
        const repeated = await mutation(owner.agent.post(complete)).expect(200);
        assert.equal(repeated.body.photo.status, "READY");
        assert.equal(repeated.body.photo.stagingKey, undefined);
        assert.equal(repeated.body.photo.variants, undefined);
        assert.equal(
          processCalls,
          2,
          "Invalid and valid image each process once; repeated completion does not process again",
        );
        const usage = await admin.query(
          'SELECT "usedBytes" FROM woori.groups WHERE id=$1',
          [groupId],
        );
        assert.equal(usage.rows[0].usedBytes, "39");
        const listing = await owner.agent
          .get(`${album}/photos?limit=1`)
          .expect(200);
        assert.equal(listing.body.photos.length, 1);
        assert.equal(listing.body.nextCursor, null);
        const albums = await owner.agent.get(base).expect(200);
        assert.equal(albums.body.albums[0].photoCount, 1);
        assert.equal(albums.body.albums[0].coverPhotoId, ticket.photoId);
        const content = `${album}/photos/${ticket.photoId}/content?variant=thumbnail`;
        const image = await owner.agent.get(content).expect(200);
        assert.equal(image.headers["cache-control"], "private, no-store");
        assert.equal(image.headers["content-type"], "image/png");
        await loser.agent.get(content).expect(404);
        await api.get(content).expect(401);
        await admin.query(
          'UPDATE woori.memberships SET status=\'REMOVED\' WHERE "groupId"=$1 AND "userId"=$2',
          [groupId, owner.id],
        );
        await owner.agent.get(content).expect(404);
        await owner.agent.get(`${album}/photos`).expect(404);
        await mutation(owner.agent.post(complete)).expect(404);
        await admin.query(
          'UPDATE woori.memberships SET status=\'ACTIVE\' WHERE "groupId"=$1 AND "userId"=$2',
          [groupId, owner.id],
        );
        await admin.query(
          'UPDATE woori.groups SET "quotaBytes"=40 WHERE id=$1',
          [groupId],
        );
        const quota = await mutation(owner.agent.post(`${album}/uploads`))
          .send(payload)
          .expect(409);
        assert.equal(quota.body.code, "STORAGE_QUOTA_EXCEEDED");
        await admin.query(
          'UPDATE woori.groups SET "quotaBytes"=21474836480 WHERE id=$1',
          [groupId],
        );
        // An active member cannot complete another member's upload.
        await admin.query(
          'UPDATE woori.memberships SET status=\'ACTIVE\' WHERE "groupId"=$1 AND "userId"=$2',
          [groupId, winner.id],
        );
        await mutation(winner.agent.post(complete)).expect(404);
        await admin.query(
          'UPDATE woori.memberships SET status=\'REMOVED\' WHERE "groupId"=$1 AND "userId"=$2',
          [groupId, winner.id],
        );
        // Fence expired processing attempts even before a replacement attempt exists.
        const fenced = await upload();
        const repository = app.get(PhotosRepository);
        const first = await repository.claim(
          groupId,
          albumId,
          fenced.photoId,
          owner.id,
        );
        assert.equal(first.ready, false);
        if (first.ready) throw new Error("Expected processing claim");
        const variants = await storage.process(
          first.photo.stagingKey!,
          first.photo.uploadMime!,
          Number(first.photo.uploadBytes),
          `photos/${fenced.photoId}/${first.token}`,
        );
        await admin.query(
          "UPDATE woori.photos SET \"processingUntil\"=now()-interval '1 second' WHERE id=$1",
          [fenced.photoId],
        );
        await assert.rejects(
          () =>
            repository.finish(
              groupId,
              albumId,
              fenced.photoId,
              owner.id,
              first.token,
              variants,
            ),
          { status: 409 },
        );
        const second = await repository.claim(
          groupId,
          albumId,
          fenced.photoId,
          owner.id,
        );
        assert.equal(second.ready, false);
        if (second.ready)
          throw new Error("Expected replacement processing claim");
        await assert.rejects(
          () =>
            repository.finish(
              groupId,
              albumId,
              fenced.photoId,
              owner.id,
              first.token,
              variants,
            ),
          { status: 409 },
        );
        const secondVariants = await storage.process(
          second.photo.stagingKey!,
          second.photo.uploadMime!,
          Number(second.photo.uploadBytes),
          `photos/${fenced.photoId}/${second.token}`,
        );
        await repository.finish(
          groupId,
          albumId,
          fenced.photoId,
          owner.id,
          second.token,
          secondVariants,
        );
        await storage.cleanup(variants.map((v) => v.objectKey));
        assert.ok(secondVariants.every((v) => objects.has(v.objectKey)));
        const page1 = (
          await owner.agent.get(`${album}/photos?limit=1`).expect(200)
        ).body;
        assert.ok(page1.nextCursor);
        const page2 = (
          await owner.agent
            .get(`${album}/photos?limit=1&cursor=${page1.nextCursor}`)
            .expect(200)
        ).body;
        assert.equal(page2.photos.length, 1);
        assert.equal(page2.nextCursor, null);
        assert.notEqual(page1.photos[0].id, page2.photos[0].id);
        // Revocation during slow storage work is checked again before publication and delivery.
        const interrupted = await upload();
        const normalProcess = storage.process.bind(storage);
        let unpublished: string[] = [];
        const membership = async (status: string) => {
          await admin.query(
            'UPDATE woori.memberships SET status=$3::woori."MembershipStatus" WHERE "groupId"=$1 AND "userId"=$2',
            [groupId, owner.id, status],
          );
        };
        storage.process = async (
          ...args: Parameters<typeof storage.process>
        ) => {
          const result = await normalProcess(...args);
          unpublished = result.map((v) => v.objectKey);
          await membership("REMOVED");
          return result;
        };
        await mutation(
          owner.agent.post(`${album}/photos/${interrupted.photoId}/complete`),
        ).expect(404);
        assert.ok(unpublished.every((key) => !objects.has(key)));
        storage.process = normalProcess;
        await membership("ACTIVE");
        const normalRead = storage.read.bind(storage);
        let interruptedBody: Readable | undefined;
        storage.read = async (...args: Parameters<typeof storage.read>) => {
          const result = await normalRead(...args);
          interruptedBody = result.body;
          await membership("REMOVED");
          return result;
        };
        await owner.agent.get(content).expect(404);
        assert.equal(interruptedBody?.destroyed, true);
        storage.read = normalRead;
        await membership("ACTIVE");
        // Expired reservations free quota; a stale processing token may never finalize a newer attempt.
        const expired = await upload();
        await admin.query(
          "UPDATE woori.photos SET \"uploadExpiresAt\"=now()-interval '1 second' WHERE id=$1",
          [expired.photoId],
        );
        await mutation(
          owner.agent.post(`${album}/photos/${expired.photoId}/complete`),
        ).expect(410);
        const tickets = await Promise.all(
          Array.from({ length: 6 }, () =>
            mutation(owner.agent.post(`${album}/uploads`)).send(payload),
          ),
        );
        assert.equal(
          tickets.filter((result) => result.status === 201).length,
          5,
        );
        assert.equal(
          tickets.filter((result) => result.status === 409).length,
          1,
        );
        for (const [key, limit, endpoint] of [
          [`media-upload:${owner.id}`, 120, `${album}/uploads`],
          [`media-complete:${owner.id}`, 300, complete],
        ] as const) {
          const bucket = rateLimitKey("auth", key, new Date(), 15 * 60 * 1000);
          await admin.query(
            'INSERT INTO woori.rate_limit_buckets (id,"windowStart",attempts) VALUES ($1,$2,$3) ON CONFLICT(id) DO UPDATE SET attempts=$3',
            [bucket.id, bucket.windowStart, limit],
          );
          const blocked = await mutation(owner.agent.post(endpoint))
            .send(endpoint.endsWith("/uploads") ? payload : undefined)
            .expect(429);
          assert.equal(blocked.body.code, "TOO_MANY_REQUESTS");
        }
      },
    );
    await t.test(
      "CSRF checks reject untrusted origins and missing custom headers; user cookies cannot authorize admin",
      async () => {
        await owner.agent.post("/v1/groups").send({ name: "차단" }).expect(403);
        await owner.agent
          .post("/v1/groups")
          .set("Origin", origin)
          .send({ name: "차단" })
          .expect(403);
        await owner.agent
          .post("/v1/groups")
          .set("Origin", "https://evil.example")
          .set("X-Woori-Request", "1")
          .send({ name: "차단" })
          .expect(403);
        await owner.agent.get("/v1/admin").expect(403);
        await owner.agent.get("/V1/ADMIN").expect(403);
      },
    );
    await t.test(
      "expired, revoked and suspended sessions fail; login rotates and logout revokes",
      async () => {
        await verify(unverified);
        const login = async () =>
          mutation(unverified.agent.post("/v1/auth/login"))
            .send({ username: unverified.username, password })
            .expect(200);
        await mutation(api.post("/v1/auth/login"))
          .send({
            username: unverified.username,
            password: "incorrect-password-long",
          })
          .expect(401);
        await admin.query(
          'UPDATE woori.sessions SET "expiresAt" = now() - interval \'1 second\' WHERE "userId"=$1',
          [unverified.id],
        );
        await unverified.agent.get("/v1/auth/me").expect(401);
        await login();
        await unverified.agent.get("/v1/auth/me").expect(200);
        await admin.query(
          'UPDATE woori.sessions SET "revokedAt" = now() WHERE "userId"=$1',
          [unverified.id],
        );
        await unverified.agent.get("/v1/auth/me").expect(401);
        await login();
        await admin.query(
          "UPDATE woori.users SET status='SUSPENDED' WHERE id=$1",
          [unverified.id],
        );
        await unverified.agent.get("/v1/auth/me").expect(401);
        await mutation(api.post("/v1/auth/login"))
          .send({ username: unverified.username, password })
          .expect(401);
        await admin.query(
          "UPDATE woori.users SET status='ACTIVE' WHERE id=$1",
          [unverified.id],
        );
        const response = await login();
        const oldCookie = (
          response.headers["set-cookie"] as unknown as string[]
        )[0].split(";")[0];
        await login();
        await api.get("/v1/auth/me").set("Cookie", oldCookie).expect(401);
        await mutation(unverified.agent.post("/v1/auth/logout")).expect(204);
        await unverified.agent.get("/v1/auth/me").expect(401);
      },
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
