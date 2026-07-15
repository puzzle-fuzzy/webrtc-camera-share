import { useCallback, useEffect, useRef, useState } from "react"

import { parseServerSignal, rtcConfiguration } from "@/features/signaling"
import { socketUrl, type Session } from "@/features/session"

export function useReceiver() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const connectionRef = useRef<RTCPeerConnection | null>(null)
  const iceCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const generationRef = useRef(0)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState(
    "输入房间信息或使用发送端分享链接",
  )

  const closePeerConnection = useCallback((clearCandidates = true) => {
    const connection = connectionRef.current
    connectionRef.current = null
    if (clearCandidates) iceCandidatesRef.current = []
    if (connection) {
      connection.onicecandidate = null
      connection.onconnectionstatechange = null
      connection.oniceconnectionstatechange = null
      connection.ontrack = null
      connection.close()
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
      videoRef.current.muted = true
    }
  }, [])

  const releaseResources = useCallback(
    (updateState: boolean) => {
      generationRef.current += 1
      const socket = socketRef.current
      socketRef.current = null
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000)
      closePeerConnection()
      if (updateState) setRunning(false)
    },
    [closePeerConnection],
  )

  const stop = useCallback(
    (message = "已停止") => {
      releaseResources(true)
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

  const processIceCandidates = useCallback(async (connection: RTCPeerConnection) => {
    if (connectionRef.current !== connection || !connection.remoteDescription) return

    while (iceCandidatesRef.current.length > 0) {
      const candidate = iceCandidatesRef.current.shift()
      if (!candidate) continue
      try {
        await connection.addIceCandidate(candidate)
      } catch (error) {
        console.warn("Failed to add ICE candidate", error)
      }
    }
  }, [])

  const createPeerConnection = useCallback(() => {
    const connection = new RTCPeerConnection(rtcConfiguration)
    connectionRef.current = connection

    connection.onicecandidate = (event) => {
      if (connectionRef.current === connection && event.candidate) {
        sendSignal({ ice: event.candidate.toJSON() })
      }
    }
    connection.onconnectionstatechange = () => {
      if (connectionRef.current !== connection) return

      if (connection.connectionState === "connected") {
        if (videoRef.current) videoRef.current.muted = false
        setStatus("连接建立")
      } else if (connection.connectionState === "failed") {
        closePeerConnection()
        setStatus("连接失败，请停止后重试")
      } else {
        setStatus(connection.connectionState)
      }
    }
    connection.oniceconnectionstatechange = () => {
      if (
        connectionRef.current === connection &&
        connection.iceConnectionState === "disconnected"
      ) {
        setStatus("ICE 暂时断开，正在恢复...")
      }
    }
    connection.ontrack = (event) => {
      if (connectionRef.current !== connection || !videoRef.current) return
      videoRef.current.srcObject =
        event.streams[0] ?? new MediaStream([event.track])
      void videoRef.current.play()
      setStatus("收到视频流")
    }

    return connection
  }, [closePeerConnection, sendSignal])

  const handleOffer = useCallback(
    async (description: RTCSessionDescriptionInit) => {
      closePeerConnection(connectionRef.current !== null)
      const connection = createPeerConnection()
      try {
        await connection.setRemoteDescription(description)
        await processIceCandidates(connection)
        const answer = await connection.createAnswer()
        await connection.setLocalDescription(answer)
        if (connectionRef.current === connection) sendSignal({ sdp: answer })
        setStatus("已回复应答，正在建立连接...")
      } catch (error) {
        console.error("Failed to handle offer", error)
        if (connectionRef.current === connection) closePeerConnection()
        setStatus("处理连接请求失败")
      }
    },
    [closePeerConnection, createPeerConnection, processIceCandidates, sendSignal],
  )

  const start = useCallback(
    (session: Session) => {
      if (running) return

      const generation = generationRef.current + 1
      generationRef.current = generation
      setRunning(true)
      setStatus("正在连接信令服务...")
      if (videoRef.current) videoRef.current.muted = true

      const socket = new WebSocket(socketUrl("recv", session))
      socketRef.current = socket
      socket.onopen = () => {
        if (socketRef.current !== socket || generationRef.current !== generation) return
        setStatus(`已加入 ${session.room}，等待发送端...`)
        sendSignal({ type: "receiver-ready" })
      }
      socket.onmessage = async (event) => {
        if (socketRef.current !== socket) return
        const signal = parseServerSignal(event.data)
        if (!signal) return

        if (signal.type === "peer-left" && signal.role === "send") {
          closePeerConnection()
          setStatus("发送端已离线，继续等待...")
          return
        }
        if (signal.type === "error") {
          setStatus(`信令错误：${signal.message}`)
          return
        }
        if ("sdp" in signal && signal.sdp.type === "offer") {
          await handleOffer(signal.sdp)
        } else if ("ice" in signal) {
          iceCandidatesRef.current.push(signal.ice)
          if (connectionRef.current) {
            await processIceCandidates(connectionRef.current)
          }
        }
      }
      socket.onerror = () => {
        if (socketRef.current === socket) setStatus("WebSocket 连接错误")
      }
      socket.onclose = (event) => {
        if (socketRef.current !== socket) return
        if (event.code === 4003) {
          stop("访问码不正确，房间已由其他访问码创建")
        } else if (event.code === 4010) {
          stop("房间接收端已满，最多支持 8 个")
        } else if (event.code === 1006) {
          stop("无法加入房间，请检查房间信息和服务状态")
        } else {
          stop("信令连接已关闭")
        }
      }
    },
    [closePeerConnection, handleOffer, processIceCandidates, running, sendSignal, stop],
  )

  useEffect(() => () => releaseResources(false), [releaseResources])

  return {
    videoRef,
    running,
    status,
    start,
    stop,
  }
}
