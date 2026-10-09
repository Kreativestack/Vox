"use client";

import { useEffect, useState } from "react";

import {
  LISTENER_NAME_STORAGE_KEY,
  MAX_DISPLAY_NAME_LENGTH,
  getProgrammeName,
  normalizeDisplayName,
} from "@/lib/livekit";
import { VoxRoomClient, type RoomSession } from "@/components/vox-room";
import { VoxWordmark } from "@/components/vox-wordmark";

export function ListenerApp() {
  const programmeName = getProgrammeName();
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<RoomSession | null>(null);

  useEffect(() => {
    const savedName = window.localStorage.getItem(LISTENER_NAME_STORAGE_KEY);
    if (savedName) {
      setDisplayName(savedName);
    }
  }, []);

  const handleJoin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = normalizeDisplayName(displayName);
    if (!name) {
      setError("Please enter your display name.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          role: "listener",
          displayName: name,
        }),
      });

      const payload = (await response.json()) as RoomSession & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Unable to join right now.");
      }

      window.localStorage.setItem(LISTENER_NAME_STORAGE_KEY, name);
      setDisplayName(name);
      setSession(payload);
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : "Unable to join right now.");
    } finally {
      setBusy(false);
    }
  };

  if (session) {
    return <VoxRoomClient mode="listener" session={session} onLeave={() => setSession(null)} />;
  }

  return (
    <main className="vox-shell vox-landing">
      <div className="vox-page">
        <section className="vox-card vox-join">
          <div className="vox-grid">
            <VoxWordmark />
            <div className="vox-join__copy">
              <p className="vox-topbar__eyebrow">{programmeName}</p>
              <h1>Welcome to Vox</h1>
              <p>
                Join the room to listen live, send comments, and react in real time with the
                programme.
              </p>
            </div>

            <form className="vox-grid" onSubmit={handleJoin}>
              <label className="vox-label" htmlFor="display-name">
                Display name
                <input
                  id="display-name"
                  className="vox-field"
                  maxLength={MAX_DISPLAY_NAME_LENGTH}
                  placeholder="Your name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>

              <p className="vox-helper">
                No login needed. Your name is remembered on this device for next time.
              </p>

              {error && (
                <div className="vox-banner" role="alert">
                  {error}
                </div>
              )}

              <button className="vox-button" disabled={busy || !displayName.trim()} type="submit">
                {busy ? "Joining..." : "Join and listen"}
              </button>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
