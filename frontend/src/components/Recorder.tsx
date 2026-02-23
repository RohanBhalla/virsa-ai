import { useEffect, useRef, useState } from 'react'

type RecorderProps = {
  onReady: (blob: Blob) => void
}

export function Recorder({ onReady }: RecorderProps) {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const animationRef = useRef<number | null>(null)
  const waveformDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)

  function drawFlatLine() {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const bounds = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const renderWidth = Math.max(1, Math.floor(bounds.width * dpr))
    const renderHeight = Math.max(1, Math.floor(bounds.height * dpr))
    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      canvas.width = renderWidth
      canvas.height = renderHeight
    }

    context.clearRect(0, 0, canvas.width, canvas.height)
    const activeWidth = Math.floor(canvas.width * 0.72)
    const startX = Math.floor((canvas.width - activeWidth) / 2)
    const barWidth = Math.max(3, Math.floor(activeWidth / 90))
    const gap = Math.max(2, Math.floor(barWidth * 0.7))
    const totalBars = Math.max(10, Math.floor(activeWidth / (barWidth + gap)))
    const barHeight = Math.max(4, Math.floor(canvas.height * 0.08))

    context.fillStyle = 'rgba(74, 33, 2, 0.32)'
    for (let i = 0; i < totalBars; i += 1) {
      const x = startX + i * (barWidth + gap)
      const y = Math.floor((canvas.height - barHeight) / 2)
      context.fillRect(x, y, barWidth, barHeight)
    }
  }

  function startWaveformLoop() {
    const canvas = canvasRef.current
    const analyser = analyserRef.current
    const data = waveformDataRef.current
    if (!canvas || !analyser || !data) return

    const context = canvas.getContext('2d')
    if (!context) return

    const draw = () => {
      const bounds = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const renderWidth = Math.max(1, Math.floor(bounds.width * dpr))
      const renderHeight = Math.max(1, Math.floor(bounds.height * dpr))
      if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
        canvas.width = renderWidth
        canvas.height = renderHeight
      }

      analyser.getByteFrequencyData(data)
      context.clearRect(0, 0, canvas.width, canvas.height)

      const activeWidth = Math.floor(canvas.width * 0.72)
      const barWidth = Math.max(3, Math.floor(activeWidth / 90))
      const gap = Math.max(2, Math.floor(barWidth * 0.7))
      const pairCount = Math.max(6, Math.floor(activeWidth / ((barWidth + gap) * 2)))
      const sampleStep = Math.max(1, Math.floor(data.length / pairCount))
      const centerX = canvas.width / 2

      for (let i = 0; i < pairCount; i += 1) {
        const sample = data[i * sampleStep] ?? 0
        const normalized = sample / 255
        const minHeight = Math.max(3, Math.floor(canvas.height * 0.06))
        const maxHeight = Math.floor(canvas.height * 0.92)
        const barHeight = Math.max(minHeight, Math.floor(minHeight + normalized * (maxHeight - minHeight)))
        const offset = i * (barWidth + gap)
        const rightX = Math.floor(centerX + gap / 2 + offset)
        const leftX = Math.floor(centerX - gap / 2 - barWidth - offset)
        const y = Math.floor((canvas.height - barHeight) / 2)

        context.fillStyle = `rgba(74, 33, 2, ${0.3 + normalized * 0.7})`
        context.fillRect(leftX, y, barWidth, barHeight)
        context.fillRect(rightX, y, barWidth, barHeight)
      }

      animationRef.current = window.requestAnimationFrame(draw)
    }

    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current)
    }
    animationRef.current = window.requestAnimationFrame(draw)
  }

  function teardownAudioGraph() {
    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }

    sourceNodeRef.current?.disconnect()
    sourceNodeRef.current = null
    analyserRef.current = null
    waveformDataRef.current = null

    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      const audioContext = new AudioContext()
      const analyser = audioContext.createAnalyser()
      const source = audioContext.createMediaStreamSource(stream)

      analyser.fftSize = 2048
      source.connect(analyser)
      audioContextRef.current = audioContext
      analyserRef.current = analyser
      sourceNodeRef.current = source
      waveformDataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      mediaStreamRef.current = stream
      chunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        teardownAudioGraph()
        setIsRecording(false)
        setIsPaused(false)
        onReady(blob)
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setIsRecording(true)
      setIsPaused(false)
    } catch {
      // Intentionally silent for now: this step only shows the button UI.
      teardownAudioGraph()
      setIsRecording(false)
      setIsPaused(false)
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current
    if (!recorder) return
    if (recorder.state !== 'inactive') recorder.stop()
  }

  function togglePause() {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return

    if (recorder.state === 'recording') {
      recorder.pause()
      setIsPaused(true)
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
      drawFlatLine()
      return
    }

    if (recorder.state === 'paused') {
      recorder.resume()
      setIsPaused(false)
    }
  }

  useEffect(() => () => teardownAudioGraph(), [])

  useEffect(() => {
    if (!isRecording || isPaused) return
    startWaveformLoop()

    return () => {
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
    }
  }, [isRecording, isPaused])

  const showWaveform = isRecording || isPaused

  return (
    <div className="recorder">
      <button
        className={`record-button ${isRecording ? 'is-recording' : ''}`}
        onClick={isRecording ? stopRecording : startRecording}
        aria-label={isRecording ? 'Stop recording' : 'Start recording'}
      >
        {isRecording ? (
          <svg viewBox="0 0 24 24" aria-hidden="true" className="record-mic-icon">
            <rect x="7" y="7" width="10" height="10" rx="2.2" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true" className="record-mic-icon">
            <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
            <path d="M18 11a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V19H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.09A6 6 0 0 0 18 11Z" />
          </svg>
        )}
      </button>
      {showWaveform ? (
        <div className="waveform-wrap">
          <canvas ref={canvasRef} className="waveform-canvas" />
        </div>
      ) : null}
      {isRecording ? (
        <div className="record-controls">
          <button
            type="button"
            className={`record-pause-button ${isPaused ? 'is-paused' : ''}`}
            onClick={togglePause}
            aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
          >
            {isPaused ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 6.5v11l9-5.5-9-5.5Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="7" y="5" width="4" height="14" rx="1" />
                <rect x="13" y="5" width="4" height="14" rx="1" />
              </svg>
            )}
          </button>
        </div>
      ) : null}
    </div>
  )
}
