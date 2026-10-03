export interface OnlineIssue {
  id: string
  date: string
  path: string
  bytes: number
}

export interface OnlineCatalog {
  revision: string
  fetchedAt: string
  issues: OnlineIssue[]
  stale?: boolean
  notice?: string
}
