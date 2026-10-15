import { Injectable } from '@nestjs/common';
import { MediaStorageService } from '../../common/media/media-storage.service';
import { PhotoDateBackfillRepository } from './photo-date-backfill.repository';

export function assertLocalBackfillDatabase(value: string | undefined): void {
  try {
    const url = new URL(value ?? '');
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
      throw new Error();
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '55439' ||
      !/^\/(woori_dev|woori_test_[a-f0-9]{12})$/.test(url.pathname) ||
      url.username !== 'woori_api' ||
      [...url.searchParams].some(
        ([key, value]) => key !== 'schema' || value !== 'woori'
      )
    )
      throw new Error();
  } catch {
    throw new Error(
      'Photo date backfill only accepts the restricted local woori database.'
    );
  }
}
@Injectable()
export class PhotoDateBackfillService {
  constructor(
    private readonly repository: PhotoDateBackfillRepository,
    private readonly storage: MediaStorageService
  ) {}
  async run(options: { apply?: boolean; limit?: number; after?: string } = {}) {
    assertLocalBackfillDatabase(process.env.DATABASE_URL);
    const limit = options.limit ?? 50;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (options.after &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          options.after
        ))
    )
      throw new Error('Invalid backfill batch options.');
    const candidates = await this.repository.count(options.after);
    if (!options.apply)
      return {
        mode: 'dry-run',
        candidates,
        scanned: 0,
        updated: 0,
        withDate: 0,
        skipped: 0,
        failed: 0,
        nextCursor: null,
      };
    if (!this.storage.enabled())
      throw new Error('Photo storage is not configured.');
    const rows = await this.repository.candidates(limit, options.after);
    let updated = 0,
      withDate = 0,
      skipped = 0,
      failed = 0;
    for (const row of rows) {
      try {
        if (!(await this.repository.eligible(row))) {
          skipped++;
          continue;
        }
        const capturedAt = await this.storage.captureDate(
          row.objectKey,
          Number(row.bytes)
        );
        if (await this.repository.save(row, capturedAt)) {
          updated++;
          if (capturedAt) withDate++;
        } else skipped++;
      } catch {
        // Failed reads remain unchecked; a later run without --after retries them.
        failed++;
      }
    }
    return {
      mode: 'apply',
      candidates,
      scanned: rows.length,
      updated,
      withDate,
      skipped,
      failed,
      nextCursor: rows.length === limit ? rows.at(-1)!.id : null,
    };
  }
}
