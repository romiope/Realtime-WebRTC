"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: Date;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected";

export default function VoiceChat() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputVolume, setInputVolume] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Track partial transcripts by item_id
  const partialTranscriptsRef = useRef<Map<string, string>>(new Map());

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const monitorVolume = useCallback((stream: MediaStream) => {
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserRef.current = analyser;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      setInputVolume(avg / 255);
      animFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setStatus("connecting");

    try {
      // 1. Get ephemeral token from our API
      const tokenRes = await fetch("/api/session", { method: "POST" });
      if (!tokenRes.ok) {
        const errData = await tokenRes.json();
        throw new Error(errData.error || "Failed to get session token");
      }
      const sessionData = await tokenRes.json();
      const ephemeralKey = sessionData.client_secret?.value;

      if (!ephemeralKey) {
        throw new Error("No ephemeral key received from server");
      }

      // 2. Set up WebRTC peer connection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // 3. Set up remote audio playback
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = false;
      audioEl.style.position = "absolute";
      audioEl.style.opacity = "0";
      audioEl.style.pointerEvents = "none";
      document.body.appendChild(audioEl);
      audioElRef.current = audioEl;

      pc.ontrack = (event) => {
        // event.streams can be empty in Unified Plan – create stream from track if needed
        const stream =
          event.streams?.[0] ?? new MediaStream([event.track]);
        audioEl.srcObject = stream;
        audioEl.play().catch((err) => {
          console.warn("Audio autoplay failed (user interaction may be required):", err);
        });
      };

      // 4. Capture microphone and add to peer connection
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // Monitor microphone volume
      monitorVolume(stream);

      // 5. Create data channel for events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        setStatus("connected");
      };

      dc.onmessage = (event) => {
        handleRealtimeEvent(JSON.parse(event.data));
      };

      dc.onclose = () => {
        setStatus("disconnected");
      };

      // 6. Create and set local SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 7. Send offer to OpenAI Realtime API
      const sdpRes = await fetch(
        "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ephemeralKey}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        }
      );

      if (!sdpRes.ok) {
        throw new Error("Failed to establish WebRTC connection with OpenAI");
      }

      // 8. Set remote SDP answer
      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (err) {
      console.error("Connection error:", err);
      setError(err instanceof Error ? err.message : "Connection failed");
      setStatus("disconnected");
      cleanup();
    }
  }, [monitorVolume]);

  const handleRealtimeEvent = useCallback((event: Record<string, unknown>) => {
    const type = event.type as string;

    switch (type) {
      case "response.audio_transcript.delta": {
        const itemId = event.item_id as string;
        const delta = event.delta as string;
        const existing = partialTranscriptsRef.current.get(itemId) ?? "";
        const updated = existing + delta;
        partialTranscriptsRef.current.set(itemId, updated);

        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === itemId);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = { ...copy[idx], text: updated };
            return copy;
          }
          return [
            ...prev,
            {
              id: itemId,
              role: "assistant",
              text: updated,
              timestamp: new Date(),
            },
          ];
        });
        setIsAiSpeaking(true);
        break;
      }

      case "response.audio_transcript.done": {
        const itemId = event.item_id as string;
        const transcript = event.transcript as string;
        partialTranscriptsRef.current.delete(itemId);

        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === itemId);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = { ...copy[idx], text: transcript };
            return copy;
          }
          return [
            ...prev,
            {
              id: itemId,
              role: "assistant",
              text: transcript,
              timestamp: new Date(),
            },
          ];
        });
        setIsAiSpeaking(false);
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const itemId = event.item_id as string;
        const transcript = event.transcript as string;
        if (transcript?.trim()) {
          setMessages((prev) => [
            ...prev,
            {
              id: itemId,
              role: "user",
              text: transcript.trim(),
              timestamp: new Date(),
            },
          ]);
        }
        break;
      }

      case "response.audio.done": {
        setIsAiSpeaking(false);
        break;
      }

      case "error": {
        console.error("Realtime API error:", event);
        const errMsg = (event.error as Record<string, unknown>)?.message as string;
        setError(errMsg || "An error occurred");
        break;
      }
    }
  }, []);

  const cleanup = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current.remove();
      audioElRef.current = null;
    }

    analyserRef.current = null;
    setInputVolume(0);
    setIsAiSpeaking(false);
  }, []);

  const disconnect = useCallback(() => {
    cleanup();
    setStatus("disconnected");
  }, [cleanup]);

  return (
    <div className="flex flex-col h-full w-full max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full transition-colors ${
              status === "connected"
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                : status === "connecting"
                ? "bg-amber-400 animate-pulse"
                : "bg-zinc-600"
            }`}
          />
          <span className="text-sm text-zinc-400 font-medium">
            {status === "connected"
              ? "Connected"
              : status === "connecting"
              ? "Connecting..."
              : "Disconnected"}
          </span>
        </div>

        {status === "connected" && (
          <button
            onClick={disconnect}
            className="text-xs text-zinc-500 hover:text-red-400 transition-colors px-3 py-1.5 rounded-lg hover:bg-red-400/10"
          >
            End Session
          </button>
        )}
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4 scrollbar-thin">
        {messages.length === 0 && status !== "connected" && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-6 py-20">
            <div className="relative">
              <div className="w-24 h-24 rounded-full bg-linear-to-br from-violet-500/20 to-indigo-500/20 flex items-center justify-center">
                <svg
                  className="w-10 h-10 text-violet-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
                  />
                </svg>
              </div>
              <div className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-linear-to-br from-emerald-500/20 to-teal-500/20 flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-emerald-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
                  />
                </svg>
              </div>
            </div>
            <div>
              <h2 className="text-xl font-semibold text-zinc-100 mb-2">
                Voice Chat with AI
              </h2>
              <p className="text-zinc-500 text-sm max-w-xs leading-relaxed">
                Start a conversation by pressing the button below. Speak
                naturally and the AI will respond with voice.
              </p>
            </div>
          </div>
        )}

        {messages.length === 0 && status === "connected" && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-20">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center animate-pulse">
                <svg
                  className="w-8 h-8 text-emerald-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
                  />
                </svg>
              </div>
            </div>
            <p className="text-zinc-400 text-sm">
              Listening... start speaking anytime
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${
              msg.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                msg.role === "user"
                  ? "bg-violet-600/20 text-violet-100 rounded-br-md"
                  : "bg-zinc-800/80 text-zinc-200 rounded-bl-md"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                {msg.role === "assistant" && (
                  <svg
                    className="w-3.5 h-3.5 text-emerald-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                    />
                  </svg>
                )}
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">
                  {msg.role === "user" ? "You" : "AI"}
                </span>
              </div>
              <p className="text-sm leading-relaxed">{msg.text}</p>
            </div>
          </div>
        ))}

        {isAiSpeaking && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1.5 px-4 py-2">
              <div className="flex gap-1 items-center">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-1 bg-emerald-400 rounded-full animate-pulse"
                    style={{
                      height: `${12 + Math.random() * 8}px`,
                      animationDelay: `${i * 0.15}s`,
                    }}
                  />
                ))}
              </div>
              <span className="text-xs text-zinc-500 ml-2">Speaking...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-6 mb-3 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400/60 hover:text-red-400 ml-3"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="px-6 py-6 border-t border-white/5">
        <div className="flex flex-col items-center gap-4">
          {/* Volume Indicator */}
          {status === "connected" && (
            <div className="flex items-center gap-1.5 h-6">
              {Array.from({ length: 20 }).map((_, i) => (
                <div
                  key={i}
                  className="w-1 rounded-full transition-all duration-75"
                  style={{
                    height: `${4 + (inputVolume > i / 20 ? inputVolume * 20 : 0)}px`,
                    backgroundColor:
                      inputVolume > i / 20
                        ? `rgba(139, 92, 246, ${0.4 + inputVolume * 0.6})`
                        : "rgba(63, 63, 70, 0.5)",
                  }}
                />
              ))}
            </div>
          )}

          {/* Main Button */}
          <button
            onClick={status === "disconnected" ? connect : disconnect}
            disabled={status === "connecting"}
            className={`group relative w-20 h-20 rounded-full transition-all duration-300 ${
              status === "connected"
                ? "bg-red-500/20 hover:bg-red-500/30 shadow-[0_0_30px_rgba(239,68,68,0.15)]"
                : status === "connecting"
                ? "bg-amber-500/20 cursor-wait"
                : "bg-violet-500/20 hover:bg-violet-500/30 shadow-[0_0_30px_rgba(139,92,246,0.15)] hover:shadow-[0_0_40px_rgba(139,92,246,0.25)]"
            }`}
          >
            {/* Pulse ring */}
            {status === "connected" && (
              <div className="absolute inset-0 rounded-full bg-red-500/10 animate-ping" />
            )}
            {status === "connecting" && (
              <div className="absolute inset-0 rounded-full bg-amber-500/10 animate-ping" />
            )}

            <div className="relative flex items-center justify-center">
              {status === "connected" ? (
                <svg
                  className="w-8 h-8 text-red-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z"
                  />
                </svg>
              ) : status === "connecting" ? (
                <svg
                  className="w-8 h-8 text-amber-400 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              ) : (
                <svg
                  className="w-8 h-8 text-violet-400 group-hover:text-violet-300 transition-colors"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
                  />
                </svg>
              )}
            </div>
          </button>

          <p className="text-xs text-zinc-600">
            {status === "connected"
              ? "Tap to end session"
              : status === "connecting"
              ? "Requesting microphone access..."
              : "Tap to start voice chat"}
          </p>
        </div>
      </div>
    </div>
  );
}
