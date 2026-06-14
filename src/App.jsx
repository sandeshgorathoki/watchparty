import React, { useEffect, useRef, useState } from 'react'
import Peer from 'peerjs'

function extractYouTubeId(url) {
  if (!url) return null
  try {
    if (url.includes('v=')) return url.split('v=')[1].split('&')[0]
    if (url.includes('youtu.be/')) return url.split('youtu.be/')[1].split('?')[0]
    if (url.includes('/embed/')) return url.split('/embed/')[1].split('?')[0]
    if (url.includes('/shorts/')) return url.split('/shorts/')[1].split('?')[0]
  } catch (e) {}
  return null
}

function makeRoomId() {
  return `watch-${Math.random().toString(36).slice(2, 6)}-${Date.now().toString(36).slice(-4)}`
}

function getRoomFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return params.get('room') || ''
}

const PEER_OPTIONS = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  debug: 2,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  }
}

function createPeer(id) {
  return id ? new Peer(id, PEER_OPTIONS) : new Peer(PEER_OPTIONS)
}

export default function App() {
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [devices, setDevices] = useState({ cams: [], mics: [], speakers: [] })
  const [roomId, setRoomId] = useState(getRoomFromUrl)
  const [joinId, setJoinId] = useState(getRoomFromUrl)
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('Ready')
  const [logs, setLogs] = useState([])
  const [videoUrl, setVideoUrl] = useState('')
  const [currentVideoId, setCurrentVideoId] = useState('')

  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const ytDivRef = useRef(null)
  const ytPlayerRef = useRef(null)
  const peerRef = useRef(null)
  const connRef = useRef(null)
  const callRef = useRef(null)
  const localStreamRef = useRef(null)
  const suppressSyncRef = useRef(false)
  const lastStateRef = useRef({ videoId: '', status: 'idle', seconds: 0 })

  useEffect(() => {
    getLocalMedia()
    enumerateDevices()
    loadYouTubeApi()

    return () => {
      callRef.current?.close()
      connRef.current?.close()
      peerRef.current?.destroy()
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  useEffect(() => {
    localStreamRef.current = localStream
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream
  }, [localStream])

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream
  }, [remoteStream])

  function addLog(message) {
    setLogs((items) => [`${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${message}`, ...items].slice(0, 5))
  }

  async function getLocalMedia() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      setLocalStream(stream)
      setStatus('Camera and mic ready')
      addLog('Camera and mic allowed')
    } catch (e) {
      setStatus('Camera or mic blocked')
      addLog('Allow camera and mic to start a call')
      console.warn('no media', e)
    }
  }

  async function enumerateDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices({
        cams: list.filter((d) => d.kind === 'videoinput'),
        mics: list.filter((d) => d.kind === 'audioinput'),
        speakers: list.filter((d) => d.kind === 'audiooutput')
      })
    } catch (e) {}
  }

  function loadYouTubeApi() {
    if (window.YT) return
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(script)
    window.onYouTubeIframeAPIReady = () => {}
  }

  function attachPeerEvents(peer, nextRole) {
    peer.on('open', (id) => {
      setStatus(nextRole === 'host' ? 'Room is live' : 'Joining room')
      addLog(nextRole === 'host' ? `Room created: ${id}` : `Your peer opened: ${id}`)
    })

    peer.on('connection', (conn) => {
      bindDataConnection(conn)
      addLog('Friend joined the room')
    })

    peer.on('call', (call) => {
      callRef.current = call
      call.answer(localStreamRef.current)
      bindMediaCall(call)
      addLog('Answered video call')
    })

    peer.on('error', (error) => {
      const label = formatPeerError(error)
      setStatus(label)
      addLog(error.message ? `${label}: ${error.message}` : label)
      console.warn(error)
    })
  }

  function bindDataConnection(conn) {
    connRef.current = conn
    conn.on('open', () => {
      setStatus('Connected with friend')
      addLog('Watch sync connected')
      sendCurrentWatchState()
    })
    conn.on('data', handlePeerMessage)
    conn.on('close', () => {
      setStatus('Friend disconnected')
      addLog('Friend left')
      setRemoteStream(null)
    })
    conn.on('error', (error) => {
      setStatus('Watch sync failed')
      addLog(error.message || 'Watch sync connection failed')
      console.warn(error)
    })
  }

  function bindMediaCall(call) {
    call.on('stream', (stream) => {
      setRemoteStream(stream)
      setStatus('Video call connected')
      addLog('Video call connected')
    })
    call.on('close', () => {
      setRemoteStream(null)
      addLog('Video call ended')
    })
    call.on('error', (error) => {
      setStatus('Video call failed')
      addLog(error.message || 'Video call connection failed')
      console.warn(error)
    })
  }

  function formatPeerError(error) {
    const messages = {
      'browser-incompatible': 'Browser not compatible',
      'disconnected': 'Peer server disconnected',
      'invalid-id': 'Invalid room code',
      'invalid-key': 'Peer server key failed',
      'network': 'Network connection error',
      'peer-unavailable': 'Room not found',
      'ssl-unavailable': 'Secure connection unavailable',
      'server-error': 'Peer server error',
      'socket-error': 'Peer server socket error',
      'socket-closed': 'Peer server socket closed',
      'unavailable-id': 'Room name already exists',
      'webrtc': 'WebRTC connection failed'
    }

    return messages[error?.type] || 'Connection error'
  }

  async function createRoom() {
    const id = roomId || makeRoomId()
    setRoomId(id)
    setJoinId(id)
    setRole('host')
    updateUrl(id)

    peerRef.current?.destroy()
    const peer = createPeer(id)
    peerRef.current = peer
    attachPeerEvents(peer, 'host')
  }

  async function joinRoom() {
    const id = joinId.trim()
    if (!id) return

    setRoomId(id)
    setRole('guest')
    updateUrl(id)

    peerRef.current?.destroy()
    const peer = createPeer()
    peerRef.current = peer
    attachPeerEvents(peer, 'guest')

    peer.on('open', () => {
      const conn = peer.connect(id, { reliable: true })
      bindDataConnection(conn)

      if (localStreamRef.current) {
        const call = peer.call(id, localStreamRef.current)
        callRef.current = call
        bindMediaCall(call)
        addLog('Calling room host')
      }
    })
  }

  function updateUrl(id) {
    const nextUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(id)}`
    window.history.replaceState({}, '', nextUrl)
  }

  async function copyRoomLink() {
    if (!roomId) return
    const link = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`
    try {
      await navigator.clipboard.writeText(link)
      addLog('Room link copied')
    } catch (e) {
      addLog(link)
    }
  }

  async function switchCamera(deviceId) {
    if (!deviceId) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false })
      const track = stream.getVideoTracks()[0]
      const old = localStreamRef.current?.getVideoTracks()[0]
      if (old) {
        localStreamRef.current.removeTrack(old)
        old.stop()
      }
      localStreamRef.current.addTrack(track)
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()))
      replaceOutgoingTrack(track, 'video')
    } catch (e) {
      addLog('Could not switch camera')
      console.warn(e)
    }
  }

  async function switchMic(deviceId) {
    if (!deviceId) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } }, video: false })
      const track = stream.getAudioTracks()[0]
      const old = localStreamRef.current?.getAudioTracks()[0]
      if (old) {
        localStreamRef.current.removeTrack(old)
        old.stop()
      }
      localStreamRef.current.addTrack(track)
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()))
      replaceOutgoingTrack(track, 'audio')
    } catch (e) {
      addLog('Could not switch mic')
      console.warn(e)
    }
  }

  function replaceOutgoingTrack(track, kind) {
    const sender = callRef.current?.peerConnection?.getSenders().find((item) => item.track?.kind === kind)
    sender?.replaceTrack(track)
  }

  function switchSpeaker(deviceId) {
    document.querySelectorAll('video').forEach((video) => {
      if (typeof video.setSinkId === 'function') video.setSinkId(deviceId).catch(() => {})
    })
  }

  function toggleMic() {
    setMicOn((value) => {
      localStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !value
      })
      return !value
    })
  }

  function toggleCam() {
    setCamOn((value) => {
      localStreamRef.current?.getVideoTracks().forEach((track) => {
        track.enabled = !value
      })
      return !value
    })
  }

  function sendMessage(message) {
    if (connRef.current?.open) connRef.current.send(message)
  }

  function sendCurrentWatchState() {
    if (!ytPlayerRef.current || !currentVideoId) return
    sendMessage({
      type: 'watch-state',
      videoId: currentVideoId,
      status: lastStateRef.current.status,
      seconds: ytPlayerRef.current.getCurrentTime?.() || 0
    })
  }

  function handlePeerMessage(message) {
    if (!message || typeof message !== 'object') return

    if (message.type === 'watch-state') {
      applyWatchState(message)
    }
  }

  function applyWatchState({ videoId, status: nextStatus, seconds = 0 }) {
    if (!videoId) return
    suppressSyncRef.current = true
    setCurrentVideoId(videoId)

    ensurePlayer(videoId, () => {
      if (Math.abs((ytPlayerRef.current.getCurrentTime?.() || 0) - seconds) > 1.5) {
        ytPlayerRef.current.seekTo?.(seconds, true)
      }

      if (nextStatus === 'playing') ytPlayerRef.current.playVideo?.()
      if (nextStatus === 'paused') ytPlayerRef.current.pauseVideo?.()

      lastStateRef.current = { videoId, status: nextStatus, seconds }
      setTimeout(() => {
        suppressSyncRef.current = false
      }, 500)
    })
  }

  function ensurePlayer(videoId, readyCallback) {
    if (!window.YT?.Player) {
      setTimeout(() => ensurePlayer(videoId, readyCallback), 250)
      return
    }

    if (ytPlayerRef.current?.loadVideoById) {
      if (currentVideoId !== videoId) ytPlayerRef.current.loadVideoById(videoId)
      readyCallback?.()
      return
    }

    ytPlayerRef.current = new window.YT.Player(ytDivRef.current, {
      height: '360',
      width: '640',
      videoId,
      playerVars: { autoplay: 1, controls: 1, playsinline: 1 },
      events: {
        onReady: () => readyCallback?.(),
        onStateChange: handlePlayerStateChange
      }
    })
  }

  function loadYouTube(url, shouldSync = true) {
    const id = extractYouTubeId(url)
    if (!id) {
      addLog('Paste a valid YouTube link')
      return
    }

    setVideoUrl(url)
    setCurrentVideoId(id)
    lastStateRef.current = { videoId: id, status: 'playing', seconds: 0 }
    ensurePlayer(id, () => {
      ytPlayerRef.current.playVideo?.()
      if (shouldSync) {
        sendMessage({ type: 'watch-state', videoId: id, status: 'playing', seconds: 0 })
        addLog('Shared video with room')
      }
    })
  }

  function handlePlayerStateChange(event) {
    if (suppressSyncRef.current || !currentVideoId) return

    const statusMap = {
      1: 'playing',
      2: 'paused'
    }
    const nextStatus = statusMap[event.data]
    if (!nextStatus) return

    const seconds = ytPlayerRef.current?.getCurrentTime?.() || 0
    lastStateRef.current = { videoId: currentVideoId, status: nextStatus, seconds }
    sendMessage({ type: 'watch-state', videoId: currentVideoId, status: nextStatus, seconds })
  }

  function playVideo() {
    ytPlayerRef.current?.playVideo?.()
    if (currentVideoId) {
      const seconds = ytPlayerRef.current?.getCurrentTime?.() || 0
      sendMessage({ type: 'watch-state', videoId: currentVideoId, status: 'playing', seconds })
    }
  }

  function pauseVideo() {
    ytPlayerRef.current?.pauseVideo?.()
    if (currentVideoId) {
      const seconds = ytPlayerRef.current?.getCurrentTime?.() || 0
      sendMessage({ type: 'watch-state', videoId: currentVideoId, status: 'paused', seconds })
    }
  }

  function onVideoPaste(event) {
    const text = (event.clipboardData || window.clipboardData).getData('text')
    const urlMatch = text?.match(/(https?:\/\/[^\s]+)/i)
    if (urlMatch?.[0]) {
      event.preventDefault()
      loadYouTube(urlMatch[0])
    }
  }

  const roomLink = roomId ? `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}` : ''

  return (
    <main className="app">
      <section className="topbar">
        <div>
          <p className="eyebrow">WatchParty</p>
          <h1>Room, call, and synced video</h1>
        </div>
        <span className={`status ${remoteStream ? 'connected' : ''}`}>{status}</span>
      </section>

      <section className="roomStrip">
        <div className="roomControls">
          <input value={joinId} onChange={(event) => setJoinId(event.target.value)} placeholder="Room code" />
          <button className="btn primary" onClick={createRoom}>Create Room</button>
          <button className="btn secondary" onClick={joinRoom}>Join Room</button>
          <button className="btn ghost" onClick={copyRoomLink} disabled={!roomId}>Copy Link</button>
        </div>
        {roomLink && <p className="roomLink">{roomLink}</p>}
      </section>

      <section className="stage">
        <div className="people">
          <div className="videoTile">
            <video ref={localVideoRef} autoPlay muted playsInline />
            <span>You</span>
          </div>
          <div className="videoTile">
            {remoteStream ? <video ref={remoteVideoRef} autoPlay playsInline /> : <div className="emptyRemote">Waiting for friend</div>}
            <span>{role === 'host' ? 'Friend' : 'Host'}</span>
          </div>
        </div>

        <div className="devicePanel">
          <div className="callButtons">
            <button className="btn secondary" onClick={toggleMic}>{micOn ? 'Mic On' : 'Mic Off'}</button>
            <button className="btn secondary" onClick={toggleCam}>{camOn ? 'Cam On' : 'Cam Off'}</button>
          </div>
          <select onChange={(event) => switchCamera(event.target.value)}>
            <option value="">Select Camera</option>
            {devices.cams.map((camera) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label || camera.deviceId}</option>)}
          </select>
          <select onChange={(event) => switchMic(event.target.value)}>
            <option value="">Select Mic</option>
            {devices.mics.map((mic) => <option key={mic.deviceId} value={mic.deviceId}>{mic.label || mic.deviceId}</option>)}
          </select>
          <select onChange={(event) => switchSpeaker(event.target.value)}>
            <option value="">Select Speaker</option>
            {devices.speakers.map((speaker) => <option key={speaker.deviceId} value={speaker.deviceId}>{speaker.label || speaker.deviceId}</option>)}
          </select>
        </div>
      </section>

      <section className="watch">
        <div className="watchControls">
          <input
            value={videoUrl}
            onChange={(event) => setVideoUrl(event.target.value)}
            onPaste={onVideoPaste}
            placeholder="Paste a YouTube link"
          />
          <button className="btn primary" onClick={() => loadYouTube(videoUrl)}>Load</button>
          <button className="btn secondary" onClick={playVideo}>Play</button>
          <button className="btn secondary" onClick={pauseVideo}>Pause</button>
        </div>
        <div className="playerShell">
          <div ref={ytDivRef} className="player" />
        </div>
      </section>

      <section className="activity">
        {logs.length ? logs.map((item) => <p key={item}>{item}</p>) : <p>Create a room, copy the link, and send it to your friend.</p>}
      </section>
    </main>
  )
}
