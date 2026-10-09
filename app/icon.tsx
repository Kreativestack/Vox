import { ImageResponse } from "next/og";

export const size = {
  width: 64,
  height: 64,
};

export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #ff8547 0%, #ff4d6d 45%, #7c3aed 100%)",
          color: "white",
          fontSize: 30,
          fontWeight: 800,
          letterSpacing: "-0.08em",
        }}
      >
        Vox
      </div>
    ),
    size,
  );
}
