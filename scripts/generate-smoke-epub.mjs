import fs from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

const outputPath = process.argv[2]
if (!outputPath) {
  throw new Error('Usage: node scripts/generate-smoke-epub.mjs <output.epub>')
}

const zip = new JSZip()
zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`)
zip.file('EPUB/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="publication-id">urn:uuid:foreign-press-reader-release-smoke</dc:identifier>
    <dc:title>Release Smoke Weekly</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="section" href="section.xhtml" media-type="application/xhtml+xml"/>
    <item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="section"/>
    <itemref idref="article"/>
  </spine>
</package>`)
zip.file('EPUB/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml">
<body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>
  <li><a href="section.xhtml">Leaders</a><ol>
    <li><a href="article.xhtml">A synthetic release article</a></li>
  </ol></li>
</ol></nav></body></html>`)
zip.file('EPUB/section.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Leaders</title></head>
<body><h2 class="te_section_title">Leaders</h2></body>
</html>`)
zip.file('EPUB/article.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>A synthetic release article</title></head>
<body>
  <h1 class="te_article_title">A synthetic release article</h1>
  <h3 class="te_article_rubric">A local-only validation fixture</h3>
  <p>This synthetic paragraph contains enough ordinary English words to exercise article classification and reading without redistributing any publication content.</p>
  <p>The second paragraph confirms navigation, text rendering, and stable local import behavior in a deliberately small release smoke test.</p>
</body>
</html>`)

const resolvedOutput = path.resolve(outputPath)
await fs.mkdir(path.dirname(resolvedOutput), { recursive: true })
await fs.writeFile(resolvedOutput, await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 6 },
}))
console.log(resolvedOutput)
