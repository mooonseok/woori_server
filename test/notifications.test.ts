import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  NotificationListDto,
  ReadNotificationsDto,
  UpdateGroupPreferenceDto,
  UpdatePreferencesDto,
} from '../src/domain/notifications/dto/notifications.dto';
import { validateQuietPreferences } from '../src/domain/notifications/notifications.repository';
const options = { whitelist: true, forbidNonWhitelisted: true };
test('notification inputs bound query and observed read sequence without accepting forged recipients', async () => {
  for (const value of [
    { limit: 101 },
    { cursor: null },
    { limit: 0 },
    { cursor: 'bad' },
  ])
    assert.ok(
      (await validate(plainToInstance(NotificationListDto, value), options))
        .length
    );
  for (const value of [
    { notifications: [] },
    // OpenAPI 0.20.0: a bundle's observed sequence may exceed 1, but it is
    // still a positive 32-bit integer (allocation is checked server-side).
    {
      notifications: [
        { id: '315097d9-f1a4-4202-ad40-455124a80cc2', throughSequence: 0 },
      ],
    },
    {
      notifications: [
        {
          id: '315097d9-f1a4-4202-ad40-455124a80cc2',
          throughSequence: 2147483648,
        },
      ],
    },
    {
      notifications: [
        {
          id: '315097d9-f1a4-4202-ad40-455124a80cc2',
          throughSequence: 1,
          recipientId: 'forged',
        },
      ],
    },
  ])
    assert.ok(
      (await validate(plainToInstance(ReadNotificationsDto, value), options))
        .length
    );
  assert.equal(
    (
      await validate(
        plainToInstance(ReadNotificationsDto, {
          notifications: [
            { id: '315097d9-f1a4-4202-ad40-455124a80cc2', throughSequence: 1 },
          ],
        }),
        options
      )
    ).length,
    0
  );
});
test('notification settings reject nulls and string booleans, bound time and require optimistic version', async () => {
  for (const value of [
    { enabled: true },
    { version: 0, enabled: 'false' },
    { version: 0, enabled: null },
    { version: 0, quietStartMinute: 1440 },
    { version: -1 },
    { version: 0, userId: 'forged' },
  ])
    assert.ok(
      (await validate(plainToInstance(UpdatePreferencesDto, value), options))
        .length
    );
  for (const value of [
    { version: 0, mode: 'all' },
    { mode: 'DEFAULT' },
    { version: 0, mode: null },
  ])
    assert.ok(
      (
        await validate(
          plainToInstance(UpdateGroupPreferenceDto, value),
          options
        )
      ).length
    );
  assert.equal(
    (
      await validate(
        plainToInstance(UpdatePreferencesDto, {
          version: 0,
          enabled: false,
          quietStartMinute: 0,
          quietEndMinute: 1439,
        }),
        options
      )
    ).length,
    0
  );
});
test('quiet hours validate cross-field equality and IANA zones while allowing overnight windows', () => {
  const base = {
    quietEnabled: true,
    quietStartMinute: 1320,
    quietEndMinute: 480,
    timeZone: 'Asia/Seoul',
  };
  assert.doesNotThrow(() => validateQuietPreferences(base));
  assert.throws(() =>
    validateQuietPreferences({ ...base, timeZone: 'not/a-zone' })
  );
  assert.throws(() =>
    validateQuietPreferences({ ...base, quietEndMinute: 1320 })
  );
  assert.doesNotThrow(() =>
    validateQuietPreferences({
      ...base,
      quietEnabled: false,
      quietEndMinute: 1320,
    })
  );
});
