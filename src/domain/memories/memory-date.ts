import { BadRequestException } from '@nestjs/common';
export const MEMORY_TIME_ZONE = 'Asia/Seoul';
export function seoulDate(date: Date): string {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}
export function effectivePhotoDate(photo: {
  capturedAt: Date | null;
  createdAt: Date;
  manualCapturedDate?: Date | null;
}) {
  if (photo.manualCapturedDate)
    return {
      effectiveDate: photo.manualCapturedDate.toISOString().slice(0, 10),
      dateSource: 'USER' as const,
    };
  return {
    effectiveDate: seoulDate(photo.capturedAt ?? photo.createdAt),
    dateSource: photo.capturedAt ? ('EXIF' as const) : ('UPLOAD' as const),
  };
}
export function parseManualDate(value: string, now = new Date()): Date {
  const result = new Date(value + 'T00:00:00.000Z');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(result.getTime()) ||
    result.toISOString().slice(0, 10) !== value ||
    value < '1800-01-01' ||
    value > seoulDate(now)
  )
    throw new BadRequestException({
      code: 'INVALID_CAPTURE_DATE',
      message: '촬영일은 1800년부터 오늘까지의 올바른 날짜로 입력해 주세요.',
    });
  return result;
}
export function memoryCalendar(now = new Date()) {
  const asOf = seoulDate(now);
  const [year, month, day] = asOf.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return {
    asOf,
    year,
    month,
    day,
    includeLeapDay: month === 2 && day === 28 && !leap,
  };
}
