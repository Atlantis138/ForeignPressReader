export type ArticleFilter = 'all' | 'bookmarked' | 'unread' | 'read'
export interface ArticleSearchQuery {
  text: string
  filter: ArticleFilter
  offset: number
  limit: number
}
export interface ArticleSearchItem {
  articleId: string
  publicationId: string
  title: string
  publicationTitle: string
  excerpt: string
  bookmarked: boolean
  read: boolean
}
export interface ArticleSearchPage {
  items: ArticleSearchItem[]
  total: number
  offset: number
  limit: number
}
export interface TranslationVersion {
  id: string
  createdAt: string
  models: string[]
  segmentCount: number
}
export interface ArticleReadingData {
  bookmarked: boolean
  read: boolean
  selectedVersionId: string | null
  versions: TranslationVersion[]
}
export type ArticleReadingChange =
  | { kind: 'bookmark' | 'read'; value: boolean }
  | { kind: 'translation-selection'; value: string | null }
  | { kind: 'preserve-translation' }
export interface ReaderManagementApi {
  searchArticles(query: ArticleSearchQuery): Promise<ArticleSearchPage>
  getReadingData(articleId: string): Promise<ArticleReadingData>
  changeReadingData(
    articleId: string,
    change: ArticleReadingChange,
  ): Promise<ArticleReadingData>
}
