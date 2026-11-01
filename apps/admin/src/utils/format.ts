import dayjs from 'dayjs';

export function formatTime(v?: string | Date | null): string {
  if (!v) return '-';
  const d = dayjs(v);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : String(v);
}

export function formatDate(v?: string | Date | null): string {
  if (!v) return '-';
  const d = dayjs(v);
  return d.isValid() ? d.format('YYYY-MM-DD') : String(v);
}
