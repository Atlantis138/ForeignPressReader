export interface StudyMoment {
  logicalDate: string
  timezone: string
  nextRolloverAt: string
}

export function studyMoment(now: Date, cutoffHour: number): StudyMoment {
  const shifted = new Date(now)
  shifted.setHours(shifted.getHours() - cutoffHour)
  const logicalDate = `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`
  const next = new Date(now)
  next.setHours(cutoffHour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return {
    logicalDate,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    nextRolloverAt: next.toISOString(),
  }
}

export function dueAtLearningDay(now: Date, cutoffHour: number, scheduledDays: number): string {
  const days = Math.max(1, Math.round(Number.isFinite(scheduledDays) ? scheduledDays : 1))
  const due = new Date(studyMoment(now, cutoffHour).nextRolloverAt)
  due.setDate(due.getDate() + days - 1)
  return due.toISOString()
}

const pad = (value: number) => String(value).padStart(2, '0')
