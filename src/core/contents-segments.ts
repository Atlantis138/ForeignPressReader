import type { PublicationDetail } from '../shared/types'
import type { SourceSegment } from './translation-service'

export function contentsSegments(publication: PublicationDetail): SourceSegment[] {
  const segments: SourceSegment[] = []
  const add = (id: string, type: string, text: string | null) => {
    if (text?.trim()) segments.push({ id, type, text, sourceHash: '' })
  }
  for (const section of publication.sections) add(section.id, 'heading', section.title)
  for (const article of [...publication.unsectionedArticles, ...publication.sections.flatMap(section => section.articles)]) {
    add(article.id, 'title', article.title)
    add(`${article.id}:rubric`, 'rubric', article.rubric)
  }
  return segments
}
