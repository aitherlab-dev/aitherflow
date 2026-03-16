const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const hhmm = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (msgDay.getTime() === today.getTime()) return hhmm;
  if (msgDay.getTime() === yesterday.getTime()) return `Yesterday ${hhmm}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${hhmm}`;
}
