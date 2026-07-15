import { useCallback, useEffect, useRef, useState } from "react"

import { parseServerSignal, rtcConfiguration } from "@/features/signaling"
import { socketUrl, type Session } from "@/features/session"

type PeerState = {
  connection: RTCPeerConnection
  iceCandidates: RTCIceCandidateInit[]
}

type ViewerCount = {
  connected: number
  total: number
}

export function useSender() {
  const previewRef = useRef<HTMLVideoElement>(null)
  const socketRef = useRef<WebSocket>(null)
  const streamRef = useRef<MediaStream>(null)
  const peersRef = useRef(new Map<string, PeerState>())
  const generationRef = useRef(0)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState("配置房间后开始发送")
  const [viewers, setViewers] = useState<ViewerCount>({
    connected: 0,
    total: 0,
  })

  const updateViewerCount = useCallback(() => {
    const peers = [...peersRef.current.values()]
    setViewers({
      connected: peers.filter(
        ({ connection }) => connection.connectionState === "connected",
      ).length,
      total: peers.length,
    })
  }, [])

  const closePeerConnection = useCallback(
    (peerId: string) => {
      const peer = peersRef.current.get(peerId)
      if (!peer) return

      peersRef.current.delete(peerId)
      peer.connection.onicecandidate = null
      peer.connection.onconnectionstatechange = null
      peer.connection.oniceconnectionstatechange = null
      peer.connection.close()
      updateViewerCount()
    },
    [updateViewerCount],
  )

  const closeAllPeerConnections = useCallback((updateState: boolean) => {
    for (const peer of peersRef.current.values()) {
      peer.connection.onicecandidate = null
      peer.connection.onconnectionstatechange = null
      peer.connection.oniceconnectionstatechange = null
      peer.connection.close()
    }
    peersRef.current.clear()
    if (updateState) setViewers({ connected: 0, total: 0 })
  }, [])

  const releaseResources = useCallback(
    (updateState: boolean) => {
      generationRef.current += 1
      const socket = socketRef.current
      socketRef.current = null
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000)

      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      closeAllPeerConnections(updateState)
      if (previewRef.current) previewRef.current.srcObject = null
    },
    [closeAllPeerConnections],
  )

  const stop = useCallback(
    (message = "已停止") => {
      releaseResources(true)
      setRunning(false)
      setStatus(message)
    },
    [releaseResources],
  )

  const sendSignal = useCallback((signal: unknown) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(signal))
    }
  }, [])

  const processIceCandidates = useCallback(
    async (peerId: string, peer: PeerState) => {
      if (
        peersRef.current.get(peerId) !== peer ||
        !peer.connection.remoteDescription
      ) {
        return
      }

      while (peer.iceCandidates.length > 0) {
        const candidate = peer.iceCandidates.shift()
        if (!candidate) continue
        try {
          await peer.connection.addIceCandidate(candidate)
        } catch (error) {
          console.warn("Failed to add ICE candidate", error)
        }
      }
    },
    [],
  )

  const createAndSendOffer = useCallback(
    async (peerId: string) => {
      const stream = streamRef.current
      if (!stream || socketRef.current?.readyState !== WebSocket.OPEN) return

      closePeerConnection(peerId)
      const connection = new RTCPeerConnection(rtcConfiguration)
      const peer: PeerState = { connection, iceCandidates: [] }
      peersRef.current.set(peerId, peer)
      stream.getTracks().forEach((track) => connection.addTrack(track, stream))

      connection.onicecandidate = (event) => {
        if (peersRef.current.get(peerId) === peer && event.candidate) {
          sendSignal({ peerId, ice: event.candidate.toJSON() })
        }
      }
      connection.onconnectionstatechange = () => {
        if (peersRef.current.get(peerId) !== peer) return
        updateViewerCount()

        if (connection.connectionState === "connected") {
          const connected = [...peersRef.current.values()].filter(
            (candidate) => candidate.connection.connectionState === "connected",
          ).length
          setStatus(`${connected} 个接收端已连接`)
        } else if (connection.connectionState === "failed") {
          closePeerConnection(peerId)
          setStatus("一个接收端连接失败，继续等待...")
        }
      }
      connection.oniceconnectionstatechange = () => {
        if (
          peersRef.current.get(peerId) === peer &&
          connection.iceConnectionState === "disconnected"
        ) {
          setStatus("一个接收端暂时断开，正在恢复...")
        }
      }

      updateViewerCount()
      setStatus(`${peersRef.current.size} 个接收端已加入，正在协商...`)

      try {
        const offer = await connection.createOffer()
        await connection.setLocalDescription(offer)
        if (peersRef.current.get(peerId) === peer) {
          sendSignal({ peerId, sdp: offer })
        }
      } catch (error) {
        console.error("Failed to create offer", error)
        if (peersRef.current.get(peerId) === peer) {
          closePeerConnection(peerId)
          setStatus("为一个接收端创建连接失败")
        }
      }
    },
    [closePeerConnection, sendSignal, updateViewerCount],
  )

  const start = useCallback(
    async (session: Session) => {
      if (running) return

      const generation = generationRef.current + 1
      generationRef.current = generation
      setRunning(true)
      setStatus("正在请求摄像头权限...")

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        })
        if (generationRef.current !== generation) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        streamRef.current = stream
        if (previewRef.current) {
          previewRef.current.srcObject = stream
          await previewRef.current.play()
        }

        const socket = new WebSocket(socketUrl("send", session))
        socketRef.current = socket
        socket.onopen = () => {
          if (socketRef.current === socket) {
            setStatus(`已加入 ${session.room}，等待接收端...`)
          }
        }
        socket.onmessage = async (event) => {
          if (socketRef.current !== socket) return
          const signal = parseServerSignal(event.data)
          if (!signal) return

          if (signal.type === "receiver-ready") {
            await createAndSendOffer(signal.peerId)
            return
          }
          if (signal.type === "peer-left" && signal.role === "recv") {
            closePeerConnection(signal.peerId)
            setStatus(
              peersRef.current.size === 0
                ? "接收端已全部离线，继续等待..."
                : `${peersRef.current.size} 个接收端仍在线`,
            )
            return
          }
          if (signal.type === "error") {
            if (signal.code === "PEER_NOT_FOUND" && signal.peerId) {
              closePeerConnection(signal.peerId)
            }
            setStatus(`信令错误：${signal.message}`)
            return
          }

          if ("sdp" in signal && signal.sdp.type === "answer" && signal.peerId) {
            const peer = peersRef.current.get(signal.peerId)
            if (!peer || peer.connection.signalingState !== "have-local-offer") return
            await peer.connection.setRemoteDescription(signal.sdp)
            await processIceCandidates(signal.peerId, peer)
            setStatus("已收到接收端应答，正在建立连接...")
          } else if ("ice" in signal && signal.peerId) {
            const peer = peersRef.current.get(signal.peerId)
            if (!peer) return
            peer.iceCandidates.push(signal.ice)
            await processIceCandidates(signal.peerId, peer)
          }
        }
        socket.onerror = () => {
          if (socketRef.current === socket) setStatus("WebSocket 连接错误")
        }
        socket.onclose = (event) => {
          if (socketRef.current !== socket) return
          if (event.code === 4003) {
            stop("访问码不正确，房间已由其他访问码创建")
          } else if (event.code === 4009) {
            stop("该房间已有发送端在线")
          } else {
            stop("信令连接已关闭")
          }
        }
        setStatus("正在连接信令服务...")
      } catch (error) {
        if (generationRef.current !== generation) return
        console.error("Failed to start sender", error)
        const name = error instanceof DOMException ? error.name : ""
        const message = error instanceof Error ? error.message : String(error)
        if (name === "NotAllowedError") stop("摄像头权限被拒绝")
        else if (name === "NotFoundError") stop("未找到摄像头设备")
        else stop(`错误：${message}`)
      }
    },
    [
      closePeerConnection,
      createAndSendOffer,
      processIceCandidates,
      running,
      stop,
    ],
  )

  useEffect(() => () => releaseResources(false), [releaseResources])

  return {
    previewRef,
    running,
    status,
    viewers,
    setStatus,
    start,
    stop,
  }
}
