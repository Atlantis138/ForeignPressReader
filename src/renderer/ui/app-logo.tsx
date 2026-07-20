import type { ImgHTMLAttributes } from 'react'
import appIconUrl from '../../../src-tauri/icons/app-icon.svg'

/** Both renderer shells consume the same canonical SVG used to generate app icons. */
export function AppLogo({ className, alt = '', ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  return <img className={['app-logo', className].filter(Boolean).join(' ')} src={appIconUrl} alt={alt} {...props} />
}
