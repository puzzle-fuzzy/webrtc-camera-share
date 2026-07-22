import { useCallback, useEffect, useRef, useState } from "react"

import {
  currentBrowserEnvironment,
  receiverEnvironmentIssue,
} from "@/features/browser-environment"
import {
  connectionStateStatus,
  errorStatus,
  infoStatus,
  successStatus,
  type ConnectionStatus,
} from "@/features/connection-status"
import {
  loadRuntimeConfiguration,
  MAX_PENDING_ICE_CANDIDATES,
  isRetryableSignalingClose,
  parseServerSignal,
} from "@/features/signaling"
import { socketUrl, type Session } from "@/features/session"

const ICE_RECOVERY_TIMEOUT_MS = 25_000
const MAX_SIGNALING_RECONNECT_ATTEMPTS = 5
const SIGNALING_RECONNECT_BASE_MS = 1_000

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
  const sessionRef = useRef<Session | null>(null)
  const intentionalStopRef = useRef(true)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const connectSocketRef = useRef<
    ((session: Session, generation: number) => void) | null
  >(null)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    infoStatus("输入房间信息或使用发送端分享链接"),
  )
  const [hasMedia, setHasMedia] = useState(false)

  const closePeerConnection = useCallback(
    (clearCandidates = true, updateState = true) => {
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
      if (updateState) setHasMedia(false)
    },
    [],
  )

  const releaseResources = useCallback(
    (updateState: boolean) => {
      generationRef.current += 1
      activeRef.current = false
      intentionalStopRef.current = true
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      reconnectAttemptRef.current = 0
      configControllerRef.current?.abort()
      configControllerRef.current = null
      const socket = socketRef.current
      socketRef.current = null
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000)
      closePeerConnection(true, updateState)
      if (updateState) setRunning(false)
    },
    [closePeerConnection],
  )

  const stop = useCallback(
    (nextStatus: ConnectionStatus = infoStatus("已停止接收")) => {
      intentionalStopRef.current = true
      releaseResources(true)
      setStatus(nextStatus)
    },
    [releaseResources],
  )

  const scheduleSignalingReconnect = useCallback(
    (generation: number) => {
      if (
        intentionalStopRef.current ||
        !activeRef.current ||
        generationRef.current !== generation ||
        reconnectTimerRef.current !== null
      ) {
        return
      }

      const attempt = reconnectAttemptRef.current + 1
      if (attempt > MAX_SIGNALING_RECONNECT_ATTEMPTS) {
        stop(errorStatus("信令服务多次重连失败，请检查网络后重试"))
        return
      }

      reconnectAttemptRef.current = attempt
      const delay = Math.min(
        SIGNALING_RECONNECT_BASE_MS * 2 ** (attempt - 1),
        30_000,
      )
      setStatus(
        infoStatus(
          `信令连接已断开，将在 ${Math.ceil(delay / 1000)} 秒后重连（${attempt}/${MAX_SIGNALING_RECONNECT_ATTEMPTS}）`,
        ),
      )
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null
        if (
          intentionalStopRef.current ||
          !activeRef.current ||
          generationRef.current !== generation
        ) {
          return
        }
        const session = sessionRef.current
        if (session) connectSocketRef.current?.(session, generation)
      }, delay)
    },
    [stop],
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
        setStatus(successStatus("视频连接已建立"))
      } else if (connection.connectionState === "failed") {
        closePeerConnection()
        setStatus(errorStatus("视频连接失败，请停止后重试"))
      } else {
        setStatus(connectionStateStatus(connection.connectionState))
      }
    }
    connection.oniceconnectionstatechange = () => {
      if (
        connectionRef.current === connection &&
        connection.iceConnectionState === "disconnected"
      ) {
        setStatus(infoStatus("视频连接暂时中断，正在恢复..."))
        if (recoveryTimerRef.current === null) {
          recoveryTimerRef.current = window.setTimeout(() => {
            recoveryTimerRef.current = null
            if (
              connectionRef.current === connection &&
              connection.connectionState !== "connected"
            ) {
              closePeerConnection()
              setStatus(errorStatus("连接恢复超时，请停止后重新接收"))
            }
          }, ICE_RECOVERY_TIMEOUT_MS)
        }
      }
    }
    connection.ontrack = (event) => {
      if (connectionRef.current !== connection || !videoRef.current) return
      videoRef.current.srcObject =
        event.streams[0] ?? new MediaStream([event.track])
      setHasMedia(true)
      void videoRef.current.play().catch(() => {
        if (connectionRef.current === connection) {
          setStatus(infoStatus("已收到视频，请点击播放器开始播放"))
        }
      })
      setStatus(successStatus("已收到视频画面"))
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
          setStatus(infoStatus("已回复发送端，正在建立视频连接..."))
        }
      } catch {
        if (connectionRef.current === connection) {
          closePeerConnection()
          setStatus(errorStatus("无法处理发送端的连接请求，请停止后重试"))
        }
      }
    },
    [closePeerConnection, createPeerConnection, processIceCandidates, sendSignal],
  )

  const connectSocket = useCallback(
    (session: Session, generation: number) => {
      if (
        intentionalStopRef.current ||
        !activeRef.current ||
        generationRef.current !== generation
      ) {
        return
      }

      const socket = new WebSocket(socketUrl("recv", session))
      socketRef.current = socket
      socket.onopen = () => {
        if (
          socketRef.current === socket &&
          generationRef.current === generation
        ) {
          socket.send(JSON.stringify({ type: "authenticate", key: session.key }))
          setStatus(infoStatus("正在验证房间访问码..."))
        }
      }
      socket.onmessage = async (event) => {
        if (
          socketRef.current !== socket ||
          generationRef.current !== generation
        ) {
          return
        }
        const signal = parseServerSignal(event.data)
        if (!signal) return

        if (signal.type === "authenticated") {
          reconnectAttemptRef.current = 0
          rtcConfigurationRef.current = { iceServers: signal.iceServers }
          maxReceiversRef.current = signal.maxReceivers
          setStatus(successStatus(`已加入 ${session.room}，等待发送端...`))
          sendSignal({ type: "receiver-ready" })
          return
        }
        if (signal.type === "peer-left" && signal.role === "send") {
          closePeerConnection()
          setStatus(infoStatus("发送端已离线，继续等待重新连接..."))
          return
        }
        if (signal.type === "error") {
          setStatus(errorStatus(`连接服务返回错误：${signal.message}`))
          return
        }
        if ("sdp" in signal && signal.sdp.type === "offer") {
          await handleOffer(signal.sdp)
        } else if ("ice" in signal) {
          if (iceCandidatesRef.current.length >= MAX_PENDING_ICE_CANDIDATES) {
            stop(errorStatus("收到过多连接候选，连接已关闭，请重新加入"))
            return
          }
          iceCandidatesRef.current.push(signal.ice)
          if (connectionRef.current) {
            await processIceCandidates(connectionRef.current)
          }
        }
      }
      socket.onerror = () => {
        if (socketRef.current === socket) {
          setStatus(infoStatus("信令连接中断，正在准备恢复..."))
        }
      }
      socket.onclose = (event) => {
        if (socketRef.current !== socket) return
        if (!isRetryableSignalingClose(event.code)) {
          stop(receiverCloseStatus(event.code, maxReceiversRef.current))
          return
        }
        socketRef.current = null
        closePeerConnection()
        scheduleSignalingReconnect(generation)
      }
      setStatus(infoStatus("正在连接信令服务..."))
    },
    [
      closePeerConnection,
      handleOffer,
      processIceCandidates,
      scheduleSignalingReconnect,
      sendSignal,
      stop,
    ],
  )

  const start = useCallback(
    async (session: Session) => {
      if (activeRef.current) return
      const environmentIssue = receiverEnvironmentIssue(
        currentBrowserEnvironment(),
      )
      if (environmentIssue) {
        setStatus(environmentIssue)
        return
      }
      activeRef.current = true
      intentionalStopRef.current = false
      sessionRef.current = session
      reconnectAttemptRef.current = 0

      const generation = generationRef.current + 1
      generationRef.current = generation
      setRunning(true)
      setStatus(infoStatus("正在加载连接配置..."))
      if (videoRef.current) videoRef.current.muted = true

      const configController = new AbortController()
      configControllerRef.current = configController
      let runtimeConfiguration: Awaited<
        ReturnType<typeof loadRuntimeConfiguration>
      >
      try {
        runtimeConfiguration = await loadRuntimeConfiguration(
          configController.signal,
        )
      } catch (error) {
        if (generationRef.current !== generation) return
        const message = error instanceof Error ? error.message : String(error)
        stop(errorStatus(message))
        return
      }
      if (configControllerRef.current === configController) {
        configControllerRef.current = null
      }
      if (generationRef.current !== generation) return
      rtcConfigurationRef.current = runtimeConfiguration.rtcConfiguration
      maxReceiversRef.current = runtimeConfiguration.maxReceivers

      connectSocket(session, generation)
    },
    [
      connectSocket,
      stop,
    ],
  )

  useEffect(() => {
    connectSocketRef.current = connectSocket
    return () => {
      if (connectSocketRef.current === connectSocket) {
        connectSocketRef.current = null
      }
    }
  }, [connectSocket])

  useEffect(() => () => releaseResources(false), [releaseResources])

  return {
    videoRef,
    running,
    status,
    hasMedia,
    start,
    stop,
  }
}

function receiverCloseStatus(
  code: number,
  maxReceivers: number,
): ConnectionStatus {
  switch (code) {
    case 4000:
      return errorStatus("房间验证请求无效，请重新加入")
    case 4003:
      return errorStatus("访问码不正确，这个房间已使用其他访问码")
    case 4008:
      return errorStatus("连接长时间无响应，请重新加入")
    case 4010:
      return errorStatus(`房间接收端已满，最多支持 ${maxReceivers} 个`)
    case 4011:
      return errorStatus("当前房间数量已达服务上限，请稍后重试")
    case 4012:
      return errorStatus("房间验证超时，请重新加入")
    case 4028:
      return errorStatus("访问码尝试次数过多，请稍后重试")
    case 4029:
      return errorStatus("连接消息发送过快，服务已关闭连接")
    case 4030:
      return errorStatus("中继凭据请求过多，请稍后重试")
    case 1012:
      return errorStatus("服务正在重启，请稍后重新连接")
    case 1006:
      return errorStatus("无法加入房间，请检查房间信息和服务状态")
    default:
      return errorStatus("信令连接已关闭，请检查网络后重新加入")
  }
}
