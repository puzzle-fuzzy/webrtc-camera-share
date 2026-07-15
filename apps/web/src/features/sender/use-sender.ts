import { useCallback, useEffect, useRef, useState } from "react"

import {
  loadRuntimeConfiguration,
  MAX_PENDING_ICE_CANDIDATES,
  parseServerSignal,
} from "@/features/signaling"
import { socketUrl, type Session } from "@/features/session"

const TOTAL_VIDEO_BITRATE_BUDGET = 6_000_000
const MIN_VIDEO_BITRATE_PER_VIEWER = 300_000
const MAX_VIDEO_BITRATE_PER_VIEWER = 2_500_000
const ICE_DISCONNECTED_GRACE_MS = 5_000
const ICE_RECOVERY_TIMEOUT_MS = 15_000

type PeerState = {
  connection: RTCPeerConnection
  iceCandidates: RTCIceCandidateInit[]
  localIceCandidates: RTCIceCandidateInit[]
  offerPending: boolean
  processingIce: boolean
  recoveryTimer?: number
  videoSender?: RTCRtpSender
}

type ViewerCount = {
  connected: number
  total: number
}

export function useSender() {
  const previewRef = useRef<HTMLVideoElement>(null)
  const socketRef = useRef<WebSocket>(null)
  const streamRef = useRef<MediaStream>(null)
  const configControllerRef = useRef<AbortController>(null)
  const rtcConfigurationRef = useRef<RTCConfiguration>({ iceServers: [] })
  const peersRef = useRef(new Map<string, PeerState>())
  const generationRef = useRef(0)
  const activeRef = useRef(false)
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

  const rebalanceVideoBitrates = useCallback(async () => {
    const peers = [...peersRef.current.values()].filter(
      (peer): peer is PeerState & { videoSender: RTCRtpSender } =>
        peer.videoSender !== undefined && peer.connection.connectionState !== "closed",
    )
    if (peers.length === 0) return

    const maxBitrate = Math.min(
      MAX_VIDEO_BITRATE_PER_VIEWER,
      Math.max(
        MIN_VIDEO_BITRATE_PER_VIEWER,
        Math.floor(TOTAL_VIDEO_BITRATE_BUDGET / peers.length),
      ),
    )
    await Promise.allSettled(
      peers.map(async ({ videoSender }) => {
        const parameters = videoSender.getParameters()
        if (parameters.encodings.length === 0) parameters.encodings = [{}]
        for (const encoding of parameters.encodings) encoding.maxBitrate = maxBitrate
        await videoSender.setParameters(parameters)
      }),
    )
  }, [])

  const closePeerConnection = useCallback(
    (peerId: string) => {
      const peer = peersRef.current.get(peerId)
      if (!peer) return

      peersRef.current.delete(peerId)
      if (peer.recoveryTimer !== undefined) clearTimeout(peer.recoveryTimer)
      peer.iceCandidates.length = 0
      peer.localIceCandidates.length = 0
      peer.connection.onicecandidate = null
      peer.connection.onconnectionstatechange = null
      peer.connection.oniceconnectionstatechange = null
      peer.connection.close()
      updateViewerCount()
      void rebalanceVideoBitrates()
    },
    [rebalanceVideoBitrates, updateViewerCount],
  )

  const closeAllPeerConnections = useCallback((updateState: boolean) => {
    for (const peer of peersRef.current.values()) {
      if (peer.recoveryTimer !== undefined) clearTimeout(peer.recoveryTimer)
      peer.iceCandidates.length = 0
      peer.localIceCandidates.length = 0
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
      activeRef.current = false
      configControllerRef.current?.abort()
      configControllerRef.current = null
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
        !peer.connection.remoteDescription ||
        peer.processingIce
      ) {
        return
      }

      peer.processingIce = true
      try {
        while (
          peersRef.current.get(peerId) === peer &&
          peer.iceCandidates.length > 0
        ) {
          const candidate = peer.iceCandidates.shift()
          if (!candidate) continue
          try {
            await peer.connection.addIceCandidate(candidate)
          } catch {}
        }
      } finally {
        peer.processingIce = false
      }
    },
    [],
  )

  const sendPeerOffer = useCallback(
    async (peerId: string, peer: PeerState, iceRestart = false) => {
      if (
        peersRef.current.get(peerId) !== peer ||
        socketRef.current?.readyState !== WebSocket.OPEN
      ) {
        return false
      }

      try {
        peer.offerPending = true
        const offer = await peer.connection.createOffer({ iceRestart })
        await peer.connection.setLocalDescription(offer)
        if (peersRef.current.get(peerId) !== peer) return false
        sendSignal({ peerId, sdp: offer })
        peer.offerPending = false
        for (const candidate of peer.localIceCandidates.splice(0)) {
          sendSignal({ peerId, ice: candidate })
        }
        return true
      } catch {
        if (peersRef.current.get(peerId) === peer) {
          closePeerConnection(peerId)
          setStatus(
            iceRestart
              ? "一个接收端恢复连接失败，已释放该连接"
              : "为一个接收端创建连接失败",
          )
        }
        return false
      }
    },
    [closePeerConnection, sendSignal],
  )

  const scheduleIceRecovery = useCallback(
    (peerId: string, peer: PeerState) => {
      if (peer.recoveryTimer !== undefined) return
      peer.recoveryTimer = window.setTimeout(() => {
        peer.recoveryTimer = undefined
        if (
          peersRef.current.get(peerId) !== peer ||
          peer.connection.connectionState === "connected"
        ) {
          return
        }

        setStatus("一个接收端连接中断，正在尝试 ICE 恢复...")
        void sendPeerOffer(peerId, peer, true).then((sent) => {
          if (!sent || peersRef.current.get(peerId) !== peer) return
          peer.recoveryTimer = window.setTimeout(() => {
            peer.recoveryTimer = undefined
            if (
              peersRef.current.get(peerId) === peer &&
              peer.connection.connectionState !== "connected"
            ) {
              closePeerConnection(peerId)
              setStatus("一个接收端恢复超时，已释放该连接")
            }
          }, ICE_RECOVERY_TIMEOUT_MS)
        })
      }, ICE_DISCONNECTED_GRACE_MS)
    },
    [closePeerConnection, sendPeerOffer],
  )

  const createAndSendOffer = useCallback(
    async (peerId: string) => {
      const stream = streamRef.current
      if (!stream || socketRef.current?.readyState !== WebSocket.OPEN) return

      closePeerConnection(peerId)
      const connection = new RTCPeerConnection(rtcConfigurationRef.current)
      const peer: PeerState = {
        connection,
        iceCandidates: [],
        localIceCandidates: [],
        offerPending: true,
        processingIce: false,
      }
      peersRef.current.set(peerId, peer)
      for (const track of stream.getTracks()) {
        const sender = connection.addTrack(track, stream)
        if (track.kind === "video") peer.videoSender = sender
      }

      connection.onicecandidate = (event) => {
        if (peersRef.current.get(peerId) === peer && event.candidate) {
          const candidate = event.candidate.toJSON()
          if (peer.offerPending) {
            if (peer.localIceCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
              closePeerConnection(peerId)
              setStatus("本地 ICE 候选过多，已释放该连接")
              return
            }
            peer.localIceCandidates.push(candidate)
          } else {
            sendSignal({ peerId, ice: candidate })
          }
        }
      }
      connection.onconnectionstatechange = () => {
        if (peersRef.current.get(peerId) !== peer) return
        updateViewerCount()

        if (connection.connectionState === "connected") {
          if (peer.recoveryTimer !== undefined) {
            clearTimeout(peer.recoveryTimer)
            peer.recoveryTimer = undefined
          }
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
          scheduleIceRecovery(peerId, peer)
        }
      }

      updateViewerCount()
      void rebalanceVideoBitrates()
      setStatus(`${peersRef.current.size} 个接收端已加入，正在协商...`)

      await sendPeerOffer(peerId, peer)
    },
    [
      closePeerConnection,
      rebalanceVideoBitrates,
      scheduleIceRecovery,
      sendPeerOffer,
      sendSignal,
      updateViewerCount,
    ],
  )

  const start = useCallback(
    async (session: Session) => {
      if (activeRef.current) return
      activeRef.current = true

      const generation = generationRef.current + 1
      generationRef.current = generation
      setRunning(true)
      setStatus("正在请求摄像头权限...")

      try {
        const configController = new AbortController()
        configControllerRef.current = configController
        const runtimeConfigurationPromise = loadRuntimeConfiguration(
          configController.signal,
        )
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
        const runtimeConfiguration = await runtimeConfigurationPromise
        if (configControllerRef.current === configController) {
          configControllerRef.current = null
        }
        if (generationRef.current !== generation) return
        rtcConfigurationRef.current = runtimeConfiguration.rtcConfiguration
        if (previewRef.current) {
          previewRef.current.srcObject = stream
          await previewRef.current.play()
        }
        if (generationRef.current !== generation) return

        const socket = new WebSocket(socketUrl("send", session))
        socketRef.current = socket
        socket.onopen = () => {
          if (socketRef.current === socket) {
            socket.send(JSON.stringify({ type: "authenticate", key: session.key }))
            setStatus("正在验证房间访问码...")
          }
        }
        socket.onmessage = async (event) => {
          if (socketRef.current !== socket) return
          const signal = parseServerSignal(event.data)
          if (!signal) return

          if (signal.type === "authenticated") {
            rtcConfigurationRef.current = { iceServers: signal.iceServers }
            setStatus(`已加入 ${session.room}，等待接收端...`)
            return
          }
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
            try {
              await peer.connection.setRemoteDescription(signal.sdp)
              await processIceCandidates(signal.peerId, peer)
              if (peersRef.current.get(signal.peerId) === peer) {
                setStatus("已收到接收端应答，正在建立连接...")
              }
            } catch {
              if (peersRef.current.get(signal.peerId) === peer) {
                closePeerConnection(signal.peerId)
                setStatus("接收端应答无效，已关闭该连接")
              }
            }
          } else if ("ice" in signal && signal.peerId) {
            const peer = peersRef.current.get(signal.peerId)
            if (!peer) return
            if (peer.iceCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
              closePeerConnection(signal.peerId)
              setStatus("一个接收端发送了过多 ICE 候选，已关闭该连接")
              return
            }
            peer.iceCandidates.push(signal.ice)
            await processIceCandidates(signal.peerId, peer)
          }
        }
        socket.onerror = () => {
          if (socketRef.current === socket) setStatus("WebSocket 连接错误")
        }
        socket.onclose = (event) => {
          if (socketRef.current !== socket) return
          stop(senderCloseMessage(event.code))
        }
        setStatus("正在连接信令服务...")
      } catch (error) {
        if (generationRef.current !== generation) return
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

function senderCloseMessage(code: number): string {
  switch (code) {
    case 4000:
      return "鉴权请求无效"
    case 4003:
      return "访问码不正确，房间已由其他访问码创建"
    case 4008:
      return "连接空闲超时，请重新开始"
    case 4009:
      return "该房间已有发送端在线"
    case 4028:
      return "访问码尝试次数过多，请稍后重试"
    case 4011:
      return "服务房间数量已达上限，请稍后重试"
    case 4012:
      return "房间鉴权超时，请重新开始"
    case 4029:
      return "信令发送过快，连接已关闭"
    case 4030:
      return "临时 TURN 凭据请求过多，请稍后重试"
    default:
      return "信令连接已关闭"
  }
}
