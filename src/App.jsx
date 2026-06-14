import React, { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

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

const SIGNALING_SERVER = window.location.origin.replace(/^http/, 'ws').replace(/:\d+$/, ':3001')
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
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
  const [roomReady, setRoomReady] = useState(false)

  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const ytDivRef = useRef(null)
  const ytPlayerRef = useRef(null)
  const socketRef = useRef(null)
  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const suppressSyncRef = useRef(false)
  const lastStateRef = useRef({ videoId: '', status: 'idle', seconds: 0 })
  const joinRetryRef = useRef(0)
  const joinTargetRef = useRef('')

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
    if (joinId && localStream && !role && !peerRef.current) {
      setStatus('Room link loaded')
      addLog('Click Join Room to connect')
    }
  }, [joinId, localStream, role])

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
    // PeerJS replaced with Socket.IO + WebRTC signaling; no-op
  }

  function bindDataConnection(conn) {
    // Data channel handled via Socket.IO messages; we use socketRef for messaging
  }

  function bindMediaCall(call) {
    // Media call handled via RTCPeerConnection events in new implementation
  }

  function formatPeerError(error) {
    return error?.message || 'Connection error'
  }

  async function createRoom() {
    const id = makeRoomId()
    setRoomId(id)
    setJoinId(id)
    setRole('host')
    setRoomReady(false)
    setStatus('Creating room')
    updateUrl(id)

    // connect to signaling server and join
    socketRef.current?.disconnect()
    const socket = io('http://localhost:3001')
    socketRef.current = socket
    socket.on('connect', () => {
      socket.emit('join-room', id)
      setRoomReady(true)
      setStatus('Room is live')
      addLog(`Room created: ${id}`)
    })
    socket.on('peer-joined', () => {
      addLog('Friend joined the room')
      // create offer
      startHostOffer()
    })
    socket.on('signal', handleSignal)
    socket.on('watch-state', (payload) => handleWatchStateFromSocket(payload))
  }

  async function joinRoom() {
    const id = joinId.trim()
    if (!id) return
    if (!localStreamRef.current) {
      setStatus('Camera and mic needed')
      addLog('Allow camera and mic before joining')
      await getLocalMedia()
      return
    }

    setRoomId(id)
    setRole('guest')
    setRoomReady(false)
    setStatus('Looking for room')
    updateUrl(id)
    joinRetryRef.current = 0
    joinTargetRef.current = id

    // connect to signaling server and join
    socketRef.current?.disconnect()
    const socket = io('http://localhost:3001')
    socketRef.current = socket
    socket.on('connect', () => {
      socket.emit('join-room', id)
      setRoomReady(true)
      setStatus('Joined room')
      addLog(`Joined room: ${id}`)
    })
    socket.on('signal', handleSignal)
    socket.on('watch-state', (payload) => handleWatchStateFromSocket(payload))
  }

  // WebRTC + Socket.IO signaling functions
  function createPeerConnection() {
    if (pcRef.current) return pcRef.current
    const pc = new RTCPeerConnection(ICE_CONFIG)
    pcRef.current = pc

    // add local tracks
    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current))

    pc.ontrack = (evt) => {
      const [stream] = evt.streams
      setRemoteStream(stream)
      setStatus('Video call connected')
      addLog('Video call connected')
    }

    pc.onicecandidate = (evt) => {
      if (evt.candidate && socketRef.current) {
        socketRef.current.emit('signal', { type: 'candidate', candidate: evt.candidate })
      }
    }

    pc.onconnectionstatechange = () => {
      if (!pc) return
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setRemoteStream(null)
        addLog('Video call ended')
      }
    }

    return pc
  }

  async function startHostOffer() {
    try {
      const pc = createPeerConnection()
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socketRef.current.emit('signal', { type: 'offer', sdp: pc.localDescription })
      addLog('Sent offer to guest')
    } catch (e) {
      console.warn(e)
      addLog('Failed to create offer')
    }
  }

  async function handleSignal(message) {
    if (!message) return
    const pc = createPeerConnection()
    try {
      if (message.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(message.sdp))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        socketRef.current.emit('signal', { type: 'answer', sdp: pc.localDescription })
        addLog('Answered offer')
      } else if (message.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(message.sdp))
        addLog('Received answer')
      } else if (message.type === 'candidate') {
        if (message.candidate) await pc.addIceCandidate(new RTCIceCandidate(message.candidate))
      }
    } catch (e) {
      console.warn('Signal handling error', e)
    }
  }

  function handleWatchStateFromSocket(payload) {
    // reuse existing watch-state handling path
    handlePeerMessage(payload)
  }

  function updateUrl(id) {
    const nextUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(id)}`
    window.history.replaceState({}, '', nextUrl)
  }

  async function copyRoomLink() {
    if (!roomId || !roomReady) return
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
      <section className="hero">
        <div className="heroCopy">
          <p className="eyebrow">WatchParty</p>
          <h1>Watch together, face to face</h1>
          <p className="subtitle">Create a live room, invite a friend, and keep the video controls in sync.</p>
        </div>
        <div className={`statusCard ${remoteStream ? 'connected' : ''}`}>
          <span>Current status</span>
          <strong>{status}</strong>
        </div>
      </section>

      <section className="panel roomStrip">
        <div className="sectionTitle">
          <div>
            <p className="kicker">Room</p>
            <h2>Create or join</h2>
          </div>
          {role && <span className="roleBadge">{role === 'host' ? 'Hosting' : 'Joining'}</span>}
        </div>
        <div className="roomControls">
          <input value={joinId} onChange={(event) => setJoinId(event.target.value)} placeholder="Room code" />
          <button className="btn primary" onClick={createRoom}>Create Room</button>
          <button className="btn secondary" onClick={joinRoom}>Join Room</button>
          <button className="btn ghost" onClick={copyRoomLink} disabled={!roomReady}>Copy Link</button>
        </div>
        {roomLink && (
          <p className="roomLink">
            {roomReady ? roomLink : role === 'host' ? 'Creating room. Copy will unlock when the room is live.' : roomLink}
          </p>
        )}
        {joinId && !role && <p className="roomHint">Room code loaded. Allow camera and mic, then click Join Room.</p>}
      </section>

      <section className="panel stage">
        <div className="people">
          <div className="videoTile">
            <video ref={localVideoRef} autoPlay muted playsInline />
            <span className="tileLabel">You</span>
          </div>
          <div className="videoTile">
            {remoteStream ? (
              <video ref={remoteVideoRef} autoPlay playsInline />
            ) : (
              <div className="emptyRemote">
                <strong>Waiting for friend</strong>
                <span>Share the live room link after creating a room.</span>
              </div>
            )}
            <span className="tileLabel">{role === 'host' ? 'Friend' : 'Host'}</span>
          </div>
        </div>

        <div className="devicePanel">
          <div className="sectionTitle compact">
            <div>
              <p className="kicker">Call</p>
              <h2>Devices</h2>
            </div>
          </div>
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

      <section className="panel watch">
        <div className="sectionTitle">
          <div>
            <p className="kicker">Watch</p>
            <h2>Shared player</h2>
          </div>
          {currentVideoId && <span className="roleBadge">Synced</span>}
        </div>
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

      <section className="panel activity">
        <div className="sectionTitle compact">
          <div>
            <p className="kicker">Activity</p>
            <h2>Connection log</h2>
          </div>
        </div>
        <div className="logList">
          {logs.length ? logs.map((item) => <p key={item}>{item}</p>) : <p>Create a room, copy the link, and send it to your friend.</p>}
        </div>
      </section>
    </main>
  )
}
