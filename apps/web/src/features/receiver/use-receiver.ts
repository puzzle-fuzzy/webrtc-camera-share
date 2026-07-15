import { useCallback, useEffect, useRef, useState } from "react"

import {
  loadRuntimeConfiguration,
  MAX_PENDING_ICE_CANDIDATES,
  parseServerSignal,
} from "@/features/signaling"
import { socketUrl, type Session } from "@/features/session"

const ICE_RECOVERY_TIMEOUT_MS = 25_000

export function useReceiver() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const connectionRef = useRef<RTCPeerConnection | null>(null)
  const configControllerRef = useRef<AbortController | null>(null)
  const rtcConfigurationRef = useRef<RTCConfiguration>({ iceServers: [] })
  const iceCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const processingIceRef = useRef<RTCPeerConnection | null>(null)
  const recoveryTimerRef = useRef<number | null>(null)
  const generationRef = useRef(0)
  const activeRef = useRef(false)
  const maxReceiversRef = useRef(8)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState(
    "输入房间信息或使用发送端分享链接",
  )

  const closePeerConnection = useCallback((clearCandidates = true) => {
    const connection = connectionRef.current
    connectionRef.current = null
    if (processingIceRef.current === connection) processingIceRef.current = null
    if (recoveryTimerRef.current !== null) {
      clearTimeout(recoveryTimerRef.current)
      recoveryTimerRef.current = null
    }
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
      activeRef.current = false
      configControllerRef.current?.abort()
      configControllerRef.current = null
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
    if (
      connectionRef.current !== connection ||
      !connection.remoteDescription ||
      processingIceRef.current === connection
    ) {
      return
    }

    processingIceRef.current = connection
    try {
      while (
        connectionRef.current === connection &&
        iceCandidatesRef.current.length > 0
      ) {
        const candidate = iceCandidatesRef.current.shift()
        if (!candidate) continue
        try {
          await connection.addIceCandidate(candidate)
        } catch {}
      }
    } finally {
      if (processingIceRef.current === connection) processingIceRef.current = null
    }
  }, [])

  const createPeerConnection = useCallback(() => {
    const connection = new RTCPeerConnection(rtcConfigurationRef.current)
    connectionRef.current = connection

    connection.onicecandidate = (event) => {
      if (connectionRef.current === connection && event.candidate) {
        sendSignal({ ice: event.candidate.toJSON() })
      }
    }
    connection.onconnectionstatechange = () => {
      if (connectionRef.current !== connection) return

      if (connection.connectionState === "connected") {
        if (recoveryTimerRef.current !== null) {
          clearTimeout(recoveryTimerRef.current)
          recoveryTimerRef.current = null
        }
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
        if (recoveryTimerRef.current === null) {
          recoveryTimerRef.current = window.setTimeout(() => {
            recoveryTimerRef.current = null
            if (
              connectionRef.current === connection &&
              connection.connectionState !== "connected"
            ) {
              closePeerConnection()
              setStatus("ICE 恢复超时，请停止后重新接收")
            }
          }, ICE_RECOVERY_TIMEOUT_MS)
        }
      }
    }
    connection.ontrack = (event) => {
      if (connectionRef.current !== connection || !videoRef.current) return
      videoRef.current.srcObject =
        event.streams[0] ?? new MediaStream([event.track])
      void videoRef.current.play().catch(() => {
        if (connectionRef.current === connection) {
          setStatus("已收到视频流，请点击播放器开始播放")
        }
      })
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
        if (connectionRef.current !== connection) return
        await processIceCandidates(connection)
        if (connectionRef.current !== connection) return
        const answer = await connection.createAnswer()
        await connection.setLocalDescription(answer)
        if (connectionRef.current === connection) {
          sendSignal({ sdp: answer })
          setStatus("已回复应答，正在建立连接...")
        }
      } catch {
        if (connectionRef.current === connection) {
          closePeerConnection()
          setStatus("处理连接请求失败")
        }
      }
    },
    [closePeerConnection, createPeerConnection, processIceCandidates, sendSignal],
  )

  const start = useCallback(
    async (session: Session) => {
      if (activeRef.current) return
      activeRef.current = true

      const generation = generationRef.current + 1
      generationRef.current = generation
      setRunning(true)
      setStatus("正在加载连接配置...")
      if (videoRef.current) videoRef.current.muted = true

      const configController = new AbortController()
      configControllerRef.current = configController
      const runtimeConfiguration = await loadRuntimeConfiguration(
        configController.signal,
      )
      if (configControllerRef.current === configController) {
        configControllerRef.current = null
      }
      if (generationRef.current !== generation) return
      rtcConfigurationRef.current = runtimeConfiguration.rtcConfiguration
      maxReceiversRef.current = runtimeConfiguration.maxReceivers

      const socket = new WebSocket(socketUrl("recv", session))
      socketRef.current = socket
      socket.onopen = () => {
        if (socketRef.current !== socket || generationRef.current !== generation) return
        socket.send(JSON.stringify({ type: "authenticate", key: session.key }))
        setStatus("正在验证房间访问码...")
      }
      socket.onmessage = async (event) => {
        if (socketRef.current !== socket) return
        const signal = parseServerSignal(event.data)
        if (!signal) return

        if (signal.type === "authenticated") {
          rtcConfigurationRef.current = { iceServers: signal.iceServers }
          maxReceiversRef.current = signal.maxReceivers
          setStatus(`已加入 ${session.room}，等待发送端...`)
          sendSignal({ type: "receiver-ready" })
          return
        }
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
          if (iceCandidatesRef.current.length >= MAX_PENDING_ICE_CANDIDATES) {
            stop("收到过多 ICE 候选，连接已关闭")
            return
          }
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
        stop(receiverCloseMessage(event.code, maxReceiversRef.current))
      }
      setStatus("正在连接信令服务...")
    },
    [
      closePeerConnection,
      handleOffer,
      processIceCandidates,
      sendSignal,
      stop,
    ],
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

function receiverCloseMessage(code: number, maxReceivers: number): string {
  switch (code) {
    case 4000:
      return "鉴权请求无效"
    case 4003:
      return "访问码不正确，房间已由其他访问码创建"
    case 4008:
      return "连接空闲超时，请重新加入"
    case 4010:
      return `房间接收端已满，最多支持 ${maxReceivers} 个`
    case 4011:
      return "服务房间数量已达上限，请稍后重试"
    case 4012:
      return "房间鉴权超时，请重新加入"
    case 4028:
      return "访问码尝试次数过多，请稍后重试"
    case 4029:
      return "信令发送过快，连接已关闭"
    case 4030:
      return "临时 TURN 凭据请求过多，请稍后重试"
    case 1006:
      return "无法加入房间，请检查房间信息和服务状态"
    default:
      return "信令连接已关闭"
  }
}
