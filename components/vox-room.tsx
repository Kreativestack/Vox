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
  Participant,
  Room,
  RoomEvent,
} from "livekit-client";
import dynamic from "next/dynamic";
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

const HostStudioControls = dynamic(
  () => import("@/components/host-studio-controls").then((module) => module.HostStudioControls),
  { ssr: false },
);

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

function appendUniqueMessage(list: ChatMessage[], message: ChatMessage) {
  if (list.some((item) => item.id === message.id)) {
    return list;
  }

  return [...list, message].slice(-200);
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
              <HostStudioControls
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
