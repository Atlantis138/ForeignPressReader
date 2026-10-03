import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Icon({ children, ...props }: IconProps) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>
}

export const LibraryIcon = (props: IconProps) => <Icon {...props}><path d="M4 5.5h5.5v14H4zM9.5 5.5H15v14H9.5zM15 5.5h5v14h-5z"/><path d="M6.7 8.5h.1M12.2 8.5h.1M17.5 8.5h.1"/></Icon>
export const DictionaryIcon = (props: IconProps) => <Icon {...props}><path d="M4 5.5c3.2-1.5 5.8-.9 8 1.2v13c-2.2-2.1-4.8-2.7-8-1.2z"/><path d="M20 5.5c-3.2-1.5-5.8-.9-8 1.2v13c2.2-2.1 4.8-2.7 8-1.2z"/></Icon>
export const StudyIcon = (props: IconProps) => <Icon {...props}><path d="m3 8.5 9-4.5 9 4.5-9 4.5z"/><path d="M7 11v4.5c2.8 2 7.2 2 10 0V11M21 9v6"/></Icon>
export const SettingsIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></Icon>
export const SearchIcon = (props: IconProps) => <Icon {...props}><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></Icon>
export const DownloadIcon = (props: IconProps) => <Icon {...props}><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></Icon>
export const PlusIcon = (props: IconProps) => <Icon {...props}><path d="M12 5v14M5 12h14"/></Icon>
export const ArrowLeftIcon = (props: IconProps) => <Icon {...props}><path d="m14.5 5-7 7 7 7M8 12h11"/></Icon>
export const ChevronRightIcon = (props: IconProps) => <Icon {...props}><path d="m9 5 7 7-7 7"/></Icon>
export const CloseIcon = (props: IconProps) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18"/></Icon>
export const SunIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></Icon>
export const MoonIcon = (props: IconProps) => <Icon {...props}><path d="M20 15.5A8 8 0 0 1 8.5 4 8.2 8.2 0 1 0 20 15.5Z"/></Icon>
export const TranslateIcon = (props: IconProps) => <Icon {...props}><path d="M4 5h9M8.5 3v2M6 8c1.2 2.8 3.3 5 6 6.2M12 8c-1.1 3-3.5 5.7-7 7.5M14 20l3-8 3 8M15 17h4"/></Icon>
export const AppearanceIcon = (props: IconProps) => <Icon {...props}><path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.2-2l-.4-.5c-.7-.9-.1-2.2 1-2.2H17a4 4 0 0 0 4-4A9 9 0 0 0 12 3Z"/><circle cx="7.5" cy="10" r=".7" fill="currentColor"/><circle cx="10" cy="6.8" r=".7" fill="currentColor"/><circle cx="14" cy="6.8" r=".7" fill="currentColor"/><circle cx="17" cy="10" r=".7" fill="currentColor"/></Icon>
export const DatabaseIcon = (props: IconProps) => <Icon {...props}><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></Icon>
export const SlidersIcon = (props: IconProps) => <Icon {...props}><path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="14" cy="18" r="2"/></Icon>
export const CheckIcon = (props: IconProps) => <Icon {...props}><path d="m5 12 4 4L19 6"/></Icon>
export const MoreIcon = (props: IconProps) => <Icon {...props}><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></Icon>
export const GridIcon = (props: IconProps) => <Icon {...props}><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></Icon>
export const ListIcon = (props: IconProps) => <Icon {...props}><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="5" cy="6" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="18" r="1" fill="currentColor"/></Icon>
export const SortIcon = (props: IconProps) => <Icon {...props}><path d="M8 4v16M5 7l3-3 3 3M16 20V4M13 17l3 3 3-3"/></Icon>
export const FolderIcon = (props: IconProps) => <Icon {...props}><path d="M3 7.5h7l2-2h9v13H3z"/></Icon>
export const EditIcon = (props: IconProps) => <Icon {...props}><path d="m4 20 4.2-1 10.6-10.6-3.2-3.2L5 15.8zM13.8 7l3.2 3.2"/></Icon>
export const TrashIcon = (props: IconProps) => <Icon {...props}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></Icon>
export const ChevronUpIcon = (props: IconProps) => <Icon {...props}><path d="m5 15 7-7 7 7"/></Icon>
export const ChevronDownIcon = (props: IconProps) => <Icon {...props}><path d="m5 9 7 7 7-7"/></Icon>
export const PreviousIcon = (props: IconProps) => <Icon {...props}><path d="M6 5v14M18 6l-8 6 8 6z"/></Icon>
export const NextIcon = (props: IconProps) => <Icon {...props}><path d="M18 5v14M6 6l8 6-8 6z"/></Icon>
export const PlayIcon = (props: IconProps) => <Icon {...props}><path d="m8 5 11 7-11 7z"/></Icon>
export const PauseIcon = (props: IconProps) => <Icon {...props}><path d="M8 5v14M16 5v14"/></Icon>
export const StopIcon = (props: IconProps) => <Icon {...props}><rect x="7" y="7" width="10" height="10" rx="1"/></Icon>
export const SpeakerIcon = (props: IconProps) => <Icon {...props}><path d="M5 10h4l5-4v12l-5-4H5z"/><path d="M17 9c1 .8 1.5 1.8 1.5 3S18 14.2 17 15M19 6.5c1.8 1.5 2.7 3.3 2.7 5.5s-.9 4-2.7 5.5"/></Icon>
