import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import {
  CommentBodyDto,
  CommentListDto,
  CreateCommentDto,
  SetReactionDto,
} from '../src/domain/photos/dto/photo-interactions.dto';
import { validateCommentPosition } from '../src/domain/photos/photo-interactions.service';
import { commentSummary } from '../src/domain/photos/photo-interactions.repository';

test('comment text trims before bounded validation and rejects extra fields', async () => {
  const dto = plainToInstance(CommentBodyDto, { body: '  함께 본 바다  ' });
  assert.equal(dto.body, '함께 본 바다');
  assert.equal((await validate(dto)).length, 0);
  for (const body of ['', ' \n ', null, 42, '가'.repeat(2001)]) {
    assert.ok(
      (await validate(plainToInstance(CommentBodyDto, { body }))).length
    );
  }
  assert.ok(
    (
      await validate(
        plainToInstance(CommentBodyDto, { body: 'safe', authorId: 'forged' }),
        { whitelist: true, forbidNonWhitelisted: true }
      )
    ).length
  );
});

test('pin coordinates preserve edges and reject missing, nonfinite, and general-comment coordinates', async () => {
  for (const point of [
    { x: 0, y: 1 },
    { x: 0.5, y: 0.25 },
  ]) {
    const dto = plainToInstance(CreateCommentDto, {
      body: '위치',
      kind: 'PIN',
      ...point,
    });
    assert.equal((await validate(dto)).length, 0);
    assert.doesNotThrow(() => validateCommentPosition(dto));
  }
  for (const value of [
    { kind: 'PIN' },
    { kind: 'PIN', x: 0 },
    { kind: 'PIN', x: -0.01, y: 0 },
    { kind: 'PIN', x: 0.5, y: Infinity },
    { kind: 'GENERAL', x: 0, y: 0 },
  ]) {
    const dto = plainToInstance(CreateCommentDto, { body: '위치', ...value });
    assert.throws(() => validateCommentPosition(dto), BadRequestException);
  }
  for (const x of [null, '0.5', NaN]) {
    assert.ok(
      (
        await validate(
          plainToInstance(CreateCommentDto, {
            body: '위치',
            kind: 'PIN',
            x,
            y: 0,
          })
        )
      ).length
    );
  }
});

test('interaction list limits and emoji allowlist reject unbounded or unknown input', async () => {
  for (const limit of ['0', '101', 'no', '1.5', null]) {
    assert.ok(
      (await validate(plainToInstance(CommentListDto, { limit }))).length
    );
  }
  assert.equal((await validate(plainToInstance(CommentListDto, {}))).length, 0);
  assert.equal(
    (await validate(plainToInstance(SetReactionDto, { emoji: '❤️' }))).length,
    0
  );
  for (const emoji of ['👍', 'free text', '', null]) {
    assert.ok(
      (await validate(plainToInstance(SetReactionDto, { emoji }))).length
    );
  }
});

test('comment capabilities permit owner moderation but never editing another author', () => {
  const comment = {
    id: 'comment',
    photoId: 'photo',
    authorId: 'author',
    body: 'hi',
    kind: 'GENERAL' as const,
    x: null,
    y: null,
    createdAt: new Date(),
    author: {
      id: 'author',
      nickname: '가족',
      avatarKey: null as string | null,
      avatarVersion: 0,
    },
  };
  const author = commentSummary(comment, 'author', false);
  assert.equal(author.canEdit, true);
  // The storage folder never leaves the server; only the URL version does.
  assert.equal(author.author.avatarVersion, null);
  assert.equal('avatarKey' in author.author, false);
  const pictured = commentSummary(
    {
      ...comment,
      author: {
        ...comment.author,
        avatarKey: 'avatars/a/b',
        avatarVersion: 3,
      },
    },
    'member',
    false
  );
  assert.equal(pictured.author.avatarVersion, 3);
  assert.equal('avatarKey' in pictured.author, false);
  assert.equal(author.canDelete, true);
  const owner = commentSummary(comment, 'owner', true);
  assert.equal(owner.canEdit, false);
  assert.equal(owner.canDelete, true);
  const member = commentSummary(comment, 'member', false);
  assert.equal(member.canEdit, false);
  assert.equal(member.canDelete, false);
  assert.equal('authorId' in member, false);
});
