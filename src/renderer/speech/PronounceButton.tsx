import { useSpeech } from './SpeechProvider'

export function PronounceButton({
  sourceId,
  itemId,
  text,
  className = '',
  label,
}: {
  sourceId: string
  itemId: string
  text: string
  className?: string
  label?: string
}) {
  const speech = useSpeech()
  const active = speech.state.sourceId === sourceId && speech.state.itemId === itemId
    && ['playing', 'paused'].includes(speech.state.status)
  return (
    <button
      type="button"
      className={`pronounce-button ${active ? 'active' : ''} ${className}`.trim()}
      disabled={!speech.canPlay('word') || !text.trim()}
      aria-label={label ?? `朗读 ${text}`}
      title={speech.canPlay('word') ? (active ? '重新朗读' : '发音') : '所选单词语音服务不可用'}
      onClick={(event) => {
        event.stopPropagation()
        speech.speakWord(sourceId, itemId, text)
      }}
    >
      <SpeakerIcon />
    </button>
  )
}

export function SpeakerIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.4l4.1 3.4V6.1L7.4 9.5H4Z"/><path d="M15 9a4.4 4.4 0 0 1 0 6M17.6 6.5a7.8 7.8 0 0 1 0 11"/></svg>
}
