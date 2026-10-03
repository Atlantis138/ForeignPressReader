import { useSpeech } from './SpeechProvider'
import { SpeakerIcon } from '../ui/icons'

export { SpeakerIcon } from '../ui/icons'

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
