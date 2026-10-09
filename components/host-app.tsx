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

export function HostApp() {
  const programmeName = getProgrammeName();
  const [displayName, setDisplayName] = useState("");
  const [passcode, setPasscode] = useState("");
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

    if (!passcode.trim()) {
      setError("Please enter the host passcode.");
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
          role: "host",
          displayName: name,
          passcode,
        }),
      });

      const payload = (await response.json()) as RoomSession & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Unable to enter the host console.");
      }

      window.localStorage.setItem(LISTENER_NAME_STORAGE_KEY, name);
      setDisplayName(name);
      setSession(payload);
    } catch (joinError) {
      setError(
        joinError instanceof Error ? joinError.message : "Unable to enter the host console.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (session) {
    return (
      <VoxRoomClient
        hostPasscode={passcode}
        mode="host"
        session={session}
        onLeave={() => setSession(null)}
      />
    );
  }

  return (
    <main className="vox-shell vox-landing">
      <div className="vox-page">
        <section className="vox-card vox-join">
          <div className="vox-grid">
            <VoxWordmark />
            <div className="vox-join__copy">
              <p className="vox-topbar__eyebrow">{programmeName}</p>
              <h1>Host on Vox</h1>
              <p>Enter the passcode, choose your name, and get the broadcast ready for Saturday.</p>
            </div>

            <form className="vox-grid" onSubmit={handleJoin}>
              <label className="vox-label" htmlFor="host-name">
                Display name
                <input
                  id="host-name"
                  className="vox-field"
                  maxLength={MAX_DISPLAY_NAME_LENGTH}
                  placeholder="Host name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>

              <label className="vox-label" htmlFor="host-passcode">
                Host passcode
                <input
                  id="host-passcode"
                  className="vox-field"
                  placeholder="Passcode"
                  type="password"
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value)}
                />
              </label>

              {error && (
                <div className="vox-banner" role="alert">
                  {error}
                </div>
              )}

              <button
                className="vox-button"
                disabled={busy || !displayName.trim() || !passcode.trim()}
                type="submit"
              >
                {busy ? "Entering..." : "Enter host console"}
              </button>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
