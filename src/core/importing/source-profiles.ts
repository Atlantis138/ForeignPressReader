export interface EpubSourceProfile {
  id: string
  titleSelectors: string
  sectionSelectors: string
  rubricSelectors: string
  dateSelectors: string
  matches(title: string, hrefs: string[]): boolean
  shouldSkipDocument(href: string, properties: string): boolean
}

const genericSkip = (href: string, properties: string) =>
  /(^|\/)(cover|book[_-]?toc|toc)(\.|[_-])/i.test(href)
  || /(^|\/)(ad|advert)([_-]?page)?[._-]/i.test(href)
  || properties.split(/\s+/).includes('nav')

export const GENERIC_EPUB_PROFILE: EpubSourceProfile = {
  id: 'generic-epub',
  titleSelectors: 'h1, h2',
  sectionSelectors: 'h2',
  rubricSelectors: 'h3',
  dateSelectors: 'time',
  matches: () => true,
  shouldSkipDocument: genericSkip,
}

export const ECONOMIST_PROFILE: EpubSourceProfile = {
  id: 'economist',
  titleSelectors: 'h1.te_article_title, h1, h2.te_section_title, h2',
  sectionSelectors: 'h2.te_section_title, h2',
  rubricSelectors: 'h3.te_article_rubric, .te_article_rubric',
  dateSelectors: 'h3.te_article_datePublished, time, .te_article_datePublished',
  matches: (title, hrefs) =>
    /economist/i.test(title) || hrefs.some((href) => /theeconomist|te_article/i.test(href)),
  shouldSkipDocument: genericSkip,
}

export class EpubSourceProfileRegistry {
  private readonly profiles: EpubSourceProfile[] = []

  constructor(
    profiles: readonly EpubSourceProfile[] = [ECONOMIST_PROFILE],
    private readonly fallback: EpubSourceProfile = GENERIC_EPUB_PROFILE,
  ) {
    for (const profile of profiles) this.register(profile)
  }

  register(profile: EpubSourceProfile): void {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(profile.id)) throw new Error('EPUB 来源 Profile ID 无效')
    if (profile.id === this.fallback.id || this.profiles.some((item) => item.id === profile.id)) {
      throw new Error(`EPUB 来源 Profile ${profile.id} 已注册`)
    }
    this.profiles.push(profile)
  }

  select(title: string, hrefs: string[]): EpubSourceProfile {
    return this.profiles.find((profile) => profile.matches(title, hrefs)) ?? this.fallback
  }

  list(): EpubSourceProfile[] {
    return [...this.profiles, this.fallback]
  }
}

const defaultRegistry = new EpubSourceProfileRegistry()

export function selectEpubSourceProfile(title: string, hrefs: string[]): EpubSourceProfile {
  return defaultRegistry.select(title, hrefs)
}
