import type { MetadataRoute } from "next";

// Next 16 metadata route: served at /manifest.webmanifest and linked from
// <head> automatically. Colors match --bg dark (#0a0a0a) so the standalone
// splash / OS chrome stay seamless with the app's dark theme.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "career-ops — official web experience",
    short_name: "career-ops",
    description: "The official, local-first web experience for career-ops.",
    display: "standalone",
    start_url: "/",
    theme_color: "#0a0a0a",
    background_color: "#0a0a0a",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
