"use client";

import {
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
  useParticipants,
  useRoomContext,
} from "@livekit/components-react";
import {
  AudioPresets,
  ConnectionState,
  LocalAudioTrack,
  Participant,
  Room,
  RoomEvent,
  createLocalAudioTrack,
} from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  DATA_TOPIC,
  MAX_COMMENT_LENGTH,
  REACTION_COOLDOWN_MS,
  REACTION_OPTIONS,
  decodeEvent,
  encodeEvent,
  findHostParticipant,
  formatElapsedTime,
  getProgrammeName,
  hasPublishedMicrophone,
  parseRoomBroadcastState,
  parseParticipantProfile,
  statusLabel,
} from "@/lib/livekit";
import type {
  ChatMessage,
  ParticipantProfile,
  ReactionEvent,
  ReactionSymbol,
  RoomBroadcastState,
  VoxEvent,
  VoxRole,
} from "@/lib/types";
import { VoxWordmark } from "@/components/vox-wordmark";

export type RoomSession = {
  token: string;
  livekitUrl: string;
  roomName: string;
  identity: string;
  profile: ParticipantProfile;
};

type VoxRoomClientProps = {
  mode: VoxRole;
  session: RoomSession;
  hostPasscode?: string;
  onLeave: () => void;
};

type FloatingReaction = ReactionEvent & {
  lane: number;
};

const AUDIO_QUALITY_OPTIONS = [
  {
    value: "data_saver",
    label: "Data saver (24 kbps)",
    helper: "Best for weaker mobile data connections.",
    preset: AudioPresets.speech,
  },
  {
    value: "balanced",
    label: "Balanced (48 kbps)",
    helper: "Recommended for speech, worship music, and most live sessions.",
    preset: AudioPresets.music,
  },
  {
    value: "fuller_sound",
    label: "Fuller sound (64 kbps stereo)",
    helper: "Uses more data for a richer mixer feed.",
    preset: AudioPresets.musicStereo,
  },
] as const;

type AudioQualityOption = (typeof AUDIO_QUALITY_OPTIONS)[number];
type AudioQualityValue = AudioQualityOption["value"];

function getAudioQualityOption(value: AudioQualityValue) {
  return (
    AUDIO_QUALITY_OPTIONS.find((option) => option.value === value) ?? AUDIO_QUALITY_OPTIONS[1]
  );
}

function appendUniqueMessage(list: ChatMessage[], message: ChatMessage) {
  if (list.some((item) => item.id === message.id)) {
    return list;
  }

  return [...list, message].slice(-200);
}

function buildAudioCaptureOptions(deviceId: string | undefined, musicMode: boolean) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: !musicMode,
    noiseSuppression: !musicMode,
    autoGainControl: !musicMode,
    channelCount: musicMode ? 2 : 1,
  };
}

function formatClock(sentAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(sentAt);
}

export function VoxRoomClient({ mode, onLeave, session, hostPasscode }: VoxRoomClientProps) {
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const room = useMemo(
    () =>
      new Room({
        adaptiveStream: true,
        dynacast: true,
        publishDefaults: {
          audioPreset: AudioPresets.music,
          dtx: true,
          red: true,
          stopMicTrackOnMute: false,
        },
      }),
    [],
  );

  useEffect(() => {
    return () => {
      void room.disconnect();
    };
  }, [room]);

  return (
    <LiveKitRoom
      audio={false}
      connect
      connectOptions={{ autoSubscribe: true }}
      room={room}
      serverUrl={session.livekitUrl}
      token={session.token}
      video={false}
      onError={(error) => setConnectionError(error.message)}
    >
      <VoxRoomInner
        connectionError={connectionError}
        hostPasscode={hostPasscode}
        mode={mode}
        onLeave={onLeave}
        session={session}
      />
      <RoomAudioRenderer room={room} />
    </LiveKitRoom>
  );
}

function VoxRoomInner({
  connectionError,
  hostPasscode,
  mode,
  onLeave,
  session,
}: {
  connectionError: string | null;
  hostPasscode?: string;
  mode: VoxRole;
  onLeave: () => void;
  session: RoomSession;
}) {
  const programmeName = getProgrammeName();
  const room = useRoomContext();
  const participants = useParticipants();
  const connectionState = useConnectionState(room);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const commentsEndRef = useRef<HTMLDivElement | null>(null);
  const leaveRequestedRef = useRef(false);
  const reactionCooldownRef = useRef(0);
  const reactionTimersRef = useRef<number[]>([]);
  const previousConnectionStateRef = useRef(connectionState);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [comment, setComment] = useState("");
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [moderationBusyId, setModerationBusyId] = useState<string | null>(null);
  const [broadcastState, setBroadcastState] = useState<RoomBroadcastState>(() =>
    parseRoomBroadcastState(room.metadata),
  );
  const [now, setNow] = useState(() => Date.now());
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [showNewCommentsCue, setShowNewCommentsCue] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const allParticipants = useMemo(() => {
    const byIdentity = new Map<string, Participant>();
    if (room.localParticipant?.identity) {
      byIdentity.set(room.localParticipant.identity, room.localParticipant);
    }

    participants.forEach((participant) => {
      byIdentity.set(participant.identity, participant);
    });

    return Array.from(byIdentity.values());
  }, [participants, room.localParticipant]);

  const listenerCount = useMemo(
    () =>
      allParticipants.filter((participant) => parseParticipantProfile(participant).role === "listener")
        .length,
    [allParticipants],
  );
  const hostParticipant = useMemo(() => findHostParticipant(allParticipants), [allParticipants]);
  const hostProfile = hostParticipant ? parseParticipantProfile(hostParticipant) : null;
  const hostIsLive = hasPublishedMicrophone(hostParticipant);
  const roomBroadcastStatus =
    broadcastState.updatedAt > 0
      ? broadcastState.status
      : hostIsLive
        ? "live"
        : hostParticipant
          ? "paused"
          : "waiting";
  const liveStartedAt = roomBroadcastStatus === "live" ? broadcastState.liveStartedAt : null;
  const liveElapsedLabel = liveStartedAt ? formatElapsedTime(now - liveStartedAt) : null;
  const liveStatus =
    connectionState === ConnectionState.Reconnecting
      ? "reconnecting"
      : roomBroadcastStatus;

  useEffect(() => {
    setBroadcastState(parseRoomBroadcastState(room.metadata));

    const handleRoomMetadataChanged = (metadata: string) => {
      setBroadcastState(parseRoomBroadcastState(metadata));
    };

    room.on(RoomEvent.RoomMetadataChanged, handleRoomMetadataChanged);

    return () => {
      room.off(RoomEvent.RoomMetadataChanged, handleRoomMetadataChanged);
    };
  }, [room]);

  useEffect(() => {
    if (!liveStartedAt || liveStatus !== "live") {
      return;
    }

    setNow(Date.now());
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [liveStartedAt, liveStatus]);

  useEffect(() => {
    const syncPlayback = () => {
      setPlaybackBlocked(!room.canPlaybackAudio);
    };

    syncPlayback();
    room.on(RoomEvent.AudioPlaybackStatusChanged, syncPlayback);

    return () => {
      room.off(RoomEvent.AudioPlaybackStatusChanged, syncPlayback);
    };
  }, [room]);

  useEffect(() => {
    if (connectionState === ConnectionState.Connected && !leaveRequestedRef.current) {
      setRoomNotice(null);
    }

    if (connectionState === ConnectionState.Disconnected && !leaveRequestedRef.current) {
      setRoomNotice("The room connection ended. Join again to continue listening.");
    }
  }, [connectionState]);

  useEffect(() => {
    let timeoutId: number | undefined;
    const previousState = previousConnectionStateRef.current;

    if (connectionState === ConnectionState.Reconnecting) {
      setConnectionNotice("Reconnecting...");
    } else if (
      connectionState === ConnectionState.Connected &&
      previousState === ConnectionState.Reconnecting
    ) {
      setConnectionNotice("Connection restored.");
      timeoutId = window.setTimeout(() => {
        setConnectionNotice(null);
      }, 3000);
    } else if (connectionState === ConnectionState.Connected) {
      setConnectionNotice(null);
    }

    previousConnectionStateRef.current = connectionState;

    return () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [connectionState]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setVoiceLevel(hostParticipant?.audioLevel ?? 0);
    }, 120);

    return () => {
      window.clearInterval(interval);
    };
  }, [hostParticipant]);

  useEffect(() => {
    const handleData = (payload: Uint8Array, _participant?: unknown, _kind?: unknown, topic?: string) => {
      if (topic !== DATA_TOPIC) {
        return;
      }

      const event = decodeEvent(payload);
      if (!event) {
        return;
      }

      if (event.type === "chat") {
        setMessages((current) => appendUniqueMessage(current, event));
        return;
      }

      if (event.type === "reaction") {
        const lane = Math.floor(Math.random() * 6);
        setFloatingReactions((current) =>
          current.some((item) => item.id === event.id) ? current : [...current, { ...event, lane }],
        );

        const timeoutId = window.setTimeout(() => {
          setFloatingReactions((current) => current.filter((item) => item.id !== event.id));
        }, 4000);

        reactionTimersRef.current.push(timeoutId);
        return;
      }

      if (event.type === "moderation_remove") {
        setMessages((current) => current.filter((message) => message.identity !== event.identity));
      }
    };

    room.on(RoomEvent.DataReceived, handleData);

    return () => {
      room.off(RoomEvent.DataReceived, handleData);
      reactionTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      reactionTimersRef.current = [];
    };
  }, [room]);

  useEffect(() => {
    if (shouldAutoScroll) {
      commentsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      setShowNewCommentsCue(false);
      return;
    }

    if (messages.length > 0) {
      setShowNewCommentsCue(true);
    }
  }, [messages.length, shouldAutoScroll]);

  const publishEvent = useCallback(
    async (event: VoxEvent, reliable: boolean) => {
      await room.localParticipant.publishData(encodeEvent(event), {
        reliable,
        topic: DATA_TOPIC,
      });
    },
    [room],
  );

  const handleSendComment = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const text = comment.trim();
      if (!text) {
        return;
      }

      const chatMessage: ChatMessage = {
        id: crypto.randomUUID(),
        identity: session.identity,
        displayName: session.profile.displayName,
        role: session.profile.role,
        text,
        sentAt: Date.now(),
      };

      setMessages((current) => appendUniqueMessage(current, chatMessage));
      setComment("");

      try {
        await publishEvent({ type: "chat", ...chatMessage }, true);
      } catch (error) {
        setRoomNotice(error instanceof Error ? error.message : "Comment could not be sent.");
      }
    },
    [comment, publishEvent, session.identity, session.profile.displayName, session.profile.role],
  );

  const handleReaction = useCallback(
    async (emoji: ReactionSymbol) => {
      const now = Date.now();
      if (now - reactionCooldownRef.current < REACTION_COOLDOWN_MS) {
        return;
      }

      reactionCooldownRef.current = now;
      const reaction: ReactionEvent = {
        id: crypto.randomUUID(),
        identity: session.identity,
        displayName: session.profile.displayName,
        emoji,
        sentAt: now,
      };

      setFloatingReactions((current) => [...current, { ...reaction, lane: Math.floor(Math.random() * 6) }]);
      const timeoutId = window.setTimeout(() => {
        setFloatingReactions((current) => current.filter((item) => item.id !== reaction.id));
      }, 4000);
      reactionTimersRef.current.push(timeoutId);

      try {
        await publishEvent({ type: "reaction", ...reaction }, false);
      } catch (error) {
        setRoomNotice(error instanceof Error ? error.message : "Reaction could not be sent.");
      }
    },
    [publishEvent, session.identity, session.profile.displayName],
  );

  const handleRemoveCommenter = useCallback(
    async (identity: string) => {
      if (!hostPasscode) {
        return;
      }

      const shouldRemove = window.confirm(
        "Remove this listener from the room? They can still rejoin later with a new session.",
      );
      if (!shouldRemove) {
        return;
      }

      setModerationBusyId(identity);
      try {
        const response = await fetch("/api/kick", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            identity,
            passcode: hostPasscode,
          }),
        });

        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "Unable to remove listener.");
        }

        setMessages((current) => current.filter((message) => message.identity !== identity));
        await publishEvent(
          {
            type: "moderation_remove",
            id: crypto.randomUUID(),
            identity,
            sentAt: Date.now(),
          },
          true,
        );
      } catch (error) {
        setRoomNotice(error instanceof Error ? error.message : "Unable to remove listener.");
      } finally {
        setModerationBusyId(null);
      }
    },
    [hostPasscode, publishEvent],
  );

  const handleMessagesScroll = useCallback(() => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }

    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    setShouldAutoScroll(nearBottom);

    if (nearBottom) {
      setShowNewCommentsCue(false);
    }
  }, []);

  const handleJumpToLatest = useCallback(() => {
    setShouldAutoScroll(true);
    setShowNewCommentsCue(false);
    commentsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  const handleStartAudio = useCallback(async () => {
    try {
      await room.startAudio();
      setPlaybackBlocked(false);
      setPlaybackError(null);
    } catch (error) {
      setPlaybackError(error instanceof Error ? error.message : "Audio playback is still blocked.");
    }
  }, [room]);

  const handleLeave = useCallback(async () => {
    if (mode === "host" && hostIsLive) {
      const shouldLeave = window.confirm(
        "You are still live. Leaving now will end the broadcast for everyone. Leave anyway?",
      );
      if (!shouldLeave) {
        return;
      }
    }

    leaveRequestedRef.current = true;
    await room.disconnect();
    onLeave();
  }, [hostIsLive, mode, onLeave, room]);

  const handleShare = useCallback(async () => {
    const shareUrl = window.location.origin;

    try {
      if (navigator.share) {
        await navigator.share({
          title: `${programmeName} on Vox`,
          text: `Join ${programmeName} live on Vox.`,
          url: shareUrl,
        });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        throw new Error("Sharing is not available on this device.");
      }

      setShareNotice("Invite link ready to share.");
      window.setTimeout(() => {
        setShareNotice(null);
      }, 2500);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }

      setShareNotice(
        error instanceof Error ? error.message : "Could not prepare the invite link right now.",
      );
    }
  }, [programmeName]);

  return (
    <div className="vox-shell">
      <div className="vox-page vox-grid">
        <header className="vox-topbar">
          <div className="vox-topbar__brand">
            <VoxWordmark />
            <div>
              <p className="vox-topbar__eyebrow">{programmeName}</p>
              {mode === "host" && <h1 className="vox-topbar__title">Host console</h1>}
            </div>
          </div>
          <button className="vox-button-secondary" type="button" onClick={() => void handleLeave()}>
            Leave
          </button>
        </header>

        {(connectionError || roomNotice || playbackError) && (
          <div className="vox-banner" role="status">
            {connectionError || roomNotice || playbackError}
          </div>
        )}
        {connectionNotice && (
          <div className="vox-banner vox-banner--connection" role="status">
            {connectionNotice}
          </div>
        )}

        <div className="vox-stage-grid">
          <section className="vox-card vox-stage">
            <div className="vox-stage__meta">
              <div className="vox-pill" data-status={liveStatus}>
                {liveStatus === "live" && (
                  <span className="vox-live-beacon" aria-hidden="true">
                    <span className="vox-live-beacon__dot" />
                    <span className="vox-live-beacon__ring" />
                  </span>
                )}
                <span className="vox-status-dot" aria-hidden="true" />
                {statusLabel(liveStatus)}
              </div>
              {liveElapsedLabel && <div className="vox-pill">Live for {liveElapsedLabel}</div>}
              <div className="vox-pill">{listenerCount} listening</div>
            </div>

            <div className="vox-stage__hero">
              <div
                className="vox-signal"
                aria-hidden="true"
                style={
                  {
                    "--voice-level": String(Math.max(0.24, Math.min(1.2, 0.3 + voiceLevel * 3))),
                  } as CSSProperties
                }
              >
                <div className="vox-signal__ring vox-signal__ring--outer" />
                <div className="vox-signal__ring vox-signal__ring--mid" />
                <div className="vox-signal__core">
                  <span>{hostIsLive ? "On Air" : "Standby"}</span>
                </div>
              </div>

              <div className="vox-stage__copy">
                <h2>{hostProfile ? `${hostProfile.displayName} is live` : "Waiting for the host"}</h2>
                <p className="vox-stage__text">
                  {hostIsLive
                    ? "Stay connected, listen in, and encourage the room with comments and reactions."
                    : mode === "host"
                      ? "When you are ready, go live and your listeners will hear the programme here."
                      : "You are in the room early. Audio will begin here as soon as the host starts the programme."}
                </p>
                {mode === "listener" && (
                  <p className="vox-stage__hint">
                    Use earphones or raise your media volume if you cannot hear yet.
                  </p>
                )}
              </div>
            </div>

            {playbackBlocked && (
              <button className="vox-button" type="button" onClick={() => void handleStartAudio()}>
                Tap to turn on sound
              </button>
            )}

            {mode === "host" && hostPasscode && (
              <HostControls
                hasComments={messages.length > 0}
                liveElapsedLabel={liveElapsedLabel}
                hostPasscode={hostPasscode}
                listenerCount={listenerCount}
                publishEvent={publishEvent}
                room={room}
                setBroadcastState={setBroadcastState}
                setRoomNotice={setRoomNotice}
              />
            )}
          </section>

          <section className="vox-card vox-chat">
            <div className="vox-chat__header">
              <div>
                <h2>Live comments</h2>
                <p className="vox-helper">Messages only stay for the current live session in v1.</p>
              </div>
            </div>

            <div
              ref={messagesRef}
              className="vox-chat__messages"
              aria-live="polite"
              onScroll={handleMessagesScroll}
            >
              {messages.length === 0 ? (
                <div className="vox-empty">
                  <p>No comments yet.</p>
                  <span>
                    Be the first to welcome everyone and help the room feel warm from the start.
                  </span>
                </div>
              ) : (
                messages.map((message) => (
                  <article className="vox-message" key={message.id}>
                    <div className="vox-message__row">
                      <div className="vox-message__meta">
                        <strong>{message.displayName}</strong>
                        <span className="vox-message__badge" data-role={message.role}>
                          {message.role === "host" ? "Host" : "Listener"}
                        </span>
                        <time dateTime={new Date(message.sentAt).toISOString()}>
                          {formatClock(message.sentAt)}
                        </time>
                      </div>
                      {mode === "host" && message.role === "listener" && (
                        <button
                          className="vox-message__remove"
                          disabled={moderationBusyId === message.identity}
                          type="button"
                          onClick={() => void handleRemoveCommenter(message.identity)}
                        >
                          {moderationBusyId === message.identity ? "Removing..." : "Remove"}
                        </button>
                      )}
                    </div>
                    <p>{message.text}</p>
                  </article>
                ))
              )}
              <div ref={commentsEndRef} />
            </div>
            {showNewCommentsCue && (
              <button className="vox-chat__jump" type="button" onClick={handleJumpToLatest}>
                New comments
              </button>
            )}

            <form className="vox-chat__composer" onSubmit={handleSendComment}>
              <label className="vox-sr" htmlFor="vox-comment">
                Add a comment
              </label>
              <input
                id="vox-comment"
                className="vox-field"
                maxLength={MAX_COMMENT_LENGTH}
                placeholder="Type a comment for the room"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
              <div className="vox-chat__composer-row">
                <span className="vox-helper vox-mono">
                  {comment.trim().length}/{MAX_COMMENT_LENGTH}
                </span>
                <button className="vox-button" disabled={!comment.trim()} type="submit">
                  Send
                </button>
              </div>
            </form>
          </section>
        </div>

        {mode === "listener" && (
          <div className="vox-share-card">
            <div>
              <h2>Invite others</h2>
              <p className="vox-helper">Share this live session with anyone who should join in.</p>
            </div>
            <div className="vox-share-card__actions">
              <button className="vox-button-secondary" type="button" onClick={() => void handleShare()}>
                Share or copy link
              </button>
              {shareNotice && <span className="vox-helper">{shareNotice}</span>}
            </div>
          </div>
        )}

        <div className="vox-reactions" aria-label="Send a reaction">
          {REACTION_OPTIONS.map((emoji) => (
            <button
              key={emoji}
              className="vox-reactions__button"
              type="button"
              onClick={() => void handleReaction(emoji)}
            >
              <span aria-hidden="true">{emoji}</span>
              <span className="vox-sr">Send {emoji} reaction</span>
            </button>
          ))}
        </div>

        <div className="vox-floating-layer" aria-hidden="true">
          {floatingReactions.map((reaction) => (
            <span
              key={reaction.id}
              className="vox-floating-reaction"
              style={
                {
                  "--lane": String(reaction.lane),
                } as CSSProperties
              }
            >
              {reaction.emoji}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function HostControls({
  hasComments,
  liveElapsedLabel,
  hostPasscode,
  listenerCount,
  publishEvent,
  room,
  setBroadcastState,
  setRoomNotice,
}: {
  hasComments: boolean;
  liveElapsedLabel: string | null;
  hostPasscode: string;
  listenerCount: number;
  publishEvent: (event: VoxEvent, reliable: boolean) => Promise<void>;
  room: Room;
  setBroadcastState: (state: RoomBroadcastState) => void;
  setRoomNotice: (message: string | null) => void;
}) {
  const trackRef = useRef<LocalAudioTrack | null>(null);
  const [musicMode, setMusicMode] = useState(true);
  const [audioQuality, setAudioQuality] = useState<AudioQualityValue>("balanced");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [hostBusy, setHostBusy] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const selectedQualityOption = getAudioQualityOption(audioQuality);
  const selectedInputName =
    devices.find((device) => device.deviceId === selectedDeviceId)?.label ||
    (devices.length > 0 ? "Ready to choose" : "Waiting for microphone access");

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const nextDevices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "audioinput",
    );
    setDevices(nextDevices);
    setSelectedDeviceId((current) => current || nextDevices[0]?.deviceId || "");
  }, []);

  useEffect(() => {
    const setup = async () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        setRoomNotice("Mic permission is needed before you can pick an input and go live.");
      }

      await refreshDevices();
    };

    void setup();

    const mediaDevices = navigator.mediaDevices;
    const onDeviceChange = () => {
      void refreshDevices();
    };

    mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      trackRef.current?.stop();
    };
  }, [refreshDevices, setRoomNotice]);

  const applyTrackSettings = useCallback(
    async (deviceId: string, nextMusicMode: boolean) => {
      if (!trackRef.current) {
        return;
      }

      await trackRef.current.restartTrack(buildAudioCaptureOptions(deviceId, nextMusicMode));
    },
    [],
  );

  const broadcastStatus = useCallback(
    async (status: "live" | "paused") => {
      await publishEvent(
        {
          type: "status",
          id: crypto.randomUUID(),
          sentAt: Date.now(),
          status,
        },
        true,
      );
    },
    [publishEvent],
  );

  const republishTrackWithQuality = useCallback(
    async (quality: AudioQualityValue) => {
      if (!trackRef.current) {
        return;
      }

      await room.localParticipant.unpublishTrack(trackRef.current, false);
      await room.localParticipant.publishTrack(trackRef.current, {
        audioPreset: getAudioQualityOption(quality).preset,
      });
    },
    [room.localParticipant],
  );

  const syncBroadcastState = useCallback(
    async (status: RoomBroadcastState["status"], liveStartedAt: number | null) => {
      const response = await fetch("/api/broadcast-state", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          passcode: hostPasscode,
          status,
          liveStartedAt,
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        state?: RoomBroadcastState;
      };

      if (!response.ok || !payload.state) {
        throw new Error(payload.error || "Unable to update live timer.");
      }

      setBroadcastState(payload.state);
    },
    [hostPasscode, setBroadcastState],
  );

  const handleToggleLive = useCallback(async () => {
    setHostBusy(true);
    setRoomNotice(null);

    try {
      const deviceId = selectedDeviceId || devices[0]?.deviceId || "";
      if (!trackRef.current) {
        trackRef.current = await createLocalAudioTrack(buildAudioCaptureOptions(deviceId, musicMode));
      }

      if (isLive) {
        await room.localParticipant.unpublishTrack(trackRef.current, false);
        setIsLive(false);
        await broadcastStatus("paused");
        await syncBroadcastState("paused", null);
      } else {
        const startedAt = Date.now();
        await applyTrackSettings(deviceId, musicMode);
        await room.localParticipant.publishTrack(trackRef.current, {
          audioPreset: selectedQualityOption.preset,
        });
        setIsLive(true);
        await broadcastStatus("live");
        await syncBroadcastState("live", startedAt);
      }
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "Broadcast update failed.");
    } finally {
      setHostBusy(false);
    }
  }, [
    applyTrackSettings,
    broadcastStatus,
    devices,
    isLive,
    musicMode,
    room.localParticipant,
    selectedQualityOption,
    selectedDeviceId,
    setRoomNotice,
    syncBroadcastState,
  ]);

  const handleSelectDevice = useCallback(
    async (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      if (!isLive || !trackRef.current) {
        return;
      }

      setHostBusy(true);
      try {
        await applyTrackSettings(deviceId, musicMode);
      } catch (error) {
        setRoomNotice(error instanceof Error ? error.message : "Could not switch input.");
      } finally {
        setHostBusy(false);
      }
    },
    [applyTrackSettings, isLive, musicMode, setRoomNotice],
  );

  const handleToggleMusicMode = useCallback(async () => {
    const nextValue = !musicMode;
    setMusicMode(nextValue);
    if (!isLive || !trackRef.current) {
      return;
    }

    setHostBusy(true);
    try {
      await applyTrackSettings(selectedDeviceId, nextValue);
    } catch (error) {
      setRoomNotice(error instanceof Error ? error.message : "Could not update music mode.");
    } finally {
      setHostBusy(false);
    }
  }, [applyTrackSettings, isLive, musicMode, selectedDeviceId, setRoomNotice]);

  const handleSelectQuality = useCallback(
    async (quality: AudioQualityValue) => {
      setAudioQuality(quality);
      if (!isLive || !trackRef.current) {
        return;
      }

      setHostBusy(true);
      try {
        await republishTrackWithQuality(quality);
        setRoomNotice("Audio quality updated for the live broadcast.");
      } catch (error) {
        setRoomNotice(error instanceof Error ? error.message : "Could not update audio quality.");
      } finally {
        setHostBusy(false);
      }
    },
    [isLive, republishTrackWithQuality, setRoomNotice],
  );

  return (
    <section className="vox-host-panel">
      <div className="vox-host-panel__header">
        <div>
          <h3>Broadcast controls</h3>
          <p className="vox-helper">
            Music mode keeps worship music and mixer output sounding natural.
          </p>
        </div>
        <button
          className={isLive ? "vox-button-danger" : "vox-button"}
          disabled={hostBusy}
          type="button"
          onClick={() => void handleToggleLive()}
        >
          {hostBusy ? "Working..." : isLive ? "Pause broadcast" : "Go live"}
        </button>
      </div>

      <div className="vox-host-monitor">
        <div className="vox-host-monitor__item">
          <span className="vox-helper">Status</span>
          <strong className="vox-host-monitor__value">{isLive ? "Live now" : "Standing by"}</strong>
        </div>
        <div className="vox-host-monitor__item">
          <span className="vox-helper">Input</span>
          <strong className="vox-host-monitor__value" title={selectedInputName}>
            {selectedInputName}
          </strong>
        </div>
        <div className="vox-host-monitor__item">
          <span className="vox-helper">Quality</span>
          <strong className="vox-host-monitor__value">{selectedQualityOption.label}</strong>
        </div>
        <div className="vox-host-monitor__item">
          <span className="vox-helper">Music mode</span>
          <strong className="vox-host-monitor__value">{musicMode ? "On" : "Off"}</strong>
        </div>
        <div className="vox-host-monitor__item">
          <span className="vox-helper">Live timer</span>
          <strong className="vox-host-monitor__value">{liveElapsedLabel ?? "00:00"}</strong>
        </div>
      </div>

      <div className="vox-host-checklist">
        <div className="vox-host-checklist__header">
          <h4>Quick host check</h4>
          <span className="vox-helper">A calm 30-second setup pass before or during the programme.</span>
        </div>
        <ul className="vox-host-checklist__list">
          <li data-ready={devices.length > 0}>
            <span aria-hidden="true">{devices.length > 0 ? "✓" : "○"}</span>
            Mic connected and visible
          </li>
          <li data-ready={Boolean(selectedDeviceId)}>
            <span aria-hidden="true">{selectedDeviceId ? "✓" : "○"}</span>
            Correct input selected
          </li>
          <li data-ready={hasComments}>
            <span aria-hidden="true">{hasComments ? "✓" : "○"}</span>
            Test comment seen in room chat
          </li>
          <li data-ready={listenerCount > 0}>
            <span aria-hidden="true">{listenerCount > 0 ? "✓" : "○"}</span>
            A listener device is connected
          </li>
        </ul>
      </div>

      <div className="vox-host-panel__grid">
        <label className="vox-label" htmlFor="vox-audio-input">
          Audio input
          <select
            id="vox-audio-input"
            className="vox-select"
            value={selectedDeviceId}
            onChange={(event) => void handleSelectDevice(event.target.value)}
          >
            {devices.length === 0 ? (
              <option value="">No inputs found yet</option>
            ) : (
              devices.map((device, index) => (
                <option key={device.deviceId || `device-${index}`} value={device.deviceId}>
                  {device.label || `Input ${index + 1}`}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="vox-label" htmlFor="vox-audio-quality">
          Stream quality
          <select
            id="vox-audio-quality"
            className="vox-select"
            value={audioQuality}
            onChange={(event) => void handleSelectQuality(event.target.value as AudioQualityValue)}
          >
            {AUDIO_QUALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="vox-helper">{selectedQualityOption.helper}</span>
        </label>

        <label className="vox-toggle">
          <span>
            <strong>Music mode</strong>
            <small>On by default for mixer feeds, singing, and instruments.</small>
          </span>
          <button
            aria-pressed={musicMode}
            className="vox-toggle__switch"
            data-on={musicMode}
            type="button"
            onClick={() => void handleToggleMusicMode()}
          >
            <span />
          </button>
        </label>
      </div>

      <p className="vox-helper">
        Balanced quality is the default. Changing quality while live may cause a brief audio shift.
      </p>
      <p className="vox-helper">Only the host can remove disruptive listeners.</p>
    </section>
  );
}
