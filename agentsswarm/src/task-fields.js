export function normalizeTaskPriority(value) {
  const priority = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal'
}

export function normalizeBooleanFlag(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value === 'string') {
    const flag = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(flag)) return true
    if (['false', '0', 'no', 'off'].includes(flag)) return false
  }
  return fallback
}
