import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iconDirectory = path.join(repositoryRoot, 'src-tauri', 'icons')
const masterPath = path.join(iconDirectory, 'app-icon.svg')
const master = fs.readFileSync(masterPath, 'utf8')
const color = master.match(/<rect[^>]*\sfill="(#[0-9a-fA-F]{6})"/)?.[1]
const mark = master.match(/  <g[\s\S]*?  <\/g>/)?.[0]

if (!color || !mark) {
  throw new Error('The canonical app icon is missing its background color or vector mark.')
}

const generatedNotice = '<!-- Generated from app-icon.svg; edit the canonical master, not this file. -->'
fs.writeFileSync(
  path.join(iconDirectory, 'app-icon-background.svg'),
  `${generatedNotice}\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n  <rect width="1024" height="1024" fill="${color}"/>\n</svg>\n`,
)
fs.writeFileSync(
  path.join(iconDirectory, 'app-icon-foreground.svg'),
  `${generatedNotice}\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n${mark}\n</svg>\n`,
)
